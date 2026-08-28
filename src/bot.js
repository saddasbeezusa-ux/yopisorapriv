import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  ActivityType,
  AttachmentBuilder,
  Options,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { createReadStream } from 'node:fs';
import { unlink, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  FluxClient,
  FluxError,
  FLUX_DURATIONS,
  FLUX_DEFAULT_DURATION,
  FLUX_RATIOS,
  FLUX_DEFAULT_RATIO,
} from './flux.js';
import {
  SeedanceClient,
  Sd2Error,
  SD2_MODEL,
  SD2_DEFAULT_DURATION,
  SD2_DEFAULT_RESOLUTION,
  SD2_DEFAULT_RATIO,
  SD2_MAX_IMAGES,
  SD2_MAX_VIDEOS,
  SD25_MODEL,
  SD25_DEFAULT_DURATION,
  SD25_DEFAULT_RESOLUTION,
  SD25_DEFAULT_RATIO,
  SD25_MAX_IMAGES,
  SD25_MAX_VIDEOS,
} from './sd2.js';
import { ArkClient, ArkError, ARK_MODEL } from './ark.js';
import { analyzeVideo, trimVideo, ensureMinDuration, AutoBypassError } from './autobypass.js';
import {
  WanClient,
  WanError,
  WAN_DEFAULT_DURATION,
  WAN_DEFAULT_RATIO,
  WAN_DEFAULT_RESOLUTION,
  WAN_MAX_IMAGES,
} from './wan.js';
import { createSlotManager } from './slots.js';
import { createJobStore } from './jobstore.js';
import { uploadToCatbox } from './catbox.js';

const {
  DISCORD_TOKEN,
  DISCORD_GUILD_ID,
  ARK_API_KEY,
  GEN_POLL_INTERVAL_MS = '15000',
  GEN_VIDEO_TIMEOUT_MS = '1200000',
  GEN_MAX_CONCURRENT_PER_USER = '3',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing. Fill it in .env');
  process.exit(1);
}
if (!DISCORD_GUILD_ID) {
  console.error('DISCORD_GUILD_ID is missing. The bot is restricted to a single server.');
  process.exit(1);
}
if (!ARK_API_KEY) {
  console.error('ARK_API_KEY is missing. Fill it in .env (required for /autobypass).');
  process.exit(1);
}

const flux = new FluxClient();
const sd2 = new SeedanceClient({ model: SD2_MODEL });
const sd25 = new SeedanceClient({ model: SD25_MODEL });
const wan = new WanClient();
const ark = new ArkClient({ model: ARK_MODEL });
const jobStore = createJobStore({ dir: process.env.GEN_JOB_STORE_DIR || './.jobs' });

const safeUnlink = (p) => (p ? unlink(p).catch(() => {}) : Promise.resolve());

// Terminal-outcome tombstone: written the instant a job's user-facing outcome
// lands (video sent, over-limit notice, or error shown). If the process dies
// between that moment and the job-store cleanup, boot-resume sees the flag and
// drops the record instead of delivering a second copy of the video.
const markJobDelivered = (jobId, kind = 'wan') =>
  jobStore.save({ jobId, kind, delivered: true, deliveredAt: Date.now() }).catch(() => {});

// Over the server upload limit: host the video on catbox.moe and reply with a
// bare embeddable link (x266 wraps the catbox URL so Discord plays it inline).
// Returns true when the link was sent; false when the upload failed (the
// caller then falls back to the plain over-limit notice).
async function deliverOverLimitReply(replyToAnchor, { mention, file, limit }) {
  try {
    const link = await uploadToCatbox(file.path, { filename: 'video.mp4' });
    await replyToAnchor({ content: `https://x266.mov/e/${link}` });
    console.log(`[catbox] over-limit video hosted: ${link}`);
    return true;
  } catch (err) {
    console.error(`[catbox] upload failed: ${err?.message ?? err}`);
    return false;
  }
}

const POLL_MS = Number(GEN_POLL_INTERVAL_MS);
const VIDEO_TIMEOUT = Number(GEN_VIDEO_TIMEOUT_MS);
const MAX_PER_USER = Number(GEN_MAX_CONCURRENT_PER_USER);

const UPLOAD_LIMIT_BY_TIER = { 0: 10, 1: 25, 2: 50, 3: 100 };
const uploadLimitBytes = (guild) => {
  const explicit = guild?.maximumUploadLimit;
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const tier = Number(guild?.premiumTier ?? 0);
  return (UPLOAD_LIMIT_BY_TIER[tier] ?? 10) * 1024 * 1024;
};

const slots = createSlotManager({
  maxPerUser: MAX_PER_USER,
  maxJobAgeMs: VIDEO_TIMEOUT + 60_000,
});
// User IDs exempt from the per-user concurrency cap (comma-separated in .env,
// plus a hardcoded default).
const UNLIMITED_USER_IDS = new Set(
  ['1242996784301740032', ...String(process.env.GEN_UNLIMITED_USER_IDS || '').split(',')]
    .map((s) => s.trim())
    .filter(Boolean),
);
const isUnlimited = (userId) => UNLIMITED_USER_IDS.has(String(userId));

// User who gets the multi-generation flow on /sd2 (modal â†’ fire N gens).
const SD2_MULTI_USER_ID = '1242996784301740032';
const isSd2MultiUser = (userId) => String(userId) === SD2_MULTI_USER_ID;

const takeSlot = (userId) => slots.take(userId, isUnlimited(userId));
const releaseSlot = (userId, jobId) => slots.release(userId, jobId);
const runningCount = (userId) => slots.running(userId);

const COLOR_WORKING = 0x5865f2;
const COLOR_DONE = 0x57f287;
const COLOR_BLOCKED = 0xfee75c;
const COLOR_ERROR = 0xed4245;

const fmtElapsed = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const truncate = (s, n = 1000) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}\u2026` : str;
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const isImageAttachment = (a) =>
  Boolean(a) && (a.contentType?.startsWith('image/') || IMAGE_EXT.test(a.name ?? ''));

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const isVideoAttachment = (a) =>
  Boolean(a) && (a.contentType?.startsWith('video/') || VIDEO_EXT.test(a.name ?? ''));

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * MB;
const MAX_VIDEO_BYTES = 100 * MB;
const fmtMB = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  // Bounded caches so a long-running bot on a small host doesn't slowly OOM.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 15,
    UserManager: { maxSize: 40, keepOverLimit: (user) => user.id === client.user?.id },
    GuildMemberManager: { maxSize: 40, keepOverLimit: (member) => member.id === client.user?.id },
    PresenceManager: 0,
    ThreadManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 600 },
    users: { interval: 3600, filter: () => (user) => user.id !== client.user?.id },
  },
});

client.once('clientReady', async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Server: ${DISCORD_GUILD_ID} (locked)`);
  console.log(`Limit:  ${MAX_PER_USER} concurrent per user (cleared on restart)`);
  c.user.setActivity('/flux-3 â€¢ /sd2', { type: ActivityType.Listening });
  resumePendingJobs().catch((err) => console.error('Resume sweep failed:', err));
});

// Periodic memory trace — makes a slow leak visible in Railway logs before the
// cgroup OOM-kill strikes, instead of only seeing "Killed" with no context.
const MEM_MB = 1024 * 1024;
setInterval(() => {
  const m = process.memoryUsage();
  console.log(`[mem] rss ${(m.rss / MEM_MB).toFixed(0)} MB | heap ${(m.heapUsed / MEM_MB).toFixed(0)}/${(m.heapTotal / MEM_MB).toFixed(0)} MB | external ${(m.external / MEM_MB).toFixed(0)} MB`);
}, 5 * 60_000).unref();

// â”€â”€â”€ Shared helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeAnchorFns({ interaction = null, channel = null, hidePrompt = false } = {}) {
  let anchor = null;

  const resolveChannel = async () => {
    if (channel) return channel;
    if (interaction) return interaction.channel ?? (await client.channels.fetch(interaction.channelId).catch(() => null));
    return null;
  };

  // hidePrompt: the prompt never appears in any message. Cards get their
  // description stripped on the way out — including error cards and anything
  // sent as a raw reply body.
  const stripPrompt = (embed) => {
    if (!hidePrompt || !embed) return embed;
    try { return embed.setDescription(null); } catch { return embed; }
  };

  const finalise = async (embed) => {
    embed = stripPrompt(embed);
    if (anchor) {
      try { await anchor.edit({ embeds: [embed] }); return; }
      catch (err) { console.warn(`anchor.edit failed: ${err.message}`); }
      return;
    }
    if (interaction) {
      try { await interaction.editReply({ embeds: [embed] }); }
      catch (err) { console.warn(`editReply failed: ${err.message}`); }
    }
  };

  const setAnchor = (msg) => { anchor = msg; };

  const alreadyDelivered = async () => {
    if (!anchor) return false;
    const ch = await resolveChannel();
    if (!ch?.messages?.fetch) return false;
    try {
      const msgs = await ch.messages.fetch({ limit: 10 });
      return msgs.some((m) =>
        m.author?.id === client.user?.id
        && m.reference?.messageId === anchor.id
        && (m.attachments?.size ?? 0) > 0);
    } catch { return false; }
  };

  const replyToAnchor = async (body) => {
    const hasFiles = Boolean(body?.files?.length);
    if (hidePrompt && body?.embeds?.length) {
      body = { ...body, embeds: body.embeds.map((e) => stripPrompt(e)) };
    }
    try { if (anchor) { await anchor.reply(body); return; } }
    catch (err) {
      console.warn(`Could not reply to anchor: ${err.message}`);
      if (hasFiles && await alreadyDelivered()) {
        console.log('Delivery already landed despite the error — not sending again.');
        return;
      }
    }
    try {
      const ch = await resolveChannel();
      if (hasFiles && await alreadyDelivered()) return;
      await ch?.send(body);
    } catch (err) { console.error(`Could not deliver result: ${err.message}`); }
  };

  // Creates the anchor message that the whole flow edits. Normal path: defer +
  // editReply (the bot's own reply). hidePrompt: clean ephemeral "Created task!"
  // ack on the interaction, and the working card goes out as a separate public
  // message that becomes the anchor.
  const createAnchor = async (embed) => {
    embed = stripPrompt(embed);
    if (hidePrompt && interaction) {
      try {
        await interaction.reply({ content: 'Created task!', flags: MessageFlags.Ephemeral });
      } catch (err) {
        console.warn(`ephemeral ack failed: ${err.message}`);
        try { await interaction.deferReply(); } catch { /* already handled */ }
      }
      const ch = await resolveChannel();
      const msg = await ch.send({ embeds: [embed] });
      anchor = msg;
      return msg;
    }
    if (interaction) {
      if (!interaction.deferred && !interaction.replied) {
        try { await interaction.deferReply(); } catch { /* fall through to edit */ }
      }
      const msg = await interaction.editReply({ embeds: [embed] });
      anchor = msg;
      return msg;
    }
    const ch = await resolveChannel();
    const msg = await ch.send({ embeds: [embed] });
    anchor = msg;
    return msg;
  };

  return { finalise, replyToAnchor, setAnchor, createAnchor };
}

// Collect reference attachments and return their public URLs. The provider fetches
// directly (input.media), so there is no upload step.
function collectReferences(interaction, imageNames, maxImages, videoNames, maxVideos) {
  const imageAtts = imageNames.map((n) => interaction.options.getAttachment(n)).filter(Boolean);
  const videoAtts = videoNames.map((n) => interaction.options.getAttachment(n)).filter(Boolean);

  const badImage = imageAtts.find((a) => !isImageAttachment(a));
  if (badImage) {
    return { error: `\`${badImage.name}\` doesn't look like an image. Upload a PNG, JPG or WEBP.` };
  }
  const badVideo = videoAtts.find((a) => !isVideoAttachment(a));
  if (badVideo) {
    return { error: `\`${badVideo.name}\` doesn't look like a video. Upload an MP4 or MOV.` };
  }
  const oversizedImage = imageAtts.find((a) => a.size > MAX_IMAGE_BYTES);
  if (oversizedImage) {
    return { error: `\`${oversizedImage.name}\` is ${fmtMB(oversizedImage.size)} \u2014 images must be under ${fmtMB(MAX_IMAGE_BYTES)}.` };
  }
  const oversizedVideo = videoAtts.find((a) => a.size > MAX_VIDEO_BYTES);
  if (oversizedVideo) {
    return { error: `\`${oversizedVideo.name}\` is ${fmtMB(oversizedVideo.size)} \u2014 videos must be under ${fmtMB(MAX_VIDEO_BYTES)}.` };
  }

  const images = imageAtts.slice(0, maxImages);
  const videos = videoAtts.slice(0, maxVideos);
  const references = [
    ...images.map((a) => ({ type: 'image', url: a.url })),
    ...videos.map((a) => ({ type: 'video', url: a.url })),
  ];
  return { images, videos, references, error: null };
}

async function handleGenerationError(err, { finalise, replyToAnchor, prompt, user, idRef, commandName = 'Generation', idLabel = 'ID' }) {
  const idVal = idRef?.value;

  // Timeout gets its own clean message (works for Sd2Error and FluxError).
  if (err?.timedOut) {
    const minutes = Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000));
    const card = new EmbedBuilder()
      .setColor(COLOR_BLOCKED)
      .setAuthor({ name: commandName })
      .setTitle('Your video timed out')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'What happened', value: `The generation ran for the full ${minutes} minutes without finishing. Try generating it again.` });
    if (idVal) card.addFields({ name: idLabel, value: `\`\`\`${idVal}\`\`\`` });
    card.setFooter({ text: `Requested by ${user.username} \u2022 timed out`, iconURL: user.displayAvatarURL?.() }).setTimestamp();

    await finalise(
      new EmbedBuilder()
        .setColor(COLOR_BLOCKED)
        .setAuthor({ name: commandName })
        .setTitle('Your video timed out')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
        .setTimestamp(),
    );
    await replyToAnchor({ content: `${user} Your video has timed out \u2014 it has taken ${minutes} minutes. Try regenerating again.`, embeds: [card] });
    console.log(`${idVal ?? 'no-task'} timed out after ${minutes} minutes`);
    return;
  }

  const blocked = Boolean(err?.blocked);
  const message = err?.message || 'An unexpected error occurred.';
  if (!blocked) console.error(err);

  const failed = new EmbedBuilder()
    .setColor(blocked ? COLOR_BLOCKED : COLOR_ERROR)
    .setAuthor({ name: commandName })
    .setTitle(blocked ? 'Prompt blocked' : 'Generation failed')
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({ name: blocked ? 'Reason' : 'What happened', value: truncate(message, 1000) });
  if (idVal) failed.addFields({ name: idLabel, value: `\`\`\`${idVal}\`\`\`` });
  failed
    .setFooter({ text: blocked ? `Requested by ${user.username} \u2022 try rephrasing` : `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
    .setTimestamp();

  await finalise(
    new EmbedBuilder()
      .setColor(blocked ? COLOR_BLOCKED : COLOR_ERROR)
      .setAuthor({ name: commandName })
      .setTitle(blocked ? 'Prompt blocked' : 'Generation failed')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
      .setTimestamp(),
  );
  await replyToAnchor({ content: `${user}`, embeds: [failed] });
  console.log(`${idVal ?? 'no-task'} ${blocked ? 'blocked' : 'failed'}: ${message}`);
}

// Pending /sd2 multi-fire payloads, keyed by user id. Dropped after the modal
// is submitted or after SD2_MULTI_PENDING_TTL_MS so a dismissed modal can't
// leak attachment URLs forever.
const SD2_MULTI_PENDING_TTL_MS = 10 * 60_000;
const SD2_MULTI_MAX = 100;
const SD2_MULTI_SUBMIT_CONCURRENCY = 5;
const SD2_MULTI_DELIVER_CONCURRENCY = 3;
const pendingSd2Multi = new Map();

async function runPool(count, limit, worker) {
  let next = 0;
  const n = Math.max(0, count);
  const width = Math.min(Math.max(1, limit), Math.max(1, n));
  await Promise.all(Array.from({ length: n === 0 ? 0 : width }, async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      await worker(i);
    }
  }));
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isModalSubmit() && interaction.customId === 'sd2-multi-count') {
    return handleSd2MultiModal(interaction);
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'flux-3') return runFluxGeneration(interaction);
  if (interaction.commandName === 'sd2') return runSd2Generation(interaction);
  if (interaction.commandName === 'sd2-5') return runSd25Generation(interaction);
  if (interaction.commandName === 'wan-3') return runWanGeneration(interaction);
  if (interaction.commandName === 'autobypass') return runAutoBypass(interaction);
});

// â”€â”€â”€ /sd2 multi-fire (user 1242996784301740032 only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Modal asks how many to fire. Same prompt + references go on every request.
// Submit is pooled so 100 gens don't open 100 sockets at once.

async function promptSd2Multi(interaction) {
  const prompt = interaction.options.getString('prompt', true);
  const duration = interaction.options.getInteger('duration') ?? SD2_DEFAULT_DURATION;
  const resolution = interaction.options.getString('resolution') ?? SD2_DEFAULT_RESOLUTION;
  const ratio = interaction.options.getString('ratio') ?? SD2_DEFAULT_RATIO;

  const { images: imgAtts, videos: vidAtts, error: refError } = collectReferences(
    interaction, ['img1', 'img2', 'img3'], SD2_MAX_IMAGES, ['vid1'], SD2_MAX_VIDEOS,
  );
  if (refError) {
    await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
    return;
  }

  pendingSd2Multi.set(interaction.user.id, {
    prompt,
    duration,
    resolution,
    ratio,
    hidePrompt: Boolean(interaction.options.getBoolean('hideprompt')),
    refImages: imgAtts ?? [],
    refVideos: vidAtts ?? [],
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    expiresAt: Date.now() + SD2_MULTI_PENDING_TTL_MS,
  });

  const modal = new ModalBuilder()
    .setCustomId('sd2-multi-count')
    .setTitle('Seedance 2.0')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('count')
          .setLabel('How many generations do you want to fire?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(3)
          .setPlaceholder(`1â€“${SD2_MULTI_MAX}`),
      ),
    );

  await interaction.showModal(modal);
}

async function handleSd2MultiModal(interaction) {
  const user = interaction.user;
  if (!isSd2MultiUser(user.id)) {
    await interaction.reply({ content: 'This flow is not available for your account.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const pending = pendingSd2Multi.get(user.id);
  pendingSd2Multi.delete(user.id);
  if (!pending || pending.expiresAt < Date.now()) {
    await interaction.reply({ content: 'That request expired â€” run /sd2 again.', flags: MessageFlags.Ephemeral });
    return;
  }

  const raw = (interaction.fields.getTextInputValue('count') || '').trim();
  const count = Number.parseInt(raw, 10);
  if (!Number.isInteger(count) || count < 1 || count > SD2_MULTI_MAX) {
    await interaction.reply({
      content: `Need a whole number between 1 and ${SD2_MULTI_MAX}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const commandName = 'Seedance 2.0';
  const { prompt, duration, resolution, ratio, refImages, refVideos, hidePrompt } = pending;
  const refCount = (refImages?.length ?? 0) + (refVideos?.length ?? 0);
  const sd2Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');

  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });

  const firing = new EmbedBuilder()
    .setColor(COLOR_WORKING)
    .setAuthor({ name: commandName })
    .setTitle(`Firing ${count} generation${count === 1 ? '' : 's'}`)
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
    .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
    .setTimestamp();
  if (refCount) {
    const refSummary = [
      refImages.length ? `${refImages.length} image${refImages.length > 1 ? 's' : ''}` : null,
      refVideos.length ? `${refVideos.length} video${refVideos.length > 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(', ');
    firing.addFields({ name: 'References', value: refSummary });
    if (refImages.length) firing.setThumbnail(refImages[0].url);
  }

  const anchor = await createAnchor(firing);

  const submitted = [];
  const submitErrors = [];

  await runPool(count, SD2_MULTI_SUBMIT_CONCURRENCY, async (i) => {
    try {
      const { taskId } = await sd2.createTask({
        prompt, duration, resolution, ratio,
        images: refImages ?? [], videos: refVideos ?? [],
      });
      const jobId = takeSlot(user.id);
      submitted.push({ i, taskId, jobId });
      if (jobId) {
        try {
          await jobStore.save({
            jobId, kind: 'sd2', userId: user.id, guildId: interaction.guildId,
            channelId: interaction.channelId, anchorMessageId: anchor.id,
            prompt, duration, ratio, resolution,
            refImages: refImages?.length ?? 0, refVideos: refVideos?.length ?? 0, hide: hidePrompt, taskId,
            deadlineAt: Date.now() + VIDEO_TIMEOUT, createdAt: Date.now(),
          });
        } catch (err) {
          console.warn(`Could not persist sd2 multi job ${jobId}: ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      submitErrors.push({ i, err });
      console.error(`[sd2-multi] submit ${i + 1}/${count} failed: ${err?.message ?? err}`);
    }
  });

  const live = new EmbedBuilder()
    .setColor(COLOR_WORKING)
    .setAuthor({ name: commandName })
    .setTitle(submitted.length ? 'All of them are generating!' : 'Could not start generations')
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({
      name: 'Status',
      value: submitted.length
        ? `Submitted ${submitted.length} of ${count}. Waiting on the renders.`
        : 'Every submit failed \u2014 nothing is running.',
    })
    .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
    .setTimestamp();
  if (refCount && refImages.length) live.setThumbnail(refImages[0].url);
  await finalise(live);

  if (!submitted.length) {
    const first = submitErrors[0]?.err;
    await handleGenerationError(first ?? new Error('Could not start any generations.'), {
      finalise, replyToAnchor, prompt, user, idRef: { value: null }, commandName, idLabel: 'Task ID',
    });
    return;
  }

  // Each render is independent â€” one failure must not cancel the rest.
  await runPool(submitted.length, SD2_MULTI_DELIVER_CONCURRENCY, async (idx) => {
    const item = submitted[idx];
    const idRef = { value: item.taskId };
    const startedAt = Date.now();
    try {
      const { videoUrl } = await sd2.waitForTask(item.taskId, {
        intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {},
      });
      const file = await sd2.downloadFile(videoUrl);
      try {
        const limit = uploadLimitBytes(interaction.guild);
        const mb = (file.bytes / MB).toFixed(1);
        if (file.bytes >= limit) {
          const sent = await deliverOverLimitReply(replyToAnchor, { mention: `${user} ${idx + 1}/${submitted.length}`, file, limit });
          if (!sent) {
            await replyToAnchor({
              content: `${user} ${idx + 1}/${submitted.length} rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.`,
            });
          }
          if (item.jobId) await markJobDelivered(item.jobId, 'sd2');
        } else {
          await replyToAnchor({
            content: `${user} ${idx + 1}/${submitted.length}`,
            files: [new AttachmentBuilder(createReadStream(file.path), { name: `seedance2-${idx + 1}.mp4` })],
          });
          if (item.jobId) await markJobDelivered(item.jobId, 'sd2');
        }
        console.log(`${item.taskId} (sd2-multi ${idx + 1}/${submitted.length}) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB)`);
      } finally {
        await safeUnlink(file.path);
      }
    } catch (err) {
      try {
        await handleGenerationError(err, {
          finalise: async () => {},
          replyToAnchor, prompt, user, idRef, commandName, idLabel: 'Task ID',
        });
      } catch (fatal) {
        console.error(`[sd2-multi] deliver ${idx + 1} failed:`, fatal);
      }
    } finally {
      if (item.jobId) {
        releaseSlot(user.id, item.jobId);
        await jobStore.remove(item.jobId);
      }
    }
  });

  const doneTitle = submitErrors.length
    ? `Fired ${submitted.length} of ${count}`
    : `Fired ${submitted.length} generation${submitted.length === 1 ? '' : 's'}`;
  await finalise(new EmbedBuilder()
    .setColor(submitErrors.length ? COLOR_BLOCKED : COLOR_DONE)
    .setAuthor({ name: commandName })
    .setTitle(doneTitle)
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
    .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
    .setTimestamp());
}
// â”€â”€â”€ /autobypass (Volcengine ARK, doubao Seedance 2.5) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fires 4 renders of the prompt template with the intro clip as the reference
// video, trims the intro off every render, and delivers each as an
// embeddable link.

const AB_ROOT_DIR = dirname(fileURLToPath(import.meta.url)) + '/..';
const AB_INTRO_PATH = process.env.AUTOBYPASS_INTRO_PATH || join(AB_ROOT_DIR, 'videointro.mov');
const AB_COUNT = 4;
const AB_MAX_IMAGES = 3;
const AB_SUBMIT_CONCURRENCY = 5;
const AB_DELIVER_CONCURRENCY = 5;
const AB_DURATION = 30;
const AB_RESOLUTION = '480p';
const AB_RATIO = '16:9';
const AB_PROMPT_TEMPLATE = (userPrompt) =>
  `a X mask hovering in a white void for 0.2 seconds, then at the 0.3 second mark then the video instantly cuts to ${userPrompt} [refrence Video 1 for how long X mask stays on screen when video turns black that's when cut starts]`;
const abModelLabel = (modelId) => (String(modelId).includes('2-5') ? 'Seedance 2.5' : 'Seedance 2');
const abSettingsLine = (duration, count, modelLabel, extra = []) =>
  [`\`${duration}s\``, `\`${AB_RATIO}\``, `\`${count} render${count === 1 ? '' : 's'}\``, `\`${modelLabel}\``, ...extra].join(' \u2022 ');

// The intro clip padded to the provider's r2v minimum (1.8s). Per session it is
// posted once to the staging channel (AUTOBYPASS_LOGS_CHANNEL_ID from .env) and
// the resulting Discord attachment URL rides into ARK as the reference video —
// no separate upload step.
const AB_LOGS_CHANNEL_ID = process.env.AUTOBYPASS_LOGS_CHANNEL_ID || '';
let abRefVideoUrl = process.env.AUTOBYPASS_REF_VIDEO_URL || null;
let abRefUploadPromise = null;
async function ensureRefVideoUrl() {
  if (abRefVideoUrl) return abRefVideoUrl;
  if (!abRefUploadPromise) {
    abRefUploadPromise = (async () => {
      const padded = await ensureMinDuration(AB_INTRO_PATH, 1.8);
      try {
        if (!AB_LOGS_CHANNEL_ID) throw new AutoBypassError('AUTOBYPASS_LOGS_CHANNEL_ID is not set.');
        const ch = await client.channels.fetch(AB_LOGS_CHANNEL_ID);
        if (!ch?.send) throw new AutoBypassError('The reference clip could not be staged (channel missing).');
        const msg = await ch.send({
          files: [new AttachmentBuilder(createReadStream(padded), { name: 'videointro.mov' })],
        });
        const att = msg.attachments.first();
        if (!att) throw new AutoBypassError('Could not upload the intro reference clip.');
        abRefVideoUrl = att.url;
        console.log(`[autobypass] intro clip staged in channel ${AB_LOGS_CHANNEL_ID}`);
        return abRefVideoUrl;
      } finally {
        if (padded !== AB_INTRO_PATH) await unlink(padded).catch(() => {});
      }
    })().catch((err) => { abRefUploadPromise = null; throw err; });
  }
  return abRefUploadPromise;
}

// Shared tail for /autobypass: judge every downloaded render, trim the intro
// off each one, upload to catbox and reply to the initial message with one
// embeddable link per clip. Used by both the fresh run and restart-resume.
async function finishAutoBypass({
  user, prompt, guild, successes, violations, failed, total, startedAt,
  duration = AB_DURATION, resolution = AB_RESOLUTION, modelLabel = 'Seedance 2.5',
  finalise, replyToAnchor, localFiles,
}) {
  const commandName = 'Auto Bypass';

  if (!successes.length) {
    if (violations >= total) {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_BLOCKED)
        .setAuthor({ name: commandName })
        .setTitle('All videos were content violation, try again')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Settings', value: abSettingsLine(duration, total, modelLabel, [`\`${resolution}\``]) })
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
        .setTimestamp());
    } else {
      await handleGenerationError(new Error('None of the renders finished.'), {
        finalise, replyToAnchor, prompt, user,
        idRef: { value: null }, commandName, idLabel: 'ID',
      });
    }
    return;
  }

  const judging = new EmbedBuilder()
    .setColor(COLOR_WORKING)
    .setAuthor({ name: commandName })
    .setTitle('Judging the renders')
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({
      name: 'Status',
      value: `${successes.length} of ${total} rendered. Detecting the scene cut with ffmpeg\u2026`,
    })
    .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
    .setTimestamp();
  await finalise(judging);

  // Detect the scene cut on every render and trim the intro off each one.
  const clips = [];
  for (const s of successes) {
    let sceneStart = null;
    let method = 'error';
    try {
      const res = await analyzeVideo(s.path);
      sceneStart = res.sceneStart;
      method = res.method;
    } catch (err) {
      console.error(`[autobypass] analyze render ${s.i + 1} failed: ${err?.message ?? err}`);
    }
    console.log(`[autobypass] render ${s.i + 1}: sceneStart=${sceneStart === null ? '??' : sceneStart.toFixed(3)} (${method})`);

    let deliverPath = s.path;
    let trimmedOk = false;
    if (sceneStart !== null) {
      try {
        const trimmedPath = await trimVideo(s.path, sceneStart);
        localFiles.push(trimmedPath);
        deliverPath = trimmedPath;
        trimmedOk = true;
      } catch (err) {
        console.error(`[autobypass] trim render ${s.i + 1} failed: ${err?.message ?? err} — delivering untrimmed`);
      }
    }
    const statRes = await stat(deliverPath).catch(() => null);
    clips.push({ i: s.i, path: deliverPath, bytes: statRes?.size ?? s.bytes, trimmedOk, sceneStart });
  }

  const limit = uploadLimitBytes(guild);
  const violationNote = violations ? `${violations} of ${total} renders were content violations.` : null;
  const failedNote = failed ? `${failed} of ${total} renders failed.` : null;

  // One embeddable link per clip, each replying to the initial message, in
  // render order.
  let delivered = 0;
  for (const c of clips.sort((a, b) => a.i - b.i)) {
    const mb = (c.bytes / MB).toFixed(1);
    try {
      const link = await uploadToCatbox(c.path, { filename: `autobypass-${c.i + 1}.mp4` });
      await replyToAnchor({ content: `${user} https://x266.mov/e/${link}` });
      delivered += 1;
      console.log(`[autobypass] clip ${c.i + 1}/${clips.length} hosted: ${link} (cut ${c.trimmedOk && c.sceneStart !== null ? c.sceneStart.toFixed(2) + 's' : 'none'})`);
      continue;
    } catch (err) {
      console.error(`[autobypass] clip ${c.i + 1} catbox upload failed: ${err?.message ?? err}`);
    }
    // catbox failed — attach the file if it fits the server limit.
    if (c.bytes < limit) {
      try {
        await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(c.path), { name: `autobypass-${c.i + 1}.mp4` })] });
        delivered += 1;
      } catch (err) {
        console.error(`[autobypass] clip ${c.i + 1} attach failed: ${err?.message ?? err}`);
      }
    } else {
      await replyToAnchor({ content: `Clip ${c.i + 1} rendered (${mb} MB) but could not be uploaded \u2014 sorry.` });
    }
  }

  const trimSummary = clips
    .map((c) => `#${c.i + 1}: ${c.trimmedOk ? `cut \`${c.sceneStart.toFixed(2)}s\`` : 'untrimmed'}`)
    .join(' \u2022 ');

  const done = new EmbedBuilder()
    .setColor(delivered ? COLOR_DONE : COLOR_ERROR)
    .setAuthor({ name: commandName })
    .setTitle(delivered ? 'Bypass complete' : 'Bypass failed')
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields(
      { name: 'Settings', value: abSettingsLine(duration, total, modelLabel, [`\`${resolution}\``, `\`${fmtElapsed(Date.now() - startedAt)}\``]) },
      { name: 'Delivered', value: `${delivered} of ${total} renders \u2014 links above` },
      { name: 'Trim', value: trimSummary || 'No clips to trim' },
    )
    .setFooter({
      text: [`Requested by ${user.username}`, violationNote, failedNote].filter(Boolean).join(' \u2022 '),
      iconURL: user.displayAvatarURL?.(),
    })
    .setTimestamp();
  await finalise(done);
  console.log(`[autobypass] delivered ${delivered}/${clips.length} clips in ${fmtElapsed(Date.now() - startedAt)}`);
}

async function runAutoBypass(interaction) {
  const commandName = 'Auto Bypass';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const startedAt = Date.now();
  const hidePrompt = Boolean(interaction.options.getBoolean('hideprompt'));
  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });
  const localFiles = [];
  const cleanup = async () => { for (const p of localFiles.splice(0)) await safeUnlink(p); };

  try {
    const userPrompt = interaction.options.getString('prompt', true);
    const modelId = ARK_MODEL;
    const abDuration = AB_DURATION;
    const abCount = AB_COUNT;
    const abResolution = interaction.options.getString('resolution') ?? AB_RESOLUTION;
    const modelLabel = abModelLabel(modelId);

    const { images: imgAtts, error: refError } = collectReferences(
      interaction, ['img1', 'img2', 'img3'], AB_MAX_IMAGES, [], 0,
    );
    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }
    const refCount = imgAtts?.length ?? 0;

    const firing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle(`Firing ${abCount} bypass renders`)
      .setDescription(`>>> ${truncate(userPrompt, 900)}`)
      .addFields({ name: 'Settings', value: abSettingsLine(abDuration, abCount, modelLabel, [`\`${abResolution}\``]) })
      .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      firing.addFields({ name: 'References', value: `${refCount} image${refCount > 1 ? 's' : ''}` });
      firing.setThumbnail(imgAtts[0].url);
    }
    const anchor = await createAnchor(firing);

    const refUrl = await ensureRefVideoUrl();
    const finalPrompt = AB_PROMPT_TEMPLATE(userPrompt);
    const references = [
      { type: 'video', url: refUrl },
      ...(imgAtts ?? []).map((a) => ({ type: 'image', url: a.url })),
    ];

    const submitted = [];
    let submitBlocked = 0;
    let submitFailed = 0;

    await runPool(abCount, AB_SUBMIT_CONCURRENCY, async (i) => {
      try {
        const { taskId } = await ark.createTask({
          prompt: finalPrompt,
          duration: abDuration,
          resolution: abResolution,
          ratio: AB_RATIO,
          references,
        });
        submitted.push({ i, taskId });
      } catch (err) {
        if (err?.blocked) submitBlocked += 1;
        else submitFailed += 1;
        console.error(`[autobypass] submit ${i + 1}/${abCount} failed: ${err?.message ?? err}`);
      }
    });

    if (!submitted.length) {
      if (submitBlocked >= abCount) {
        await finalise(new EmbedBuilder()
          .setColor(COLOR_BLOCKED)
          .setAuthor({ name: commandName })
          .setTitle('All videos were content violation, try again')
          .setDescription(`>>> ${truncate(userPrompt, 900)}`)
          .addFields({ name: 'Settings', value: abSettingsLine(abDuration, abCount, modelLabel, [`\`${abResolution}\``]) })
          .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
          .setTimestamp());
      } else {
        const firstErr = new Error('Could not start any renders.');
        await handleGenerationError(firstErr, {
          finalise, replyToAnchor, prompt: userPrompt, user,
          idRef: { value: null }, commandName, idLabel: 'ID',
        });
      }
      return;
    }

    // Persist before waiting so a restart / kill mid-batch resumes on next boot.
    try {
      await jobStore.save({
        jobId,
        kind: 'autobypass',
        userId: user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        anchorMessageId: anchor.id,
        prompt: userPrompt,
        taskIds: submitted.map((s) => s.taskId),
        submittedCount: submitted.length,
        count: abCount,
        duration: abDuration,
        model: modelId,
        resolution: abResolution,
        hide: hidePrompt,
        deadlineAt: Date.now() + VIDEO_TIMEOUT,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.warn(`Could not persist autobypass job ${jobId}: ${err?.message ?? err}`);
    }

    const live = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('All of them are generating!')
      .setDescription(`>>> ${truncate(userPrompt, 900)}`)
      .addFields({
        name: 'Status',
        value: `Submitted ${submitted.length} of ${abCount}. Waiting on the renders.`,
      })
      .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) live.setThumbnail(imgAtts[0].url);
    await finalise(live);

    const successes = [];
    let genViolations = submitBlocked;
    let genFailed = submitFailed;

    await runPool(submitted.length, AB_DELIVER_CONCURRENCY, async (idx) => {
      const item = submitted[idx];
      try {
        const { videoUrl } = await ark.waitForTask(item.taskId, {
          intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {},
        });
        const file = await ark.downloadFile(videoUrl);
        localFiles.push(file.path);
        successes.push({ i: item.i, path: file.path, bytes: file.bytes });
        console.log(`[autobypass] ${item.taskId} (${item.i + 1}/${submitted.length}) rendered (${(file.bytes / MB).toFixed(1)} MB)`);
      } catch (err) {
        if (err?.blocked) genViolations += 1;
        else genFailed += 1;
        console.error(`[autobypass] render ${item.i + 1}/${submitted.length} failed: ${err?.message ?? err}`);
      }
    });

    await finishAutoBypass({
      user, prompt: userPrompt, guild: interaction.guild,
      successes, violations: genViolations, failed: genFailed,
      total: submitted.length, startedAt,
      duration: abDuration, modelLabel,
      finalise, replyToAnchor, localFiles,
    });
  } catch (err) {
    if (!(err instanceof AutoBypassError)) console.error(err);
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor, prompt: interaction.options.getString('prompt') ?? '',
        user,
        idRef: { value: null }, commandName, idLabel: 'ID',
      });
      await markJobDelivered(jobId, 'autobypass');
    } catch (fatal) {
      console.error(`Unhandled error in ${commandName} for ${user.tag}:`, fatal);
      try {
        const body = { content: 'Something went wrong starting that generation.' };
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
      } catch { /* interaction unusable */ }
    }
  } finally {
    await cleanup();
    releaseSlot(user.id, jobId);
    await jobStore.remove(jobId);
  }
}

// Restart recovery for /autobypass: the batch was persisted right after the
// submits, so re-poll every render with the remaining budget, judge, deliver.
async function resumeAutoBypass(rec, { user, prompt, channel, finalise, replyToAnchor }) {
  const resumeRef = resumeUser(user, rec.userId);
  const localFiles = [];
  const cleanup = async () => { for (const p of localFiles.splice(0)) await safeUnlink(p); };
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new ArkError(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeRef, idRef: { value: null }, commandName: 'Auto Bypass', idLabel: 'ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'Auto Bypass' })
        .setTitle('Resuming your bypass run')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const taskIds = rec.taskIds ?? [];
    const successes = [];
    let violations = 0;
    let failed = 0;

    await runPool(taskIds.length, AB_DELIVER_CONCURRENCY, async (idx) => {
      const taskId = taskIds[idx];
      try {
        const { videoUrl } = await ark.waitForTask(taskId, {
          intervalMs: POLL_MS, timeoutMs: remaining, onUpdate: () => {},
        });
        const file = await ark.downloadFile(videoUrl);
        localFiles.push(file.path);
        successes.push({ i: idx, path: file.path, bytes: file.bytes });
        console.log(`[autobypass-resume] ${taskId} (${idx + 1}/${taskIds.length}) rendered`);
      } catch (err) {
        if (err?.blocked) violations += 1;
        else failed += 1;
        console.error(`[autobypass-resume] render ${idx + 1}/${taskIds.length} failed: ${err?.message ?? err}`);
      }
    });

    await finishAutoBypass({
      user: resumeRef, prompt, guild: channel.guild ?? null,
      successes, violations, failed, total: taskIds.length,
      startedAt: rec.createdAt ?? Date.now(),
      duration: rec.duration ?? AB_DURATION,
      resolution: rec.resolution ?? AB_RESOLUTION,
      modelLabel: abModelLabel(rec.model ?? ARK_MODEL),
      finalise, replyToAnchor, localFiles,
    });
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId),
        idRef: { value: null }, commandName: 'Auto Bypass', idLabel: 'ID',
      });
    } catch (fatal) {
      console.error(`Resume autobypass ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await cleanup();
    await jobStore.remove(rec.jobId);
  }
}


// â”€â”€â”€ /sd2 generation handler (Seedance 2.0 via Volcengine ARK) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runSd2Generation(interaction) {
  const commandName = 'Seedance 2.0';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;

  if (isSd2MultiUser(user.id)) {
    return promptSd2Multi(interaction);
  }

  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const idRef = { value: null };
  const startedAt = Date.now();
  const hidePrompt = Boolean(interaction.options.getBoolean('hideprompt'));
  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });
  const sd2Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? SD2_DEFAULT_DURATION;
    const resolution = interaction.options.getString('resolution') ?? SD2_DEFAULT_RESOLUTION;
    const ratio = interaction.options.getString('ratio') ?? SD2_DEFAULT_RATIO;

    const { images: imgAtts, videos: vidAtts, error: refError } = collectReferences(
      interaction, ['img1', 'img2', 'img3'], SD2_MAX_IMAGES, ['vid1'], SD2_MAX_VIDEOS,
    );
    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }
    const refCount = (imgAtts?.length ?? 0) + (vidAtts?.length ?? 0);

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      preparing.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) preparing.setThumbnail(imgAtts[0].url);
    }
    const anchor = await createAnchor(preparing);

    const { taskId } = await sd2.createTask({
      prompt, duration, resolution, ratio,
      images: imgAtts ?? [], videos: vidAtts ?? [],
    });
    idRef.value = taskId;

    try {
      await jobStore.save({
        jobId, kind: 'sd2', userId: user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, anchorMessageId: anchor.id,
        prompt, duration, ratio, resolution,
        refImages: imgAtts?.length ?? 0, refVideos: vidAtts?.length ?? 0, hide: hidePrompt, taskId,
        deadlineAt: startedAt + VIDEO_TIMEOUT, createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist sd2 job ${jobId}: ${err?.message ?? err}`);
    }

    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      working.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) working.setThumbnail(imgAtts[0].url);
    }
    await finalise(working);

    const { videoUrl } = await sd2.waitForTask(taskId, { intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {} });

    const file = await sd2.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd2Settings(duration, ratio, resolution, [`\`${fmtElapsed(Date.now() - startedAt)}\``]) },
          { name: 'Task ID', value: `\`\`\`${idRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp();
      if (refCount) {
        const refSummary = [
          imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
          vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
        ].filter(Boolean).join(', ');
        done.addFields({ name: 'References', value: refSummary });
      }
      await finalise(done);

      if (file.bytes >= limit) {
        const sent = await deliverOverLimitReply(replyToAnchor, { mention: `${user}`, file, limit });
        if (!sent) await replyToAnchor({ content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(jobId, 'sd2');
        console.log(`${idRef.value} (sd2) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance2-video.mp4' })] });
        await markJobDelivered(jobId, 'sd2');
        console.log(`${idRef.value} (sd2) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef, commandName, idLabel: 'Task ID',
      });
      await markJobDelivered(jobId, 'sd2');
    } catch (fatal) {
      console.error(`Unhandled error in ${commandName} for ${user.tag}:`, fatal);
      try {
        const body = { content: 'Something went wrong starting that generation.' };
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
      } catch { /* interaction unusable */ }
    }
  } finally {
    releaseSlot(user.id, jobId);
    await jobStore.remove(jobId);
  }
}


// ─── /sd2-5 generation handler (Seedance 2.5) ────────────────────────────────
// Reference images and video are uploaded to the proxy and passed as
// reference_images / reference_videos.

async function runSd25Generation(interaction) {
  const commandName = 'Seedance 2.5';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const idRef = { value: null };
  const startedAt = Date.now();
  const hidePrompt = Boolean(interaction.options.getBoolean('hideprompt'));
  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });
  const sd25Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? SD25_DEFAULT_DURATION;
    const resolution = interaction.options.getString('resolution') ?? SD25_DEFAULT_RESOLUTION;
    const ratio = interaction.options.getString('ratio') ?? SD25_DEFAULT_RATIO;

    const { images: imgAtts, videos: vidAtts, error: refError } = collectReferences(
      interaction, ['img1', 'img2', 'img3'], SD25_MAX_IMAGES, ['vid1'], SD25_MAX_VIDEOS,
    );
    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }
    const refCount = (imgAtts?.length ?? 0) + (vidAtts?.length ?? 0);

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd25Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      preparing.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) preparing.setThumbnail(imgAtts[0].url);
    }
    const anchor = await createAnchor(preparing);

    const { taskId } = await sd25.createTask({
      prompt, duration, resolution, ratio,
      images: imgAtts ?? [], videos: vidAtts ?? [],
    });
    idRef.value = taskId;

    try {
      await jobStore.save({
        jobId, kind: 'sd25', userId: user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, anchorMessageId: anchor.id,
        prompt, duration, ratio, resolution,
        refImages: imgAtts?.length ?? 0, refVideos: vidAtts?.length ?? 0, hide: hidePrompt, taskId,
        deadlineAt: startedAt + VIDEO_TIMEOUT, createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist sd25 job ${jobId}: ${err?.message ?? err}`);
    }

    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd25Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      working.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) working.setThumbnail(imgAtts[0].url);
    }
    await finalise(working);

    const { videoUrl } = await sd25.waitForTask(taskId, { intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {} });

    const file = await sd25.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd25Settings(duration, ratio, resolution, [`\`${fmtElapsed(Date.now() - startedAt)}\``]) },
          { name: 'Task ID', value: `\`\`\`${idRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp();
      if (refCount) {
        const refSummary = [
          imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
          vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
        ].filter(Boolean).join(', ');
        done.addFields({ name: 'References', value: refSummary });
      }
      await finalise(done);

      if (file.bytes >= limit) {
        const sent = await deliverOverLimitReply(replyToAnchor, { mention: `${user}`, file, limit });
        if (!sent) await replyToAnchor({ content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(jobId, 'sd25');
        console.log(`${idRef.value} (sd2-5) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance25-video.mp4' })] });
        await markJobDelivered(jobId, 'sd25');
        console.log(`${idRef.value} (sd2-5) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef, commandName, idLabel: 'Task ID',
      });
      await markJobDelivered(jobId, 'sd25');
    } catch (fatal) {
      console.error(`Unhandled error in ${commandName} for ${user.tag}:`, fatal);
      try {
        const body = { content: 'Something went wrong starting that generation.' };
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
      } catch { /* interaction unusable */ }
    }
  } finally {
    releaseSlot(user.id, jobId);
    await jobStore.remove(jobId);
  }
}

// ─── /wan-3 generation handler (WAN 3.0) ─────────────────────────────────────
// Resolution rides as parameters.resolution ('480P'/'720P') — native output, no
// SR upscaling. Aspect is prompt-driven (", 16:9 ratio" suffix). Reference images
// are uploaded to the proxy's OSS and passed as input.media reference images.

async function runWanGeneration(interaction) {
  const commandName = 'WAN 3.0';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const idRef = { value: null };
  const startedAt = Date.now();
  const hidePrompt = Boolean(interaction.options.getBoolean('hideprompt'));
  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });
  const wanSettings = (d, r, res, extra = []) => [`\`${d}s\``, `\`${r}\``, `\`${res}\``, '`audio on`', ...extra].join(' \u2022 ');

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? WAN_DEFAULT_DURATION;
    const ratio = interaction.options.getString('ratio') ?? WAN_DEFAULT_RATIO;
    const resolution = interaction.options.getString('resolution') ?? WAN_DEFAULT_RESOLUTION;

    const { images: imgAtts, error: refError } = collectReferences(
      interaction, ['img1', 'img2', 'img3'], WAN_MAX_IMAGES, [], 0,
    );
    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }
    const refCount = imgAtts?.length ?? 0;

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: wanSettings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      preparing.addFields({ name: 'References', value: `${refCount} image${refCount > 1 ? 's' : ''}` });
      preparing.setThumbnail(imgAtts[0].url);
    }
    const anchor = await createAnchor(preparing);

    const { taskId } = await wan.createTask({ prompt, duration, ratio, resolution, images: imgAtts ?? [] });
    idRef.value = taskId;

    try {
      await jobStore.save({
        jobId, kind: 'wan', userId: user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, anchorMessageId: anchor.id,
        prompt, duration, ratio, resolution, refCount, hide: hidePrompt, taskId,
        deadlineAt: startedAt + VIDEO_TIMEOUT, createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist wan job ${jobId}: ${err?.message ?? err}`);
    }

    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: wanSettings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      working.addFields({ name: 'References', value: `${refCount} image${refCount > 1 ? 's' : ''}` });
      working.setThumbnail(imgAtts[0].url);
    }
    await finalise(working);

    const { videoUrl } = await wan.waitForTask(taskId, { intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {} });

    const limit = uploadLimitBytes(interaction.guild);
    // Compress slightly if the render is over the server upload limit so it
    // still attaches instead of bouncing (99% of limit -> re-encode to 98%).
    const overBytes = Math.round(limit * 0.99);
    const targetBytes = Math.round(limit * 0.98);
    let compressed = false;
    let file = await wan.downloadFile(videoUrl);
    if (file.bytes > overBytes) {
      try {
        file = await wan.compressToFit(file, targetBytes);
        compressed = true;
      } catch (err) {
        console.error(`[wan] compression failed (${err?.message ?? err}) — falling back to over-limit notice`);
      }
    }
    try {
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: wanSettings(duration, ratio, resolution, [`\`${fmtElapsed(Date.now() - startedAt)}\``, ...(compressed ? ['`compressed`'] : [])]) },
          { name: 'Task ID', value: `\`\`\`${idRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp();
      if (refCount) done.addFields({ name: 'References', value: `${refCount} image${refCount > 1 ? 's' : ''}` });
      await finalise(done);

      if (file.bytes >= limit) {
        const sent = await deliverOverLimitReply(replyToAnchor, { mention: `${user}`, file, limit });
        if (!sent) await replyToAnchor({ content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(jobId);
        console.log(`${idRef.value} (wan) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'wan3-video.mp4' })] });
        await markJobDelivered(jobId);
        console.log(`${idRef.value} (wan) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached${compressed ? ', compressed' : ''})`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef, commandName, idLabel: 'Task ID',
      });
      await markJobDelivered(jobId);
    } catch (fatal) {
      console.error(`Unhandled error in ${commandName} for ${user.tag}:`, fatal);
      try {
        const body = { content: 'Something went wrong starting that generation.' };
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
      } catch { /* interaction unusable */ }
    }
  } finally {
    releaseSlot(user.id, jobId);
    await jobStore.remove(jobId);
  }
}

// ─── /flux-3 generation handler ──────────────────────────────────────────────
// Each run spins up a disposable Synthesia account (temp.tf email -> Cognito
// signup -> email code -> freemium credits), generates FLUX 3, then downloads it.

async function runFluxGeneration(interaction) {
  const commandName = 'FLUX 3';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const idRef = { value: null };
  const startedAt = Date.now();
  const hidePrompt = Boolean(interaction.options.getBoolean('hideprompt'));
  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });

  const fluxSettings = (d, r) => [`\`${d}s\``, `\`${r}\``, '`audio on`'].join(' \u2022 ');

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? FLUX_DEFAULT_DURATION;
    const ratio = interaction.options.getString('ratio') ?? FLUX_DEFAULT_RATIO;

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: fluxSettings(duration, ratio) })
      .setFooter({ text: `Requested by ${user.username} \u2022 creating a session\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    const anchor = await createAnchor(preparing);

    // Disposable account + workspace + freemium credits. Retry once — signup can
    // transiently fail (temp email allocation / verification code hiccups).
    let session = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { session = await flux.createSession(); break; }
      catch (err) {
        if (attempt === 2) throw err;
        console.warn(`flux createSession attempt ${attempt} failed (${err?.message ?? err}); retrying`);
      }
    }

    // Submit the generation. A content-policy rejection (violence, copyright, etc.)
    // surfaces here as a clean "Couldn't generate your video" message.
    const assetId = await flux.generate(session, { prompt, duration, ratio });
    idRef.value = assetId;

    // The generation id now exists â€” flip the card to "Generating your video".
    await finalise(new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: fluxSettings(duration, ratio) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
      .setTimestamp());

    // Persist so a crash/kill mid-render can resume (rebuild the session from the
    // refresh token, then keep polling the same asset).
    try {
      await jobStore.save({
        jobId,
        kind: 'flux',
        userId: user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        anchorMessageId: anchor.id,
        prompt,
        duration,
        ratio,
        hide: hidePrompt,
        assetId,
        email: session.email,
        refreshToken: session.refreshToken,
        workspaceId: session.workspaceId,
        deadlineAt: startedAt + VIDEO_TIMEOUT,
        createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist flux job ${jobId}: ${err?.message ?? err}`);
    }

    const { videoUrl } = await flux.waitForAsset(session, assetId, {
      intervalMs: 8000,
      timeoutMs: VIDEO_TIMEOUT,
      onUpdate: () => {},
    });

    const file = await flux.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: [`\`${duration}s\``, `\`${ratio}\``, '`audio on`', `\`${fmtElapsed(Date.now() - startedAt)}\``].join(' \u2022 ') },
          { name: 'Asset ID', value: `\`\`\`${idRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp();
      await finalise(done);

      if (file.bytes >= limit) {
        const sent = await deliverOverLimitReply(replyToAnchor, { mention: `${user}`, file, limit });
        if (!sent) await replyToAnchor({ content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        console.log(`${idRef.value} (flux) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'flux3-video.mp4' })] });
        console.log(`${idRef.value} (flux) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef, commandName, idLabel: 'Asset ID',
      });
    } catch (fatal) {
      console.error(`Unhandled error in ${commandName} for ${user.tag}:`, fatal);
      try {
        const body = { content: 'Something went wrong starting that generation.' };
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
      } catch { /* interaction unusable */ }
    }
  } finally {
    releaseSlot(user.id, jobId);
    await jobStore.remove(jobId);
  }
}

// â”€â”€â”€ Resume after a restart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Jobs are persisted the moment the task is submitted, so a crash / OOM-kill /
// deploy mid-render doesn't lose them: on boot we re-poll each task by its id and
// deliver the result to the original message.

function resumeUser(user, id) {
  if (user) return user;
  return { username: 'user', displayAvatarURL: () => undefined, toString: () => `<@${id}>` };
}

async function resumePendingJobs() {
  let records;
  try { records = await jobStore.list(); }
  catch (err) { console.error('Could not read job store:', err); return; }
  if (!records.length) return;
  console.log(`Resuming ${records.length} pending generation(s) from a previous run\u2026`);
  for (const rec of records) {
    resumeOne(rec).catch((err) => console.error(`Resume of ${rec.jobId} failed:`, err));
  }
}

async function resumeOne(rec) {
  let channel = null;
  let anchor = null;
  try {
    channel = await client.channels.fetch(rec.channelId);
    anchor = await channel.messages.fetch(rec.anchorMessageId);
  } catch (err) {
    console.warn(`Resume ${rec.jobId}: original message is gone (${err.message}); dropping.`);
    await jobStore.remove(rec.jobId);
    return;
  }

  const user = await client.users.fetch(rec.userId).catch(() => null);
  const prompt = rec.prompt ?? '';
  const { finalise, replyToAnchor, setAnchor } = makeAnchorFns({ channel, hidePrompt: Boolean(rec.hide) });
  setAnchor(anchor);

  // The outcome already reached the user before a previous shutdown — never
  // deliver a second copy.
  if (rec.delivered) {
    console.log(`Resume ${rec.jobId}: already delivered before the restart; dropping.`);
    await jobStore.remove(rec.jobId);
    return;
  }

  if (rec.kind === 'flux') return resumeFlux(rec, { user, prompt, channel, finalise, replyToAnchor });
  if (rec.kind === 'sd2') return resumeSd2(rec, { user, prompt, channel, finalise, replyToAnchor });
  if (rec.kind === 'sd25') return resumeSd25(rec, { user, prompt, channel, finalise, replyToAnchor });
  if (rec.kind === 'wan') return resumeWan(rec, { user, prompt, channel, finalise, replyToAnchor });
  if (rec.kind === 'autobypass') return resumeAutoBypass(rec, { user, prompt, channel, finalise, replyToAnchor });

  // Unknown / removed provider — cannot resume; drop it.
  console.warn(`Resume ${rec.jobId}: unsupported kind '${rec.kind ?? 'legacy'}', dropping.`);
  await jobStore.remove(rec.jobId);
}

async function resumeFlux(rec, { user, prompt, channel, finalise, replyToAnchor }) {
  const idRef = { value: rec.assetId };
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new FluxError(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'FLUX 3', idLabel: 'Asset ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'FLUX 3' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const session = await flux.sessionFromRefresh({ email: rec.email, refreshToken: rec.refreshToken, workspaceId: rec.workspaceId });
    const { videoUrl } = await flux.waitForAsset(session, rec.assetId, { intervalMs: 8000, timeoutMs: remaining, onUpdate: () => {} });

    const file = await flux.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'FLUX 3' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: [`\`${rec.duration}s\``, `\`${rec.ratio}\``, '`audio on`', '`recovered`'].join(' \u2022 ') },
          { name: 'Asset ID', value: `\`\`\`${rec.assetId ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      await finalise(done);

      if (file.bytes >= limit) {
        const sent = await deliverOverLimitReply(replyToAnchor, { mention, file, limit });
        if (!sent) await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        console.log(`${rec.assetId} (flux resumed) succeeded (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'flux3-video.mp4' })] });
        console.log(`${rec.assetId} (flux resumed) succeeded (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'FLUX 3', idLabel: 'Asset ID' });
    } catch (fatal) {
      console.error(`Resume flux ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

// â”€â”€â”€ Resilience â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
client.on('error', (err) => console.error('Client error:', err));
client.on('shardError', (err) => console.error('Shard websocket error:', err));
client.on('shardDisconnect', (event, id) =>
  console.warn(`Shard ${id} disconnected (code ${event?.code ?? '?'}) \u2014 reconnecting\u2026`));
client.on('shardReconnecting', (id) => console.warn(`Shard ${id} reconnecting\u2026`));
client.on('shardResume', (id) => console.log(`Shard ${id} resumed.`));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (ignored, staying up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored, staying up):', err);
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} \u2014 shutting down cleanly\u2026`);
  try { await client.destroy(); } catch (err) { console.error('Error during shutdown:', err); }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Failed to log in to Discord:', err);
  process.exit(1);
});

async function resumeSd2(rec, { user, prompt, channel, finalise, replyToAnchor }) {
  const idRef = { value: rec.taskId };
  const sd2Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new Sd2Error(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.0', idLabel: 'Task ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'Seedance 2.0' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const { videoUrl } = await sd2.waitForTask(rec.taskId, { intervalMs: POLL_MS, timeoutMs: remaining, onUpdate: () => {} });

    const file = await sd2.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'Seedance 2.0' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd2Settings(rec.duration, rec.ratio, rec.resolution, ['`recovered`']) },
          { name: 'Task ID', value: `\`\`\`${rec.taskId ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      if (rec.refImages || rec.refVideos) {
        const refSummary = [rec.refImages ? `${rec.refImages} image${rec.refImages > 1 ? 's' : ''}` : null, rec.refVideos ? `${rec.refVideos} video${rec.refVideos > 1 ? 's' : ''}` : null].filter(Boolean).join(', ');
        if (refSummary) done.addFields({ name: 'References', value: refSummary });
      }
      await finalise(done);

      if (file.bytes >= limit) {
        const sent = await deliverOverLimitReply(replyToAnchor, { mention, file, limit });
        if (!sent) await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(rec.jobId, 'sd2');
        console.log(`${rec.taskId} (sd2 resumed) succeeded (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance2-video.mp4' })] });
        await markJobDelivered(rec.jobId, 'sd2');
        console.log(`${rec.taskId} (sd2 resumed) succeeded (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.0', idLabel: 'Task ID' });
      await markJobDelivered(rec.jobId, 'sd2');
    } catch (fatal) {
      console.error(`Resume sd2 ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

async function resumeWan(rec, { user, prompt, channel, finalise, replyToAnchor }) {
  const idRef = { value: rec.taskId };
  const wanSettings = (d, r, res, extra = []) => [`\`${d}s\``, `\`${r}\``, `\`${res}\``, '`audio on`', ...extra].join(' \u2022 ');
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new WanError(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'WAN 3.0', idLabel: 'Task ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'WAN 3.0' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const { videoUrl } = await wan.waitForTask(rec.taskId, { intervalMs: POLL_MS, timeoutMs: remaining, onUpdate: () => {} });

    const limit = uploadLimitBytes(channel.guild ?? null);
    const overBytes = Math.round(limit * 0.99);
    const targetBytes = Math.round(limit * 0.98);
    let compressed = false;
    let file = await wan.downloadFile(videoUrl);
    if (file.bytes > overBytes) {
      try {
        file = await wan.compressToFit(file, targetBytes);
        compressed = true;
      } catch (err) {
        console.error(`[wan] compression failed on resume (${err?.message ?? err})`);
      }
    }
    try {
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'WAN 3.0' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: wanSettings(rec.duration, rec.ratio, rec.resolution, ['`recovered`', ...(compressed ? ['`compressed`'] : [])]) },
          { name: 'Task ID', value: `\`\`\`${rec.taskId ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      if (rec.refCount) done.addFields({ name: 'References', value: `${rec.refCount} image${rec.refCount > 1 ? 's' : ''}` });
      await finalise(done);

      if (file.bytes >= limit) {
        const sent = await deliverOverLimitReply(replyToAnchor, { mention, file, limit });
        if (!sent) await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(rec.jobId);
        console.log(`${rec.taskId} (wan resumed) succeeded (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'wan3-video.mp4' })] });
        await markJobDelivered(rec.jobId);
        console.log(`${rec.taskId} (wan resumed) succeeded (${mb} MB, attached${compressed ? ', compressed' : ''})`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'WAN 3.0', idLabel: 'Task ID' });
      await markJobDelivered(rec.jobId);
    } catch (fatal) {
      console.error(`Resume wan ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

async function resumeSd25(rec, { user, prompt, channel, finalise, replyToAnchor }) {
  const idRef = { value: rec.taskId };
  const sd25Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new Sd2Error(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.5', idLabel: 'Task ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'Seedance 2.5' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const { videoUrl } = await sd25.waitForTask(rec.taskId, { intervalMs: POLL_MS, timeoutMs: remaining, onUpdate: () => {} });

    const file = await sd25.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'Seedance 2.5' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd25Settings(rec.duration, rec.ratio, rec.resolution, ['`recovered`']) },
          { name: 'Task ID', value: `\`\`\`${rec.taskId ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      if (rec.refCount) {
        const refSummary = [rec.refImages ? `${rec.refImages} image${rec.refImages > 1 ? 's' : ''}` : null, rec.refVideos ? `${rec.refVideos} video${rec.refVideos > 1 ? 's' : ''}` : null].filter(Boolean).join(', ');
        if (refSummary) done.addFields({ name: 'References', value: refSummary });
      }
      await finalise(done);

      if (file.bytes >= limit) {
        const sent = await deliverOverLimitReply(replyToAnchor, { mention, file, limit });
        if (!sent) await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(rec.jobId, 'sd25');
        console.log(`${rec.taskId} (sd2-5 resumed) succeeded (${mb} MB, over limit)`);
      } else {
        await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance25-video.mp4' })] });
        await markJobDelivered(rec.jobId, 'sd25');
        console.log(`${rec.taskId} (sd2-5 resumed) succeeded (${mb} MB, attached)`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.5', idLabel: 'Task ID' });
      await markJobDelivered(rec.jobId, 'sd25');
    } catch (fatal) {
      console.error(`Resume sd2-5 ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

