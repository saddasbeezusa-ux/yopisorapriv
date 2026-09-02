/**
 * Doubao Seedance video via the AI 短剧工作台 site (101.133.136.15, "glimwork").
 *
 * The box serves a self-signed cert (CN=glimwork.com) — requests go through
 * node:https with verification disabled for this host only.
 *
 * Auth: static admin key (GLIM_API_KEY) as Bearer on every call.
 *
 * Flow (verified live 2026-09-03):
 *   1. POST /api/generate/video
 *        { prompt: "[写实] ...",            <- first line MUST be a style tag
 *          model: "doubao-seedance-2-5-260628",
 *          duration, ratio, resolution,
 *          images: [url, ...],              <- reference images (verified: tomato render)
 *          content: [ {type:"text", text},  <- raw ARK content passthrough (the
 *                     {type:"video_url"...}   site forwards this verbatim to ARK —
 *                     ...],                   verified: unreachable ref URL errors upstream)
 *          generate_audio: true, watermark: false, return_last_frame: false }
 *      -> {"task_id":"8d3a4f62","status":"pending"}
 *   2. GET /api/generate/status/{task_id}
 *        status: pending -> processing -> completed | failed
 *        completed -> result.url (site-hosted, needs Bearer) + result.remoteUrl
 *                     (signed TOS, 24h) + result.last_frame_url
 *   3. Download result.url (with Bearer) or remoteUrl
 *
 * Facts:
 *   - reference videos ride as reference_video (MOTION reference semantics — a
 *     static clip transfers nothing; the intro timing/look comes from the prompt)
 *   - 1.9s padded ref clips are accepted; 30s durations work
 *   - output is ALWAYS 1920x1080 regardless of the resolution param
 */
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://101.133.136.15';
const DEFAULT_MODEL = 'doubao-seedance-2-5-260628';
const STYLE_TAG = '[写实]';

export const GLIM_MODEL = DEFAULT_MODEL;

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_500_000; // 25 min (30s 1080p renders run long)
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const ACTIVE_STATUSES = new Set(['pending', 'processing', 'queued', 'running']);

// Moderation / policy rejections -> amber "blocked" rather than red "error".
const BLOCK_RE = /sensitive|privacy|real person|policy|violat|prohibit|nsfw|copyright|infring\w*|ip\s*infring|risk|illegal|moderat|inappropriate/i;

export class GlimError extends Error {
  constructor(message, { status, code, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'GlimError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.blocked = Boolean(blocked);
    this.timedOut = Boolean(timedOut);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Never surface anything that names the backend or leaks host/ids.
function userMessage(raw, fallback) {
  let msg = String(raw ?? '').trim();
  if (msg.startsWith('{') || msg.startsWith('Error code:')) {
    const inner = msg.match(/\{[\s\S]*\}/);
    if (inner) {
      try {
        const parsed = JSON.parse(inner[0].replace(/'/g, '"'));
        msg = parsed?.error?.message || parsed?.message || msg;
      } catch { /* keep raw */ }
    }
  }
  msg = msg.trim();
  if (!msg || msg.length > 300) return fallback;
  if (/101\.133|doubao|volces|volcengine|\bark\b|tos-cn-beijing|火山|glimwork|Request id/i.test(msg)) {
    return fallback;
  }
  return msg.replace(/\s*Request id:.*$/i, '').trim() || fallback;
}

// Self-signed host — TLS verification disabled for this box only.
function httpsJson(url, { method = 'GET', body = null, token = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = https.request({
      hostname: target.hostname, port: 443, path: `${target.pathname}${target.search}`,
      method, rejectUnauthorized: false, timeout: timeoutMs, headers,
    }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('request timed out')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

export class GlimClient {
  #base;
  #model;
  #key;
  #fetch;

  constructor({ baseUrl, model, apiKey, fetchImpl } = {}) {
    this.#base = (baseUrl ?? process.env.GLIM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#model = model ?? DEFAULT_MODEL;
    this.#key = apiKey ?? process.env.GLIM_API_KEY;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    if (!this.#key) throw new GlimError('GLIM_API_KEY is not set.');
  }

  // ─── Create task ───────────────────────────────────────────────────────────
  // references: [{ type: 'video'|'image', url }] — public URLs (pone.rs).
  async createTask({ prompt, duration, resolution = '480P', ratio, references = [] }) {
    const styled = prompt.startsWith(STYLE_TAG) ? prompt : `${STYLE_TAG} ${prompt}`;
    const content = [{ type: 'text', text: styled }];
    const images = [];
    for (const r of references) {
      if (r.type === 'video') {
        content.push({ type: 'video_url', video_url: { url: r.url }, role: 'reference_video' });
      } else {
        images.push(r.url);
        content.push({ type: 'image_url', image_url: { url: r.url }, role: 'reference_image' });
      }
    }

    const body = {
      prompt: styled,
      model: this.#model,
      duration: Number(duration),
      ratio: String(ratio),
      resolution: String(resolution),
      images,
      content,
      generate_audio: true,
      watermark: false,
      return_last_frame: false,
    };

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(3000 * attempt);

      let resp;
      try {
        resp = await httpsJson(`${this.#base}/api/generate/video`, { method: 'POST', body, token: this.#key });
      } catch (err) {
        lastErr = new GlimError('Could not start video generation. Please try again.');
        console.warn(`[glim.createTask] network error (attempt ${attempt + 1}/3): ${err?.message ?? err}`);
        continue;
      }

      let data = null; try { data = JSON.parse(resp.text); } catch { /* */ }

      if (resp.status === 200 && data?.task_id) {
        console.log(`[glim.createTask] accepted: ${data.task_id} (${images.length} img, ${references.filter((r) => r.type === 'video').length} vid refs, ${body.duration}s)`);
        return { taskId: data.task_id };
      }

      const rawMsg = data?.error ?? resp.text;
      console.error(`[glim.createTask] HTTP ${resp.status}: ${resp.text.slice(0, 500)}`);
      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new GlimError('The generation service is busy right now. Please try again in a minute.', { status: resp.status, body: resp.text, blocked: true });
        continue;
      }
      throw new GlimError(
        userMessage(rawMsg, 'Could not start video generation. Please try again.'),
        { status: resp.status, body: resp.text, blocked: BLOCK_RE.test(resp.text) },
      );
    }
    throw lastErr ?? new GlimError('Could not start video generation. Please try again.');
  }

  // ─── Poll ──────────────────────────────────────────────────────────────────
  async #pollOnce(taskId) {
    const resp = await httpsJson(`${this.#base}/api/generate/status/${encodeURIComponent(taskId)}`, { token: this.#key });
    if (resp.status !== 200) {
      throw Object.assign(new Error(`HTTP ${resp.status}`), { httpStatus: resp.status, body: resp.text });
    }
    return JSON.parse(resp.text);
  }

  async waitForTask(taskId, { intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_VIDEO_TIMEOUT_MS, onUpdate } = {}) {
    const deadline = Date.now() + timeoutMs;
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    let lastStatus = null;
    let fails = 0;

    while (Date.now() < deadline) {
      let task = null;
      try {
        task = await this.#pollOnce(taskId);
        fails = 0;
      } catch (err) {
        fails += 1;
        console.warn(`[glim.waitForTask] poll request failed (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new GlimError('Could not check generation status. Please try again.');
        await sleep(intervalMs); continue;
      }

      const status = String(task?.status ?? '');
      if (status !== lastStatus) { lastStatus = status; if (onUpdate) onUpdate(status); }

      if (status === 'completed') {
        const url = task?.result?.url
          ? `${this.#base}${task.result.url}`
          : task?.result?.remoteUrl;
        if (!url) throw new GlimError('Generation finished but no video URL was returned.', { body: task });
        return { videoUrl: url, raw: task };
      }
      if (status === 'failed') {
        const rawMsg = task?.error ?? 'Generation failed.';
        console.error(`[glim.waitForTask] task ${taskId} failed: ${String(rawMsg).slice(0, 400)}`);
        // This backend collapses ARK moderation failures into a bare
        // "视频生成失败" (video generation failed) — treat that generic string
        // as a content violation (copyright/safety blocks always land here).
        const generic = /^视频生成失败/.test(String(rawMsg).trim());
        throw new GlimError(userMessage(rawMsg, 'Generation failed. Please try again.'), {
          body: task,
          blocked: generic || BLOCK_RE.test(String(rawMsg)),
        });
      }
      if (!ACTIVE_STATUSES.has(status) && status) {
        console.error(`[glim.waitForTask] unknown status "${status}" for ${taskId}: ${JSON.stringify(task).slice(0, 300)}`);
      }
      await sleep(intervalMs);
    }
    throw new GlimError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── Download (streamed to disk, with fresh-URL retries) ────────────────────
  async #getResultUrl(taskId) {
    const task = await this.#pollOnce(taskId);
    const url = task?.result?.url
      ? `${this.#base}${task.result.url}`
      : task?.result?.remoteUrl;
    if (url) return url;
    throw new GlimError('Result link unavailable.', { body: task });
  }

  async downloadTaskResult(taskId, { firstUrl = null, attempts = 4, timeoutMs = 300_000 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(4000 * i);
      try {
        const url = (i === 0 && firstUrl) ? firstUrl : await this.#getResultUrl(taskId);
        return await this.downloadFile(url, { timeoutMs });
      } catch (err) {
        lastErr = err;
        console.warn(`[glim.downloadTaskResult] attempt ${i + 1}/${attempts} failed: ${err?.message ?? err}`);
      }
    }
    throw lastErr ?? new GlimError('Could not download the result file.');
  }

  // result.url is site-hosted (self-signed TLS + Bearer auth); remoteUrl (TOS)
  // is open. Both stream through node:https — global fetch rejects the cert.
  async downloadFile(url, { timeoutMs = 300_000 } = {}) {
    const needsAuth = url.startsWith(this.#base);
    const filePath = path.join(os.tmpdir(), `glim-${randomBytes(8).toString('hex')}.mp4`);
    const target = new URL(url);
    try {
      await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: target.hostname, port: 443, path: `${target.pathname}${target.search}`,
          method: 'GET', rejectUnauthorized: false, timeout: timeoutMs,
          headers: needsAuth ? { Authorization: `Bearer ${this.#key}` } : {},
        }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new GlimError('Could not download the result file.', { status: res.statusCode }));
            return;
          }
          const ws = createWriteStream(filePath);
          res.on('data', (c) => ws.write(c));
          res.on('end', () => ws.end(() => resolve()));
          res.on('error', reject);
        });
        r.on('timeout', () => r.destroy(new Error('download timed out')));
        r.on('error', reject);
        r.end();
      });
      const { size } = await stat(filePath);
      return { path: filePath, bytes: size, contentType: 'video/mp4' };
    } catch (err) {
      await unlink(filePath).catch(() => {});
      throw err;
    }
  }
}

export function classifyGlimFailure(err) {
  if (err instanceof GlimError) return { blocked: err.blocked, message: err.message };
  return { blocked: false, message: err?.message || 'An unexpected error occurred.' };
}
