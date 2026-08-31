/**
 * pone.rs uploader — hosts over-limit video deliveries and the autobypass
 * reference media.
 *
 * API (https://pone.rs/api.html):
 *   POST https://pone.rs/upload   (multipart/form-data, field "files[]")
 *   -> JSON {success, files:[{url}]}  |  ?output=text -> plain-text URL
 * URLs come back as https://u.pone.rs/<name>. No account needed.
 *
 * Verified upstream-reachable: the generation provider's ARK upstream (China)
 * fetches pone-hosted reference media successfully (Discord CDN is GFW-blocked,
 * litterbox 500s from Railway).
 *
 * Streams from disk — a 100+ MB video never touches the JS heap.
 */
import { multipartUploadFile } from './httputil.js';

const PONE_API_URL = 'https://pone.rs/upload?output=text';
const PONE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Upload a local file to pone.rs. Returns the public URL (https://u.pone.rs/…).
 * Throws on failure — callers degrade to their own fallback.
 */
export async function uploadToPone(filePath, { filename = 'video.mp4', contentType = 'video/mp4', timeoutMs = 600_000 } = {}) {
  const resp = await multipartUploadFile(globalThis.fetch, PONE_API_URL, filePath, {
    fieldName: 'files[]',
    contentType,
    filename,
    fields: [],
    timeoutMs,
  });
  const text = (await resp.text().catch(() => '')).trim();
  if (!resp.ok || !/^https:\/\/u\.pone\.rs\//.test(text)) {
    throw new Error(`pone HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

export const CATBOX_LIMIT_BYTES = PONE_MAX_BYTES;
