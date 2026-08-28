/**
 * Memory-safe HTTP file helpers.
 *
 * Everything here streams: a Discord attachment (up to 100 MB) never sits in
 * the JS heap. Downloads go to a temp file on disk; uploads stream from disk
 * with a pre-computed Content-Length so the proxies see byte-identical
 * multipart/raw bodies without ever buffering the file.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Download a URL to a temp file. Returns {path, bytes}. Unlinks on failure. */
export async function fetchToTempFile(fetchImpl, url, { timeoutMs = 120_000, prefix = 'ref' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const filePath = path.join(os.tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}.bin`);
  try {
    const resp = await fetchImpl(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!resp.body) throw new Error('empty response body');
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(filePath));
    const { size } = await stat(filePath);
    return { path: filePath, bytes: size };
  } catch (err) {
    await unlink(filePath).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Stream a file as the body of a raw request (PUT/POST). Caller parses the response. */
export async function sendFileBody(fetchImpl, url, filePath, { method = 'PUT', contentType = 'application/octet-stream', timeoutMs = 120_000, headers = {} } = {}) {
  const { size } = await stat(filePath);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = Readable.toWeb(createReadStream(filePath));
    return await fetchImpl(url, {
      method,
      headers: { ...headers, 'Content-Type': contentType, 'Content-Length': String(size) },
      body,
      duplex: 'half',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream a file as a multipart/form-data body (extra form fields ride before
 * the file). The request never holds the file in memory: fields + boundary are
 * prepended and the trailing boundary appended around a disk stream, with an
 * exact Content-Length.
 */
export async function multipartUploadFile(fetchImpl, url, filePath, { fieldName = 'file', contentType = 'application/octet-stream', filename = 'file.bin', fields = [], timeoutMs = 120_000 } = {}) {
  const boundary = `----yopisora${randomBytes(12).toString('hex')}`;
  const safeName = String(filename).replace(/[\r\n"]/g, '_');

  const parts = [];
  for (const f of fields) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${String(f.name).replace(/[\r\n"]/g, '_')}"\r\n\r\n${String(f.value ?? '')}\r\n`,
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  ));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

  const head = Buffer.concat(parts);
  const { size } = await stat(filePath);
  const contentLength = head.length + size + tail.length;

  const fileStream = createReadStream(filePath);
  const body = Readable.from((async function* () {
    yield head;
    for await (const chunk of fileStream) yield chunk;
    yield tail;
  })());

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(contentLength),
      },
      body: Readable.toWeb(body),
      duplex: 'half',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function safeUnlinkTemp(filePath) {
  if (filePath) await unlink(filePath).catch(() => {});
}
