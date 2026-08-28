/**
 * WAN 3.0 video via the HappyHorse generation proxy.
 *
 * Async task flow:
 *   1. POST /api/generate  { model, input:{prompt, media?}, parameters:{duration, resolution} } -> task id
 *   2. GET  /api/status/{task_id}  until task_status SUCCEEDED / FAILED
 *   3. Download the mp4 from output.video_url (a signed OSS URL)
 *
 * Reference images are PUT to /api/oss/happyhorse/{date}/{ts}_{sid}/inputs/image_{i}.{ext}
 * which returns {"url": ...}; the returned URL rides in input.media as reference_image.
 *
 * Verified against the live proxy (all probed with ffprobe on real outputs):
 *   - parameters.resolution '720P' -> 1280x720 / 720x1280 native (NO super-resolution)
 *   - parameters.resolution '480P' -> 832x480 native
 *   - parameters.size must NOT be used — the proxy SR-upscales it to 1080p-class
 *   - aspect is driven by a prompt suffix: ", 16:9 ratio" / ", 9:16 ratio"
 *   - model wan3.0-video-prime; outputs carry an AAC audio track (audio on)
 */
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import staticFFmpeg from 'ffmpeg-static';

const pExecFile = promisify(execFile);
const FFMPEG_BIN = process.env.FFMPEG_PATH || staticFFmpeg || 'ffmpeg';

const DEFAULT_BASE_URL = 'http://47.84.12.128:9000';
const DEFAULT_MODEL = 'wan3.0-video-prime';

export const WAN_MODEL = DEFAULT_MODEL;
export const WAN_DURATIONS = [5, 10, 15, 20, 25, 30];
export const WAN_DEFAULT_DURATION = 10;
export const WAN_RATIOS = ['16:9', '9:16'];
export const WAN_DEFAULT_RATIO = '16:9';
export const WAN_RESOLUTIONS = ['480P', '720P'];
export const WAN_DEFAULT_RESOLUTION = '720P';
export const WAN_MAX_IMAGES = 3;

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000; // 20 min
const REQUEST_TIMEOUT_MS = 45_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const MB = 1024 * 1024;

// Moderation / policy rejections -> amber "blocked" rather than red "error".
// Covers input+output moderation (IPInfringementSuspect, DataInspectionFailed, etc.)
const BLOCK_RE = /sensitive|privacy|real person|policy|violat|prohibit|nsfw|copyright|infring\w*|ip\s*infring|risk|illegal|moderat|inappropriate|inspection|green net/i;

// Infra fingerprints that must never surface in a Discord message.
const SCRUB_RE = /47\.84\.12\.128|happyhorse|hhtestforintl|aliyuncs|dashscope|oss-ap|alibaba|SimpleHTTP|9000|amerie|byteplus|69\.5\.8\.219/i;

export class WanError extends Error {
  constructor(message, { status, code, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'WanError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.blocked = Boolean(blocked);
    this.timedOut = Boolean(timedOut);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ffRun(args, { timeoutMs = 300_000 } = {}) {
  try {
    return await pExecFile(FFMPEG_BIN, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new WanError(`ffmpeg step failed: ${err?.message ?? err}`);
  }
}

async function videoDurationSeconds(file) {
  // ffmpeg exits non-zero with no output target but still prints the header —
  // no decode needed.
  try {
    await pExecFile(FFMPEG_BIN, ['-hide_banner', '-nostats', '-i', file], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
  }
  return null;
}

function userMessage(msg, fallback) {
  let m = (msg || '').trim();
  // Strip backend moderation jargon prefixes ("Green net check failed for image (output): ...").
  m = m.replace(/^green net check failed[^:]*:\s*/i, '');
  if (!m || m.length > 300) return fallback;
  if (SCRUB_RE.test(m)) return fallback;
  return m;
}

export class WanClient {
  #base;
  #model;
  #fetch;

  constructor({ baseUrl, model, fetchImpl } = {}) {
    this.#base = (baseUrl ?? process.env.WAN_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#model = model ?? process.env.WAN_MODEL ?? DEFAULT_MODEL;
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  async #fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await this.#fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  // ─── Reference upload ───────────────────────────────────────────────────────
  // Mirrors the web app: PUT the file bytes to /api/oss/happyhorse/{date}/{ts}_{sid}/inputs/image_{i}.{ext}
  // then reference the public OSS mirror of that key in input.media.
  // WAN only accepts image references (collectReferences caps them at 20 MB),
  // so a bounded single-buffer PUT is fine here — no video refs ride this path.
  async uploadReference(attachment, index) {
    const url = attachment.url ?? attachment;
    const name = attachment.name || 'image.png';
    const extMatch = name.match(/\.([a-z0-9]{2,5})$/i);
    const ext = (extMatch ? extMatch[1] : 'png').toLowerCase();

    let bytes;
    try {
      const resp = await this.#fetchWithTimeout(url, {}, UPLOAD_TIMEOUT_MS);
      if (!resp.ok) throw new WanError('Could not fetch a reference image.');
      bytes = Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      if (err instanceof WanError) throw err;
      console.error(`[wan.uploadReference] fetch failed: ${err?.message ?? err}`);
      throw new WanError('Could not upload a reference image. Please try again.');
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    const sid = Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    const ossPath = `happyhorse/${date}/${time}_${sid}/inputs/image_${index}.${ext}`;

    try {
      const resp = await this.#fetchWithTimeout(`${this.#base}/api/oss/${ossPath}`, {
        method: 'PUT',
        headers: { 'Content-Type': attachment.contentType || 'image/png', 'Content-Length': String(bytes.length) },
        body: bytes,
      }, UPLOAD_TIMEOUT_MS);
      const txt = await resp.text().catch(() => '');
      let data = null; try { data = JSON.parse(txt); } catch { /* */ }
      if (!resp.ok || !data?.url) {
        console.error(`[wan.uploadReference] HTTP ${resp.status}: ${txt.slice(0, 300)}`);
        throw new WanError('Could not upload a reference image. Please try again.');
      }
      return data.url;
    } catch (err) {
      if (err instanceof WanError) throw err;
      console.error(`[wan.uploadReference] PUT failed: ${err?.message ?? err}`);
      throw new WanError('Could not upload a reference image. Please try again.');
    }
  }

  // ─── Create task ────────────────────────────────────────────────────────────
  async createTask({ prompt, duration, ratio, resolution, images = [] }) {
    // Aspect is prompt-driven (the model's ratio handling is otherwise auto/random).
    const text = `${prompt}, ${ratio} ratio`;
    const input = { prompt: text };
    if (images.length) {
      const media = [];
      for (const [i, a] of images.entries()) {
        media.push({ type: 'reference_image', url: await this.uploadReference(a, i) });
      }
      input.media = media;
    }
    const body = {
      model: this.#model,
      input,
      parameters: { duration, resolution },
    };

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(3000 * attempt);

      let resp;
      try {
        resp = await this.#fetchWithTimeout(`${this.#base}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = new WanError('Could not start video generation. Please try again.');
        console.warn(`[wan.createTask] network error (attempt ${attempt + 1}/3): ${err?.message ?? err}`);
        continue;
      }

      const txt = await resp.text().catch(() => '');
      let data = null; try { data = JSON.parse(txt); } catch { /* */ }

      if (resp.ok && data?.output?.task_id) return { taskId: data.output.task_id };

      const msg = data?.message || data?.error || '';
      console.error(`[wan.createTask] HTTP ${resp.status}: ${txt.slice(0, 500)}`);

      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new WanError('The generation service is busy right now. Please try again in a minute.', { status: resp.status, body: txt, blocked: true });
        continue;
      }
      throw new WanError(
        userMessage(msg, 'Could not start video generation. Please try again.'),
        { status: resp.status, body: txt, blocked: BLOCK_RE.test(String(msg)) },
      );
    }
    throw lastErr ?? new WanError('Could not start video generation. Please try again.');
  }

  // ─── Poll ───────────────────────────────────────────────────────────────────
  async waitForTask(taskId, { intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS, onUpdate } = {}) {
    const deadline = Date.now() + timeoutMs;
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    let lastStatus = null;
    let fails = 0;

    while (Date.now() < deadline) {
      let resp;
      try {
        resp = await this.#fetchWithTimeout(`${this.#base}/api/status/${taskId}`);
      } catch (err) {
        fails += 1;
        console.warn(`[wan.waitForTask] poll request failed (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new WanError('Could not check generation status. Please try again.');
        await sleep(intervalMs); continue;
      }

      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        if (resp.status >= 500 || resp.status === 429) {
          fails += 1;
          console.warn(`[wan.waitForTask] transient HTTP ${resp.status} (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
          if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new WanError('Could not check generation status. Please try again.', { status: resp.status, body: t });
          await sleep(intervalMs); continue;
        }
        console.error(`[wan.waitForTask] HTTP ${resp.status}: ${t.slice(0, 300)}`);
        throw new WanError('Could not check generation status. Please try again.', { status: resp.status, body: t });
      }

      fails = 0;
      const data = await resp.json();
      const output = data.output ?? {};
      const status = output.task_status;
      if (status !== lastStatus) { lastStatus = status; if (onUpdate) onUpdate(status); }

      if (status === 'SUCCEEDED') {
        const url = output.video_url;
        if (!url) throw new WanError('Generation finished but no video URL was returned.', { body: data });
        return { videoUrl: url, raw: data };
      }
      if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED' || status === 'UNKNOWN') {
        const code = output.code || '';
        const msg = output.message || `Generation ${status}.`;
        console.error(`[wan.waitForTask] ${status} code=${code}: ${msg}`);
        throw new WanError(userMessage(msg, 'Generation failed. Please try again.'), { code, body: data, blocked: BLOCK_RE.test(`${code} ${msg}`) });
      }
      await sleep(intervalMs);
    }
    throw new WanError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── Download (streamed to disk) ────────────────────────────────────────────
  async downloadFile(url, { timeoutMs = 180_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const filePath = path.join(os.tmpdir(), `wan-${randomBytes(8).toString('hex')}.mp4`);
    try {
      const resp = await this.#fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new WanError('Could not download the result file.', { status: resp.status });
      const contentType = resp.headers.get('content-type') || 'video/mp4';
      if (resp.body && typeof Readable.fromWeb === 'function') {
        await pipeline(Readable.fromWeb(resp.body), createWriteStream(filePath));
      } else {
        await writeFile(filePath, Buffer.from(await resp.arrayBuffer()));
      }
      const { size } = await stat(filePath);
      return { path: filePath, bytes: size, contentType };
    } catch (err) {
      await unlink(filePath).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Compress to a target size ──────────────────────────────────────────────
  // Re-encodes at a bitrate computed from the duration so the result lands under
  // targetBytes. Retries once with a scaled-down bitrate if the first pass
  // overshoots. The input file is unlinked on success.
  async compressToFit(file, targetBytes) {
    const duration = await videoDurationSeconds(file.path);
    if (!duration || duration <= 0) throw new WanError('Could not measure the video duration.');

    const AUDIO_KBPS = 128;
    const target = async (videoKbps, outPath) => {
      const args = [
        '-y', '-hide_banner', '-nostats',
        '-threads', '2',
        '-i', file.path,
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', `${videoKbps}k`,
        '-maxrate', `${Math.round(videoKbps * 1.4)}k`,
        '-bufsize', `${Math.round(videoKbps * 3)}k`,
        '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
        '-movflags', '+faststart',
        outPath,
      ];
      await ffRun(args, { timeoutMs: 600_000 });
      const { size } = await stat(outPath);
      return size;
    };

    let videoKbps = Math.max(500, Math.floor((targetBytes * 8) / 1000 / duration) - AUDIO_KBPS);
    const outPath = path.join(os.tmpdir(), `wan-c-${randomBytes(8).toString('hex')}.mp4`);
    try {
      let bytes = await target(videoKbps, outPath);
      if (bytes > targetBytes) {
        videoKbps = Math.max(300, Math.floor(videoKbps * (targetBytes / bytes) * 0.95));
        await unlink(outPath).catch(() => {});
        bytes = await target(videoKbps, outPath);
      }
      if (bytes > targetBytes) throw new WanError('Could not compress the video under the upload limit.');
      await unlink(file.path).catch(() => {});
      console.log(`[wan.compressToFit] ${(file.bytes / MB).toFixed(1)} MB -> ${(bytes / MB).toFixed(1)} MB (@${videoKbps}k)`);
      return { path: outPath, bytes, contentType: 'video/mp4' };
    } catch (err) {
      await unlink(outPath).catch(() => {});
      throw err;
    }
  }
}

export function classifyWanFailure(err) {
  if (err instanceof WanError) return { blocked: err.blocked, message: err.message };
  return { blocked: false, message: err?.message || 'An unexpected error occurred.' };
}
