/**
 * Seedance video via AI Studio (124.174.38.110) — vid2 route.
 *
 * The box serves self-signed TLS, so requests go through node:https with
 * verification disabled for this host only.
 *
 * Flow (keyless, verified 2026-08-31):
 *   1. POST /api/vod/aigc/video  (flat newapi style + raw ARK content array)
 *        { ModelName, ModelVersion, Prompt, content:[{text},{image_url},{video_url}],
 *          Duration, AspectRatio, Resolution, AudioGeneration }
 *      -> {"TaskId":"napi:vid2:task_XXXXXXXX"}
 *   2. GET /api/vod/task?taskId=<urlencoded TaskId>
 *        -> {AigcVideoTask:{Status:"PROCESSING"|"FINISH", Progress,
 *            Output:{FileInfos:[{FileUrl (their fast VOD copy), SrcUrl (TOS, 24h)}]}}}
 *   3. Stream-download (FileUrl preferred — their Tencent VOD mirror is fast)
 *
 * Server facts (from the recon docs):
 *   - Seedance 2.5: 4-30s, 480P/720P only (uppercase P), ratios + "adaptive"
 *   - refs ride as public URLs (any reachable image/video URL works)
 *   - upstream violations surface through the task status/error fields
 */
import { createWriteStream } from 'node:fs';
import { unlink, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://124.174.38.110';
const MODEL_25 = { name: 'doubao-seedance-2-5', version: '260628' };
const MODEL_20 = { name: 'doubao-seedance-2-0', version: '260128' };

export const AISTUDIO_MODEL_25 = 'doubao-seedance-2-5-260628';
export const AISTUDIO_MODEL_20 = 'doubao-seedance-2-0-260128';

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_VIDEO_TIMEOUT_MS = 1_200_000; // 20 min
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const ACTIVE_STATUSES = new Set(['PROCESSING', 'PENDING', 'QUEUED', 'RUNNING']);

// Moderation / policy rejections -> amber "blocked" rather than red "error".
const BLOCK_RE = /sensitive|privacy|real person|policy|violat|prohibit|nsfw|copyright|infring\w*|ip\s*infring|risk|illegal|moderat|inappropriate/i;

export class AiStudioError extends Error {
  constructor(message, { status, code, body, blocked, timedOut } = {}) {
    super(message);
    this.name = 'AiStudioError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.blocked = Boolean(blocked);
    this.timedOut = Boolean(timedOut);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Never surface anything that names the backend or leaks upstream account ids.
function userMessage(raw, fallback) {
  let msg = String(raw ?? '').trim();
  if (!msg || msg.length > 300) return fallback;
  if (/124\.174|doubao|volces|volcengine|\bark\b|tos-cn-beijing|火山|account \d{6,}/i.test(msg)) return fallback;
  return msg.replace(/\s*Request id:.*$/i, '').trim() || fallback;
}

// Minimal https JSON client with TLS verification disabled for this host.
function httpsJson(url, { method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class AiStudioClient {
  #base;
  #model;
  #fetch;

  constructor({ baseUrl, model, fetchImpl } = {}) {
    this.#base = (baseUrl ?? process.env.AISTUDIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#model = model ?? MODEL_25;
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  // ─── Create task ───────────────────────────────────────────────────────────
  // references: [{ type: 'video'|'image', url }] — public URLs only.
  async createTask({ prompt, duration, resolution = '480P', ratio, references = [] }) {
    const content = [{ type: 'text', text: prompt }];
    for (const r of references) {
      if (r.type === 'video') content.push({ type: 'video_url', video_url: { url: r.url }, role: 'reference_video' });
      else content.push({ type: 'image_url', image_url: { url: r.url }, role: 'reference_image' });
    }

    // The route IGNORES the flat Duration/Resolution/AspectRatio params (verified
    // live: flat-only 30s t2v still returns 5s). The nested OutputConfig wrapper
    // is what actually carries them — verified 30.08s @ 854x480 through it.
    const body = {
      ModelName: this.#model.name,
      ModelVersion: this.#model.version,
      Prompt: prompt,
      content,
      OutputConfig: {
        StorageMode: 'Permanent',
        Duration: Number(duration),
        Resolution: String(resolution).toUpperCase(),
        AspectRatio: String(ratio),
        AudioGeneration: 'Enabled',
      },
    };

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(3000 * attempt);

      let resp;
      try {
        resp = await httpsJson(`${this.#base}/api/vod/aigc/video`, { method: 'POST', body });
      } catch (err) {
        lastErr = new AiStudioError('Could not start video generation. Please try again.');
        console.warn(`[aistudio.createTask] network error (attempt ${attempt + 1}/3): ${err?.message ?? err}`);
        continue;
      }

      let data = null; try { data = JSON.parse(resp.text); } catch { /* */ }

      if (resp.status === 200 && data?.TaskId) {
        console.log(`[aistudio.createTask] accepted: ${data.TaskId} (${references.filter((r) => r.type === 'image').length} img, ${references.filter((r) => r.type === 'video').length} vid refs, ${body.OutputConfig.Duration}s ${body.OutputConfig.Resolution})`);
        return { taskId: data.TaskId };
      }

      const rawMsg = data?.error ?? data?.message ?? resp.text;
      console.error(`[aistudio.createTask] HTTP ${resp.status}: ${resp.text.slice(0, 500)}`);
      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new AiStudioError('The generation service is busy right now. Please try again in a minute.', { status: resp.status, body: resp.text, blocked: true });
        continue;
      }
      throw new AiStudioError(
        userMessage(rawMsg, 'Could not start video generation. Please try again.'),
        { status: resp.status, body: resp.text, blocked: BLOCK_RE.test(resp.text) },
      );
    }
    throw lastErr ?? new AiStudioError('Could not start video generation. Please try again.');
  }

  // ─── Poll ──────────────────────────────────────────────────────────────────
  async #pollOnce(taskId) {
    const url = `${this.#base}/api/vod/task?taskId=${encodeURIComponent(taskId)}`;
    const resp = await httpsJson(url);
    if (resp.status !== 200) {
      throw Object.assign(new Error(`HTTP ${resp.status}`), { httpStatus: resp.status, body: resp.text });
    }
    const data = JSON.parse(resp.text);
    return data?.AigcVideoTask ?? null;
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
        console.warn(`[aistudio.waitForTask] poll request failed (${fails}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${err?.message ?? err}`);
        if (fails >= MAX_CONSECUTIVE_POLL_FAILURES) throw new AiStudioError('Could not check generation status. Please try again.');
        await sleep(intervalMs); continue;
      }

      const status = String(task?.Status ?? '');
      if (status !== lastStatus) { lastStatus = status; if (onUpdate) onUpdate(status); }

      // Violations surface as Status FAIL with the reason in Message and a
      // machine code in ErrCodeExt (e.g. OutputVideoSensitiveContentDetected.PolicyViolation).
      const rawMsg = task?.Message ?? task?.ErrorMessage ?? task?.FailReason ?? task?.Error ?? '';
      const codeExt = task?.ErrCodeExt ?? task?.ErrCode ?? '';

      if (status === 'FINISH') {
        const files = task?.Output?.FileInfos ?? [];
        if (!files.length) {
          console.error(`[aistudio.waitForTask] FINISH with no files: ${String(rawMsg || JSON.stringify(task)).slice(0, 400)}`);
          throw new AiStudioError(userMessage(rawMsg, 'Generation failed. Please try again.'), {
            body: task, blocked: BLOCK_RE.test(`${rawMsg} ${codeExt}`),
          });
        }
        // Prefer their Tencent VOD copy (fast) over the signed TOS original.
        const url = files[0]?.FileUrl || files[0]?.SrcUrl;
        if (!url) throw new AiStudioError('Generation finished but no video URL was returned.', { body: task });
        return { videoUrl: url, raw: task };
      }
      if (!ACTIVE_STATUSES.has(status) && status) {
        console.error(`[aistudio.waitForTask] task ${taskId} status ${status}: ${String(rawMsg || JSON.stringify(task)).slice(0, 400)}`);
        throw new AiStudioError(userMessage(rawMsg, 'Generation failed. Please try again.'), {
          body: task, blocked: BLOCK_RE.test(`${rawMsg} ${codeExt}`),
        });
      }
      await sleep(intervalMs);
    }
    throw new AiStudioError(`Generation timed out after ${timeoutMinutes} minutes.`, { timedOut: true });
  }

  // ─── Download (streamed to disk, with fresh-URL retries) ────────────────────
  async #getResultUrl(taskId) {
    const task = await this.#pollOnce(taskId);
    const files = task?.Output?.FileInfos ?? [];
    const url = files[0]?.FileUrl || files[0]?.SrcUrl;
    if (/^https?:\/\//.test(String(url))) return url;
    throw new AiStudioError('Result link unavailable.', { body: task });
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
        console.warn(`[aistudio.downloadTaskResult] attempt ${i + 1}/${attempts} failed: ${err?.message ?? err}`);
      }
    }
    throw lastErr ?? new AiStudioError('Could not download the result file.');
  }

  async downloadFile(url, { timeoutMs = 300_000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const filePath = path.join(os.tmpdir(), `aistudio-${randomBytes(8).toString('hex')}.mp4`);
    try {
      const resp = await this.#fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new AiStudioError('Could not download the result file.', { status: resp.status });
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

export function classifyAiStudioFailure(err) {
  if (err instanceof AiStudioError) return { blocked: err.blocked, message: err.message };
  return { blocked: false, message: err?.message || 'An unexpected error occurred.' };
}
