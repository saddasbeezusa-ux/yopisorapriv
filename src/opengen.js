/**
 * Doubao Seedance video via the open generation site (39.102.119.194).
 *
 * Flow:
 *   1. (refs only) POST /api/upload  (multipart, field "file") -> {"filename","url"}
 *      — reference videos/images ride in reference_videos[] / reference_images[]
 *        as plain URL strings
 *   2. POST /api/create { prompt, mode:"text"|"vision", ratio, duration,
 *      generate_audio:true, watermark:false, reference_images, reference_videos,
 *      reference_audios:[] } -> {"success":true,"task_id":"task_..."}
 *   3. GET /api/status/{task_id} -> status NOT_START|pending|IN_PROGRESS|SUCCESS|FAILURE
 *      (on FAILURE both fail_reason AND video_url carry the error message)
 *   4. Download task.video_url (signed TOS link, 24h expiry)
 *
 * Server facts (verified live 2026-08-29):
 *   - model is FIXED server-side to doubao-seedance-2-0 (a "model" field is
 *     silently ignored — the result URL path still says doubao-seedance-2-0)
 *   - duration caps at 15s for Seedance 2.0 (30s rejected as InvalidParameter)
 *   - there is NO resolution parameter (any value is ignored)
 *   - reference videos must be >= 1.8s — pad shorter clips
 *   - external image URLs (e.g. Discord CDN) work as reference_images
 */
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://39.102.119.194';
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128';

export const OPENGEN_BASE_URL = DEFAULT_BASE_URL;
export const OPENGEN_MODEL = DEFAULT_MODEL;

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000; // 20 min
const REQUEST_TIMEOUT_MS = 45_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const ACTIVE_STATUSES = new Set(['NOT_START', 'pending', 'IN_START', 'IN_PROGRESS', 'queued', 'running']);

// Moderation / policy rejections -> amber "blocked" rather than red "error".
const BLOCK_RE = /sensitive|privacy|real person|policy|violat|prohibit|nsfw|copyright|infring\w*|ip\s*infring|risk|illegal|moderat|inappropriate/i;

export class OpenGenError extends Error {
  constructor(message, { status, code, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'OpenGenError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.blocked = Boolean(blocked);
    this.timedOut = Boolean(timedOut);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Error strings arrive double-encoded: {"message":"{\"error\":{...}}"} — unwrap,
// then scrub anything that names the backend.
function userMessage(code, raw, fallback) {
  let msg = String(raw ?? '').trim();
  if (msg.startsWith('{')) {
    try {
      const inner = JSON.parse(msg);
      msg = inner?.error?.message || inner?.message || msg;
    } catch { /* keep raw */ }
  }
  msg = msg.trim();
  if (!msg || msg.length > 300) return fallback;
  if (/39\.102|doubao|volces|volcengine|\bark\b|tos-cn-beijing|火山/i.test(msg)) return fallback;
  return msg.replace(/\s*Request id:.*$/i, '').trim() || fallback;
}

export class OpenGenClient {
  #base;
  #model;
  #fetch;

  constructor({ baseUrl, model, fetchImpl } = {}) {
    this.#base = (baseUrl ?? process.env.OPENGEN_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#model = model ?? DEFAULT_MODEL;
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  async #fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await this.#fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  // ─── Reference upload ──────────────────────────────────────────────────────
  // POST /api/upload (multipart field "file") -> {"filename","success","url"}
  async uploadReferenceFile(source) {
    const form = new FormData();
    if (source.path) {
      const bytes = await readFile(source.path);
      form.append('file', new Blob([bytes], { type: source.contentType || 'application/octet-stream' }), source.name || 'ref.bin');
    } else if (source.url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      let bytes;
      try {
        const resp = await this.#fetch(source.url, { signal: ctrl.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching reference file`);
        bytes = Buffer.from(await resp.arrayBuffer());
      } catch (err) {
        clearTimeout(timer);
        throw new OpenGenError('Could not fetch a reference file.');
      }
      clearTimeout(timer);
      form.append('file', new Blob([bytes], { type: source.contentType || 'application/octet-stream' }), source.name || 'ref.bin');
    } else {
      throw new OpenGenError('Could not fetch a reference file.');
    }

    const resp = await this.#fetchWithTimeout(`${this.#base}/api/upload`, {
      method: 'POST', body: form,
    }, UPLOAD_TIMEOUT_MS);
    const txt = await resp.text().catch(() => '');
    let data = null; try { data = JSON.parse(txt); } catch { /* */ }
    if (!resp.ok || !data?.url) {
      console.error(`[opengen.uploadReferenceFile] HTTP ${resp.status}: ${txt.slice(0, 300)}`);
      throw new OpenGenError('Could not upload a reference file.', { status: resp.status, body: txt });
    }
    return data.url;
  }

  // ─── Create task ───────────────────────────────────────────────────────────
  // images: [{url, contentType, name}] (Discord attachments ride as URLs)
  // videos: string URLs (already uploaded) or {path|url, name, contentType}
  async createTask({ prompt, duration, ratio, images = [], videos = [] }) {
    const referenceImages = [];
    for (const a of images) {
      if (typeof a === 'string') { referenceImages.push(a); continue; }
      if (a.url && !a.contentType && !a.name) { referenceImages.push(a.url); continue; }
      referenceImages.push(await this.uploadReferenceFile(a));
    }
    const referenceVideos = [];
    for (const v of videos) {
      if (typeof v === 'string') { referenceVideos.push(v); continue; }
      if (v.url && !v.contentType && !v.name) { referenceVideos.push(v.url); continue; }
      referenceVideos.push(await this.uploadReferenceFile(v));
    }

    const body = {
      prompt,
      mode: (referenceImages.length || referenceVideos.length) ? 'vision' : 'text',
      ratio: String(ratio),
      duration: Number(duration),
      generate_audio: true,
      watermark: false,
      reference_images: referenceImages,
      reference_videos: referenceVideos,
      reference_audios: [],
    };

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(3000 * attempt);

      let resp;
      try {
        resp = await this.#fetchWithTimeout(`${this.#base}/api/create`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = new OpenGenError('Could not start video generation. Please try again.');
        console.warn(`[opengen.createTask] network error (attempt ${attempt + 1}/3): ${err?.message ?? err}`);
        continue;
      }

      const txt = await resp.text().catch(() => '');
      let data = null; try { data = JSON.parse(txt); } catch { /* */ }

      if (resp.ok && data?.success && data?.task_id) {
        console.log(`[opengen.createTask] accepted: ${data.task_id} (${referenceImages.length} img, ${referenceVideos.length} vid refs)`);
        return { taskId: data.task_id };
      }

      const code = (() => { try { return JSON.parse(data?.message ?? '')?.error?.code ?? ''; } catch { return ''; } })();
      const msg = data?.message ?? txt;
      console.error(`[opengen.createTask] HTTP ${resp.status} code=${code}: ${txt.slice(0, 500)}`);

      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new OpenGenError('The generation service is busy right now. Please try again in a minute.', { status: resp.status, code, body: txt, blocked: true });
        continue;
      }
      throw new OpenGenError(
        userMessage(code, msg, 'Could not start video generation. Please try again.'),
        { status: resp.status, code, body: txt, blocked: BLOCK_RE.test(txt) },
      );
    }
    throw lastErr ?? new OpenGenError('Could not start video generation. Please try again.');
  }

  // ─── Poll ──────────────────────────────────────────────────────────────────
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
        console.warn(`[opengen.waitForTask] poll request failed (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new OpenGenError('Could not check generation status. Please try again.');
        await sleep(intervalMs); continue;
      }

      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        if (resp.status >= 500 || resp.status === 429) {
          fails += 1;
          console.warn(`[opengen.waitForTask] transient HTTP ${resp.status} (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
          if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new OpenGenError('Could not check generation status. Please try again.', { status: resp.status, body: t });
          await sleep(intervalMs); continue;
        }
        console.error(`[opengen.waitForTask] HTTP ${resp.status}: ${t.slice(0, 300)}`);
        throw new OpenGenError('Could not check generation status. Please try again.', { status: resp.status, body: t });
      }

      fails = 0;
      const data = await resp.json().catch(() => null);
      const task = data?.task ?? data;
      const status = String(task?.status ?? '');
      if (status !== lastStatus) { lastStatus = status; if (onUpdate) onUpdate(status); }

      if (status === 'SUCCESS' || status === 'succeeded') {
        const url = task?.video_url;
        if (!url || !/^https?:\/\//.test(String(url))) {
          throw new OpenGenError('Generation finished but no video URL was returned.', { body: task });
        }
        return { videoUrl: url, raw: task };
      }
      if (status === 'FAILURE' || status === 'failed' || status === 'cancelled' || status === 'canceled') {
        // On FAILURE the server puts the reason in fail_reason AND video_url.
        const rawMsg = task?.fail_reason || (typeof task?.video_url === 'string' && !/^https?:\/\//.test(task.video_url) ? task.video_url : '') || `Generation ${status}.`;
        console.error(`[opengen.waitForTask] ${status}: ${String(rawMsg).slice(0, 400)}`);
        throw new OpenGenError(userMessage('', rawMsg, 'Generation failed. Please try again.'), {
          body: task, blocked: BLOCK_RE.test(String(rawMsg)),
        });
      }
      if (!ACTIVE_STATUSES.has(status)) {
        console.error(`[opengen.waitForTask] unknown status "${status}" for ${taskId}: ${JSON.stringify(task).slice(0, 300)}`);
      }
      await sleep(intervalMs);
    }
    throw new OpenGenError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── Download (streamed to disk) ────────────────────────────────────────────
  // Fresh status fetch — the TOS link is re-signed on every poll, so a stalled
  // or expired download URL can be swapped for a new one.
  async #getTaskUrl(taskId) {
    const resp = await this.#fetchWithTimeout(`${this.#base}/api/status/${taskId}`);
    if (!resp.ok) throw new OpenGenError('Could not re-fetch the result link.', { status: resp.status });
    const data = await resp.json().catch(() => null);
    const task = data?.task ?? data;
    const url = task?.video_url;
    if (/^https?:\/\//.test(String(url))) return url;
    throw new OpenGenError('Result link unavailable.', { body: task });
  }

  // Download with retries: the signed TOS CDN can stall mid-stream (abort) or
  // drop — each attempt re-polls for a fresh URL before streaming again.
  async downloadTaskResult(taskId, { firstUrl = null, attempts = 4, timeoutMs = 300_000 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(4000 * i);
      try {
        const url = (i === 0 && firstUrl) ? firstUrl : await this.#getTaskUrl(taskId);
        return await this.downloadFile(url, { timeoutMs });
      } catch (err) {
        lastErr = err;
        console.warn(`[opengen.downloadTaskResult] attempt ${i + 1}/${attempts} failed: ${err?.message ?? err}`);
      }
    }
    throw lastErr ?? new OpenGenError('Could not download the result file.');
  }

  async downloadFile(url, { timeoutMs = 300_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const filePath = path.join(os.tmpdir(), `ogen-${randomBytes(8).toString('hex')}.mp4`);
    try {
      const resp = await this.#fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new OpenGenError('Could not download the result file.', { status: resp.status });
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

export function classifyOpenGenFailure(err) {
  if (err instanceof OpenGenError) return { blocked: err.blocked, message: err.message };
  return { blocked: false, message: err?.message || 'An unexpected error occurred.' };
}
