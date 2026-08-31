/**
 * upload.satoru.click uploader — hosts over-limit video deliveries and the
 * autobypass reference media.
 *
 * Catbox-compatible API (https://upload.satoru.click/):
 *   POST https://upload.satoru.click/user/api.php  (multipart/form-data)
 *     reqtype="fileupload"   fileToUpload=@file
 *   -> plain-text URL (https://upload.satoru.click/files/xxxxxxxx.ext)
 * No account needed, all formats, 200 MB per file, permanent storage.
 *
 * Verified upstream-reachable: the generation provider's ARK upstream (China)
 * fetches satoru-hosted reference media successfully (litterbox/catbox are
 * unreliable from there — 500s on uploads, ref fetches dropped).
 *
 * Streams from disk — a 100+ MB video never touches the JS heap.
 */
import { multipartUploadFile } from './httputil.js';

const SATORU_API_URL = 'https://upload.satoru.click/user/api.php';
const SATORU_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Upload a local file to upload.satoru.click. Returns the public URL.
 * Throws on failure — callers degrade to their own fallback.
 */
export async function uploadToSatoru(filePath, { filename = 'video.mp4', contentType = 'video/mp4', timeoutMs = 600_000 } = {}) {
  const resp = await multipartUploadFile(globalThis.fetch, SATORU_API_URL, filePath, {
    fieldName: 'fileToUpload',
    contentType,
    filename,
    fields: [{ name: 'reqtype', value: 'fileupload' }],
    timeoutMs,
  });
  const text = (await resp.text().catch(() => '')).trim();
  if (!resp.ok || !/^https:\/\/upload\.satoru\.click\/files\//.test(text)) {
    throw new Error(`satoru HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

export const CATBOX_LIMIT_BYTES = SATORU_MAX_BYTES;
