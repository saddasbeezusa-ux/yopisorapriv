/**
 * Seedance 2.0 / 2.5 video via the amerie.byteplus-demo.com generation proxy.
 *
 * Async task flow:
 *   1. POST /api/upload  (multipart, field "file")  -> {"filename","url"}   [refs only]
 *   2. POST /api/generate { prompt, model, task_type, ratio, resolution, duration,
 *      generate_audio, watermark, return_last_frame, output_format,
 *      reference_images:[{url, role}], reference_videos:[...], reference_audios:[] }
 *      -> {"applied":{...},"id":"cgt-..."}
 *   3. GET  /api/task/{id}  until status "succeeded" / "failed"
 *   4. Download the mp4 from content.video_url (signed TOS URL)
 *
 * Model "pro" -> dreamina-seedance-2-0 (Seedance 2.0, /sd2, text-to-video)
 * Model "v25" -> dreamina-seedance-2-5-260628 (Seedance 2.5, /sd2-5, refs)
 *
 * Verified live (probed + ffprobe on real outputs):
 *   - task_type "t2v" (no refs) / "ref" (with refs) both accepted on both models
 *   - ratios 16:9 / 9:16 / 21:9, resolutions 480p / 720p, durations 5-30
 *   - audio always on (generate_audio: true), watermark off
 */
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fetchToTempFile, multipartUploadFile, safeUnlinkTemp } from './httputil.js';

const DEFAULT_BASE_URL = 'https://amerie.byteplus-demo.com';

export const SD2_MODEL = 'pro';
export const SD2_DURATIONS = [5, 10, 15];
export const SD2_DEFAULT_DURATION = 10;
export const SD2_RESOLUTIONS = ['480p', '720p'];
export const SD2_DEFAULT_RESOLUTION = '720p';
export const SD2_RATIOS = ['16:9', '9:16'];
export const SD2_DEFAULT_RATIO = '16:9';
export const SD2_MAX_IMAGES = 3;
export const SD2_MAX_VIDEOS = 1;

export const SD25_MODEL = 'v25';
export const SD25_DURATIONS = [5, 10, 15, 20, 25, 30];
export const SD25_DEFAULT_DURATION = 10;
export const SD25_RESOLUTIONS = ['480p', '720p'];
export const SD25_DEFAULT_RESOLUTION = '720p';
export const SD25_RATIOS = ['16:9', '9:16', '21:9'];
export const SD25_DEFAULT_RATIO = '16:9';
export const SD25_MAX_IMAGES = 3;
export const SD25_MAX_VIDEOS = 1;

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000; // 20 min
const REQUEST_TIMEOUT_MS = 45_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

// Moderation / policy rejections -> amber "blocked" rather than red "error".
const BLOCK_RE = /sensitive|privacy|real person|policy|violat|prohibit|nsfw|copyright|infring\w*|ip\s*infring|risk|illegal|moderat|inappropriate|inspection|green net/i;

export class Sd2Error extends Error {
  constructor(message, { status, code, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'Sd2Error';
    this.status = status;
    this.code = code;
    this.body = body;
    this.blocked = Boolean(blocked);
    this.timedOut = Boolean(timedOut);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userMessage(msg, fallback) {
  let m = (msg || '').trim();
  // Drop the provider's internal tracking tail ("... Request id: 0217...").
  m = m.replace(/\s*Request id:.*$/i, '');
  // Redact backend identifiers IN PLACE — the actual reason (e.g. "video
  // duration must be less than or equal to 30.2") must reach the user, only
  // the infrastructure names get rewritten. URLs go last so anything left
  // over (even a redacted fragment) collapses into a generic token.
  m = m
    .replace(/https?:\/\/\S+/gi, 'a service URL')
    .replace(/dreamina-seedance-2-5[\w.-]*/gi, 'Seedance 2.5')
    .replace(/dreamina-seedance-2-0[\w.-]*/gi, 'Seedance 2.0')
    .replace(/dreamina[\w.-]*/gi, 'the model')
    .replace(/doubao[\w.-]*/gi, 'the model')
    .replace(/amerie[\w.-]*/gi, 'the service')
    .replace(/[a-z0-9.-]*byteplus[a-z0-9.-]*/gi, 'the service')
    .replace(/69\.5\.8\.219/gi, 'the service')
    .replace(/\b(volces|ark-acg|tos-ap-southeast-\d|bytedance|douyin|volcengine)\b/gi, 'the backend');
  if (!m || m.length > 300) return fallback;
  return m;
}

export class SeedanceClient {
  #base;
  #model;
  #fetch;

  constructor({ model = SD2_MODEL, baseUrl, fetchImpl } = {}) {
    this.#base = (baseUrl ?? process.env.SD2_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#model = model;
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  async #fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await this.#fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  // ─── Reference upload ───────────────────────────────────────────────────────
  // Multipart POST with a single "file" field; returns the proxy-hosted URL that
  // rides into reference_images / reference_videos.
  // Streaming: attachment lands in a temp file and the multipart body streams
  // from disk — a 100 MB reference never touches the JS heap.
  async uploadReference(attachment) {
    const url = attachment.url ?? attachment;
    const name = (attachment.name || 'reference.png').split('/').pop();

    const tmp = await fetchToTempFile(this.#fetch, url, { prefix: 'sd-ref' });
    try {
      const resp = await multipartUploadFile(this.#fetch, `${this.#base}/api/upload`, tmp.path, {
        fieldName: 'file',
        contentType: attachment.contentType || 'application/octet-stream',
        filename: name,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      const txt = await resp.text().catch(() => '');
      let data = null; try { data = JSON.parse(txt); } catch { /* */ }
      if (!resp.ok || !data?.url) {
        console.error(`[sd.uploadReference] HTTP ${resp.status}: ${txt.slice(0, 300)}`);
        throw new Sd2Error('Could not upload a reference file. Please try again.');
      }
      return data.url;
    } catch (err) {
      if (err instanceof Sd2Error) throw err;
      console.error(`[sd.uploadReference] failed: ${err?.message ?? err}`);
      throw new Sd2Error('Could not upload a reference file. Please try again.');
    } finally {
      await safeUnlinkTemp(tmp.path);
    }
  }

  // ─── Create task ────────────────────────────────────────────────────────────
  async createTask({ prompt, duration, ratio, resolution, images = [], videos = [] }) {
    const referenceImages = [];
    for (const a of images) {
      referenceImages.push({ url: await this.uploadReference(a), role: 'reference_image' });
    }
    const referenceVideos = [];
    for (const a of videos) {
      referenceVideos.push({ url: await this.uploadReference(a), role: 'reference_video' });
    }

    const body = {
      prompt,
      model: this.#model,
      task_type: (referenceImages.length || referenceVideos.length) ? 'ref' : 't2v',
      ratio,
      resolution,
      duration,
      generate_audio: true,
      watermark: false,
      return_last_frame: false,
      output_format: 'mp4',
      reference_images: referenceImages,
      reference_videos: referenceVideos,
      reference_audios: [],
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
        lastErr = new Sd2Error('Could not start video generation. Please try again.');
        console.warn(`[sd.createTask] network error (attempt ${attempt + 1}/3): ${err?.message ?? err}`);
        continue;
      }

      const txt = await resp.text().catch(() => '');
      let data = null; try { data = JSON.parse(txt); } catch { /* */ }

      if (resp.ok && data?.id) return { taskId: data.id };

      const msg = data?.error?.message || data?.message || data?.error || '';
      console.error(`[sd.createTask] HTTP ${resp.status}: ${txt.slice(0, 500)}`);

      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new Sd2Error('The generation service is busy right now. Please try again in a minute.', { status: resp.status, body: txt, blocked: true });
        continue;
      }
      throw new Sd2Error(
        userMessage(String(msg), 'Could not start video generation. Please try again.'),
        { status: resp.status, body: txt, blocked: BLOCK_RE.test(String(msg)) },
      );
    }
    throw lastErr ?? new Sd2Error('Could not start video generation. Please try again.');
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
        resp = await this.#fetchWithTimeout(`${this.#base}/api/task/${taskId}`);
      } catch (err) {
        fails += 1;
        console.warn(`[sd.waitForTask] poll request failed (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new Sd2Error('Could not check generation status. Please try again.');
        await sleep(intervalMs); continue;
      }

      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        if (resp.status >= 500 || resp.status === 429) {
          fails += 1;
          console.warn(`[sd.waitForTask] transient HTTP ${resp.status} (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
          if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new Sd2Error('Could not check generation status. Please try again.', { status: resp.status, body: t });
          await sleep(intervalMs); continue;
        }
        console.error(`[sd.waitForTask] HTTP ${resp.status}: ${t.slice(0, 300)}`);
        throw new Sd2Error('Could not check generation status. Please try again.', { status: resp.status, body: t });
      }

      fails = 0;
      const data = await resp.json();
      const status = data.status;
      if (status !== lastStatus) { lastStatus = status; if (onUpdate) onUpdate(status); }

      if (status === 'succeeded') {
        const url = data.content?.video_url;
        if (!url) throw new Sd2Error('Generation finished but no video URL was returned.', { body: data });
        return { videoUrl: url, raw: data };
      }
      if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
        const code = data.error?.code || '';
        const msg = data.error?.message || `Generation ${status}.`;
        console.error(`[sd.waitForTask] ${status} code=${code}: ${msg}`);
        throw new Sd2Error(userMessage(msg, 'Generation failed. Please try again.'), { code, body: data, blocked: BLOCK_RE.test(`${code} ${msg}`) });
      }
      await sleep(intervalMs);
    }
    throw new Sd2Error(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── Download (streamed to disk) ────────────────────────────────────────────
  async downloadFile(url, { timeoutMs = 180_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const filePath = path.join(os.tmpdir(), `sd-${randomBytes(8).toString('hex')}.mp4`);
    try {
      const resp = await this.#fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Sd2Error('Could not download the result file.', { status: resp.status });
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
}

export function classifySd2Failure(err) {
  if (err instanceof Sd2Error) return { blocked: err.blocked, message: err.message };
  return { blocked: false, message: err?.message || 'An unexpected error occurred.' };
}
