/**
 * Registers the /flux-3, /sd2, /sd2-5 and /wan-3 slash commands with Discord.
 * Run once after setup, and again whenever the options below change:
 *   npm run register
 */
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import {
  FLUX_DURATIONS,
  FLUX_DEFAULT_DURATION,
  FLUX_RATIOS,
  FLUX_DEFAULT_RATIO,
} from './flux.js';
import {
  SD2_DURATIONS,
  SD2_DEFAULT_DURATION,
  SD2_RESOLUTIONS,
  SD2_DEFAULT_RESOLUTION,
  SD2_RATIOS,
  SD2_DEFAULT_RATIO,
  SD2_MAX_IMAGES,
  SD2_MAX_VIDEOS,
} from './sd2.js';
import {
  SD25_DURATIONS,
  SD25_DEFAULT_DURATION,
  SD25_RESOLUTIONS,
  SD25_DEFAULT_RESOLUTION,
  SD25_RATIOS,
  SD25_DEFAULT_RATIO,
  SD25_MAX_IMAGES,
  SD25_MAX_VIDEOS,
} from './sd2.js';
import {
  WAN_DURATIONS,
  WAN_DEFAULT_DURATION,
  WAN_RATIOS,
  WAN_DEFAULT_RATIO,
  WAN_RESOLUTIONS,
  WAN_DEFAULT_RESOLUTION,
  WAN_MAX_IMAGES,
} from './wan.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are both required in .env');
  process.exit(1);
}
if (!DISCORD_GUILD_ID) {
  console.error('DISCORD_GUILD_ID is required \u2014 the bot is restricted to a single server.');
  process.exit(1);
}

/**
 * /flux-3 \u2014 FLUX 3 video via Synthesia (disposable account per run).
 * prompt, duration (5/10/15/20s), ratio (16:9 / 9:16). Audio always on.
 */
const flux3Builder = new SlashCommandBuilder()
  .setName('flux-3')
  .setDescription('Generate a video with FLUX 3')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('What should the video show?').setRequired(true).setMaxLength(4000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription(`Length in seconds (default ${FLUX_DEFAULT_DURATION})`)
      .addChoices(...FLUX_DURATIONS.map((d) => ({ name: `${d}s${d === FLUX_DEFAULT_DURATION ? ' (default)' : ''}`, value: d }))),
  )
  .addStringOption((o) =>
    o.setName('ratio').setDescription(`Aspect ratio (default ${FLUX_DEFAULT_RATIO})`)
      .addChoices(...FLUX_RATIOS.map((r) => ({ name: r === FLUX_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  )
  .addBooleanOption((o) =>
    o.setName('hideprompt').setDescription("Hide your prompt from the bot's messages"));

/**
 * /sd2 \u2014 Seedance 2.0 video with optional reference images / video.
 * prompt, duration (5/10/15s), resolution (480p/720p), ratio (16:9 / 9:16).
 */
const sd2Builder = new SlashCommandBuilder()
  .setName('sd2')
  .setDescription('Generate a video with Seedance 2.0')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('What should the video show?').setRequired(true).setMaxLength(4000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription(`Length in seconds (default ${SD2_DEFAULT_DURATION})`)
      .addChoices(...SD2_DURATIONS.map((d) => ({ name: `${d}s${d === SD2_DEFAULT_DURATION ? ' (default)' : ''}`, value: d }))),
  )
  .addStringOption((o) =>
    o.setName('resolution').setDescription(`Output resolution (default ${SD2_DEFAULT_RESOLUTION})`)
      .addChoices(...SD2_RESOLUTIONS.map((r) => ({ name: r === SD2_DEFAULT_RESOLUTION ? `${r} (default)` : r, value: r }))),
  )
  .addStringOption((o) =>
    o.setName('ratio').setDescription(`Aspect ratio (default ${SD2_DEFAULT_RATIO})`)
      .addChoices(...SD2_RATIOS.map((r) => ({ name: r === SD2_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to ${SD2_MAX_IMAGES})`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'))
  .addAttachmentOption((o) => o.setName('vid1').setDescription(`Reference video \u2014 MP4/MOV (optional, up to ${SD2_MAX_VIDEOS})`))
  .addBooleanOption((o) =>
    o.setName('hideprompt').setDescription("Hide your prompt from the bot's messages"));

/**
 * /sd2-5 \u2014 Seedance 2.5 video with reference images / video.
 * prompt, duration (5-30s), ratio (16:9 / 9:16 / 21:9), resolution (480p/720p),
 * up to 3 reference images and 1 reference video (passed as references).
 */
const sd25Builder = new SlashCommandBuilder()
  .setName('sd2-5')
  .setDescription('Generate a video with Seedance 2.5')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('What should the video show?').setRequired(true).setMaxLength(4000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription(`Length in seconds (default ${SD25_DEFAULT_DURATION})`)
      .addChoices(...SD25_DURATIONS.map((d) => ({ name: `${d}s${d === SD25_DEFAULT_DURATION ? ' (default)' : ''}`, value: d }))),
  )
  .addStringOption((o) =>
    o.setName('resolution').setDescription(`Output resolution (default ${SD25_DEFAULT_RESOLUTION})`)
      .addChoices(...SD25_RESOLUTIONS.map((r) => ({ name: r === SD25_DEFAULT_RESOLUTION ? `${r} (default)` : r, value: r }))),
  )
  .addStringOption((o) =>
    o.setName('ratio').setDescription(`Aspect ratio (default ${SD25_DEFAULT_RATIO})`)
      .addChoices(...SD25_RATIOS.map((r) => ({ name: r === SD25_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to ${SD25_MAX_IMAGES})`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'))
  .addAttachmentOption((o) => o.setName('vid1').setDescription(`Reference video \u2014 MP4/MOV (optional, up to ${SD25_MAX_VIDEOS})`))
  .addBooleanOption((o) =>
    o.setName('hideprompt').setDescription("Hide your prompt from the bot's messages"));

/**
 * /wan-3 \u2014 WAN 3.0 video. Resolution is native (480P -> 832x480, 720P -> 1280x720).
 * prompt, duration (5-30s), ratio (16:9 / 9:16), up to 3 reference images
 * (passed as reference images, not a first frame). Audio always on.
 */
const wan3Builder = new SlashCommandBuilder()
  .setName('wan-3')
  .setDescription('Generate a video with WAN 3.0')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('What should the video show?').setRequired(true).setMaxLength(4000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription(`Length in seconds (default ${WAN_DEFAULT_DURATION})`)
      .addChoices(...WAN_DURATIONS.map((d) => ({ name: `${d}s${d === WAN_DEFAULT_DURATION ? ' (default)' : ''}`, value: d }))),
  )
  .addStringOption((o) =>
    o.setName('ratio').setDescription(`Aspect ratio (default ${WAN_DEFAULT_RATIO})`)
      .addChoices(...WAN_RATIOS.map((r) => ({ name: r === WAN_DEFAULT_RATIO ? `${r} (default)` : r, value: r }))),
  )
  .addStringOption((o) =>
    o.setName('resolution').setDescription(`Output resolution (default ${WAN_DEFAULT_RESOLUTION})`)
      .addChoices(...WAN_RESOLUTIONS.map((r) => ({ name: r === WAN_DEFAULT_RESOLUTION ? `${r} (default)` : r, value: r }))),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to ${WAN_MAX_IMAGES})`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'))
  .addBooleanOption((o) =>
    o.setName('hideprompt').setDescription("Hide your prompt from the bot's messages"));

/**
 * /autobypass \u2014 fires 4 Seedance 2.5 renders (30s) of the prompt template with
 * the intro clip as the reference video, trims the intro off every
 * render and delivers each as an embeddable link.
 */
const autobypassBuilder = new SlashCommandBuilder()
  .setName('autobypass')
  .setDescription('Fire 4 renders of your prompt and deliver them intro-trimmed as links')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('The scene the video should cut to after the intro').setRequired(true).setMaxLength(3000),
  )
  .addAttachmentOption((o) => o.setName('img1').setDescription(`Reference image (optional, up to 3) \u2014 passed as a reference, not a first frame`))
  .addAttachmentOption((o) => o.setName('img2').setDescription('A second reference image (optional)'))
  .addAttachmentOption((o) => o.setName('img3').setDescription('A third reference image (optional)'))
  .addBooleanOption((o) =>
    o.setName('hideprompt').setDescription("Hide your prompt from the bot's messages"));

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const route = Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID);

try {
  const data = await rest.put(route, { body: [flux3Builder.toJSON(), sd2Builder.toJSON(), sd25Builder.toJSON(), wan3Builder.toJSON(), autobypassBuilder.toJSON()] });
  console.log(`Registered ${data.length} command(s) in server ${DISCORD_GUILD_ID}:`);
  for (const c of data) {
    console.log(`  /${c.name} \u2014 ${c.description}`);
    for (const o of c.options ?? []) {
      console.log(`      ${o.name}${o.required ? '*' : ''} \u2014 ${o.description}`);
    }
  }
  console.log('\nGuild commands appear immediately. Start the bot with: npm start');
} catch (err) {
  console.error('Registration failed:', err);
  process.exit(1);
}
