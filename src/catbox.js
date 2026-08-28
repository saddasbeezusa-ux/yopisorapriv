/**
 * catbox.moe uploader — fallback delivery for videos over the Discord upload
 * limit.
 *
 * API (https://catbox.moe/tools.php):
 *   POST https://catbox.moe/user/api.php   (multipart/form-data)
 *     reqtype="fileupload"   [userhash]   fileToUpload=@file
 *   -> plain-text URL (https://files.catbox.moe/xxxxxxxx.ext)
 * Anonymous uploads need no userhash. 200 MB per-file cap.
 *
 * Streams from disk — a 100+ MB video never touches the JS heap.
 */
import { multipartUploadFile } from './httputil.js';

const CATBOX_API_URL = 'https://catbox.moe/user/api.php';
const CATBOX_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Upload a local file to catbox.moe anonymously. Returns the public URL.
 * Throws on failure — callers degrade to their own fallback.
 */
export async function uploadToCatbox(filePath, { filename = 'video.mp4', contentType = 'video/mp4', timeoutMs = 600_000 } = {}) {
  const resp = await multipartUploadFile(globalThis.fetch, CATBOX_API_URL, filePath, {
    fieldName: 'fileToUpload',
    contentType,
    filename,
    fields: [{ name: 'reqtype', value: 'fileupload' }],
    timeoutMs,
  });
  const text = (await resp.text().catch(() => '')).trim();
  if (!resp.ok || !/^https:\/\/files\.catbox\.moe\//.test(text)) {
    throw new Error(`catbox HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

export const CATBOX_LIMIT_BYTES = CATBOX_MAX_BYTES;
