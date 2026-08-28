/**
 * Doubao Seedance video via Volcengine ARK.
 *
 * Async task flow:
 *   1. POST /contents/generations/tasks  { model, content:[{text}, {image_url}, {video_url}] } -> task id
 *   2. GET  /contents/generations/tasks/{id}  until status succeeded / failed
 *   3. Download the mp4 from content.video_url (a signed TOS URL, valid ~24h)
 *
 * Generation params ride as text commands on the prompt, the Volcengine way:
 *   "<prompt> --resolution 480p --ratio 16:9 --duration 30 --watermark false"
 * Reference images/videos are public URLs (Discord attachment URLs work directly).
 */
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedance-2-5-260628';

export const ARK_MODEL = DEFAULT_MODEL;

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000; // 20 min
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

// Moderation / policy rejections -> amber "blocked" rather than red "error".
const BLOCK_RE = /sensitive|privacy|real person|policy|violat|prohibit|nsfw|copyright|infring\w*|ip\s*infring|risk|illegal|moderat|inappropriate/i;

export class ArkError extends Error {
  constructor(message, { status, code, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'ArkError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.blocked = Boolean(blocked);
    this.timedOut = Boolean(timedOut);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userMessage(code, msg, fallback) {
  const m = (msg || '').trim();
  if (!m || m.length > 300) return fallback;
  // Keep specific, useful reasons (e.g. "may contain real person") but never
  // surface anything that names the backend provider.
  if (/volcengine|doubao|\bark\b|seedream|火山|方舟/i.test(m)) return fallback;
  return m.replace(/\s*Request id:.*$/i, '');
}

export class ArkClient {
  #key;
  #base;
  #model;
  #fetch;

  constructor({ apiKey, baseUrl, model, fetchImpl } = {}) {
    this.#key = apiKey ?? process.env.ARK_API_KEY;
    this.#base = (baseUrl ?? process.env.ARK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#model = model ?? DEFAULT_MODEL;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    if (!this.#key) throw new ArkError('ARK_API_KEY is not set.');
  }

  async #fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await this.#fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  #headers() {
    return { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json' };
  }

  // ─── Create task ───────────────────────────────────────────────────────────
  async createTask({ prompt, duration, resolution, ratio, references = [] }) {
    const text = `${prompt} --resolution ${resolution} --ratio ${ratio} --duration ${duration} --watermark false`;
    const content = [{ type: 'text', text }];
    for (const r of references) {
      if (r.type === 'video') content.push({ type: 'video_url', video_url: { url: r.url }, role: 'reference_video' });
      else content.push({ type: 'image_url', image_url: { url: r.url }, role: 'reference_image' });
    }
    const body = { model: this.#model, content };

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(3000 * attempt);

      let resp;
      try {
        resp = await this.#fetchWithTimeout(`${this.#base}/contents/generations/tasks`, {
          method: 'POST', headers: this.#headers(), body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = new ArkError('Could not start video generation. Please try again.');
        console.warn(`[ark.createTask] network error (attempt ${attempt + 1}/3): ${err?.message ?? err}`);
        continue;
      }

      const txt = await resp.text().catch(() => '');
      let data = null; try { data = JSON.parse(txt); } catch { /* */ }

      if (resp.ok && data?.id) return { taskId: data.id };

      const code = data?.error?.code || data?.code || '';
      const msg = data?.error?.message || data?.message || '';
      console.error(`[ark.createTask] HTTP ${resp.status} code=${code}: ${txt.slice(0, 500)}`);

      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new ArkError('The generation service is busy right now. Please try again in a minute.', { status: resp.status, code, body: txt, blocked: true });
        continue;
      }
      throw new ArkError(
        userMessage(code, msg, 'Could not start video generation. Please try again.'),
        { status: resp.status, code, body: txt, blocked: BLOCK_RE.test(`${code} ${msg}`) },
      );
    }
    throw lastErr ?? new ArkError('Could not start video generation. Please try again.');
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
        resp = await this.#fetchWithTimeout(`${this.#base}/contents/generations/tasks/${taskId}`, { headers: this.#headers() });
      } catch (err) {
        fails += 1;
        console.warn(`[ark.waitForTask] poll request failed (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new ArkError('Could not check generation status. Please try again.');
        await sleep(intervalMs); continue;
      }

      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        if (resp.status >= 500 || resp.status === 429) {
          fails += 1;
          console.warn(`[ark.waitForTask] transient HTTP ${resp.status} (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
          if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new ArkError('Could not check generation status. Please try again.', { status: resp.status, body: t });
          await sleep(intervalMs); continue;
        }
        console.error(`[ark.waitForTask] HTTP ${resp.status}: ${t.slice(0, 300)}`);
        throw new ArkError('Could not check generation status. Please try again.', { status: resp.status, body: t });
      }

      fails = 0;
      const data = await resp.json();
      const status = data.status;
      if (status !== lastStatus) { lastStatus = status; if (onUpdate) onUpdate(status); }

      if (status === 'succeeded') {
        const url = data.content?.video_url;
        if (!url) throw new ArkError('Generation finished but no video URL was returned.', { body: data });
        return { videoUrl: url, raw: data };
      }
      if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
        const code = data.error?.code || '';
        const msg = data.error?.message || `Generation ${status}.`;
        console.error(`[ark.waitForTask] ${status} code=${code}: ${msg}`);
        throw new ArkError(userMessage(code, msg, 'Generation failed. Please try again.'), { code, body: data, blocked: BLOCK_RE.test(`${code} ${msg}`) });
      }
      await sleep(intervalMs);
    }
    throw new ArkError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── Download (streamed to disk) ────────────────────────────────────────────
  async downloadFile(url, { timeoutMs = 180_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const filePath = path.join(os.tmpdir(), `ark-${randomBytes(8).toString('hex')}.mp4`);
    try {
      const resp = await this.#fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new ArkError('Could not download the result file.', { status: resp.status });
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

export function classifyArkFailure(err) {
  if (err instanceof ArkError) return { blocked: err.blocked, message: err.message };
  return { blocked: false, message: err?.message || 'An unexpected error occurred.' };
}
