/**
 * Litterbox (catbox.moe temporary host) uploader — used for over-limit video
 * delivery and hosting the autobypass intro reference clip.
 *
 * Railway/IP ranges get 412 "Invalid uploader" from catbox.moe's main API, but
 * Litterbox accepts anonymous uploads from anywhere.
 *
 * API (https://litterbox.catbox.moe/tools.php):
 *   POST https://litterbox.catbox.moe/resources/internals/api.php
 *     reqtype="fileupload"  time="1h|12h|24h|72h"  fileToUpload=@file
 *   -> plain-text URL (https://litter.catbox.moe/xxxxxxxx.ext)
 * No account/userhash. Files auto-expire after the chosen retention window
 * (72h = 3 days).
 *
 * Streams from disk — a 100+ MB video never touches the JS heap.
 */
import { multipartUploadFile } from './httputil.js';

const LITTERBOX_API_URL = 'https://litterbox.catbox.moe/resources/internals/api.php';
const LITTERBOX_MAX_BYTES = 200 * 1024 * 1024;
const LITTERBOX_RETENTION = '72h';

/**
 * Upload a local file to Litterbox anonymously (72h retention). Returns the
 * public URL. Throws on failure — callers degrade to their own fallback.
 */
export async function uploadToLitterbox(filePath, { filename = 'video.mp4', contentType = 'video/mp4', timeoutMs = 600_000 } = {}) {
  const resp = await multipartUploadFile(globalThis.fetch, LITTERBOX_API_URL, filePath, {
    fieldName: 'fileToUpload',
    contentType,
    filename,
    fields: [
      { name: 'reqtype', value: 'fileupload' },
      { name: 'time', value: LITTERBOX_RETENTION },
    ],
    timeoutMs,
  });
  const text = (await resp.text().catch(() => '')).trim();
  if (!resp.ok || !/^https:\/\/litter\.catbox\.moe\//.test(text)) {
    throw new Error(`litterbox HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

export const CATBOX_LIMIT_BYTES = LITTERBOX_MAX_BYTES;
