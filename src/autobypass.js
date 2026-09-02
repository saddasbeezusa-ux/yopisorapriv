/**
 * ffmpeg helpers for /autobypass: find where the intro ends (the still X-frame
 * intro, then the hard cut into the real scene) and trim the video to start
 * there.
 *
 * Primary method: ffmpeg scene-change scores — the template renders as a still
 * reference frame for ~0.5s followed by an instant cut, which shows up as one
 * huge scene score right after the opening. Fallback: the old luminance-track
 * heuristic (black gap / fade intros from earlier templates).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import staticFFmpeg from 'ffmpeg-static';

const pExecFile = promisify(execFile);

const FFMPEG_BIN = process.env.FFMPEG_PATH || staticFFmpeg || 'ffmpeg';

export class AutoBypassError extends Error {
  constructor(message, { blocked = false } = {}) {
    super(message);
    this.name = 'AutoBypassError';
    this.blocked = blocked;
  }
}

async function ffRun(args, { timeoutMs = 180_000 } = {}) {
  try {
    return await pExecFile(FFMPEG_BIN, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new AutoBypassError('ffmpeg is not installed on the host.');
    }
    throw new AutoBypassError(`ffmpeg step failed: ${err?.message ?? err}`);
  }
}

async function lumaTrack(file, maxSeconds = 20) {
  const args = [
    '-hide_banner', '-nostats',
    '-t', String(maxSeconds),
    '-i', file,
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ];
  const { stderr } = await ffRun(args);
  const track = [];
  let t = null;
  for (const line of stderr.split(/\r?\n/)) {
    const tm = line.match(/pts_time:([0-9.]+)/);
    if (tm) { t = Number(tm[1]); continue; }
    const ym = line.match(/YAVG=([0-9.]+)/);
    if (ym && t !== null) { track.push([t, Number(ym[1])]); t = null; }
  }
  return track;
}

function firstSustainedContent(track, { lo, hi, windowSec }) {
  for (let i = 0; i < track.length; i++) {
    const [t0, y0] = track[i];
    if (y0 <= lo || y0 >= hi) continue;
    let ok = true;
    for (let j = i + 1; j < track.length; j++) {
      const [tj, yj] = track[j];
      if (tj - t0 > windowSec) break;
      if (yj <= lo || yj >= hi) { ok = false; break; }
    }
    if (ok) return t0;
  }
  return null;
}

// Frame-to-frame scene-change scores (0..1) with timestamps.
async function sceneScoreTrack(file, maxSeconds = 20) {
  const args = [
    '-hide_banner', '-nostats',
    '-t', String(maxSeconds),
    '-i', file,
    '-vf', "select='gt(scene,0)',metadata=print:key=lavfi.scene_score",
    '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ];
  const { stderr } = await ffRun(args);
  const track = [];
  let t = null;
  for (const line of stderr.split(/\r?\n/)) {
    const tm = line.match(/pts_time:([0-9.]+)/);
    if (tm) { t = Number(tm[1]); continue; }
    const sm = line.match(/lavfi\.scene_score=([0-9.]+)/);
    if (sm && t !== null) { track.push([t, Number(sm[1])]); t = null; }
  }
  return track;
}

// Mean luminance in the window after a timestamp — used to tell a cut that
// lands into real content apart from one that lands into the black gap.
function meanYAfter(track, t, windowSec = 0.35) {
  const ys = track.filter(([tt]) => tt >= t && tt <= t + windowSec).map(([, y]) => y);
  if (!ys.length) return null;
  return ys.reduce((a, b) => a + b, 0) / ys.length;
}

export async function analyzeVideo(file, { maxSeconds = 20 } = {}) {
  const track = await lumaTrack(file, maxSeconds);
  if (!track.length) return { sceneStart: null, method: 'no-data' };

  // Primary: a hard scene cut that lands into actual content (the still-frame
  // intro shape). The video-reference template also produces a huge score where
  // the mask cuts to the black gap — that one lands into blackness, so it is
  // rejected here and the luma pass below finds the real cut after the gap.
  try {
    const scores = await sceneScoreTrack(file, maxSeconds);
    for (const threshold of [0.3, 0.2]) {
      for (const [t, score] of scores) {
        if (t > 5.0) break;
        if (score < threshold) continue;
        const after = meanYAfter(track, t + 0.05);
        if (after !== null && after > 35) return { sceneStart: t, method: `scene-cut(${score.toFixed(2)})` };
      }
    }
  } catch (err) {
    console.warn(`[autobypass] scene-score pass failed, falling back to luma: ${err?.message ?? err}`);
  }

  let start = firstSustainedContent(track, { lo: 35, hi: 170, windowSec: 0.5 });
  let method = 'strict';
  if (start === null) {
    start = firstSustainedContent(track, { lo: 35, hi: 190, windowSec: 0.5 });
    method = 'wide';
  }
  if (start === null) {
    // Fall back to the last black frame in the opening window (fade-out tail).
    let lastBlack = null;
    for (const [t, y] of track) {
      if (y <= 35 && t < 3.0) lastBlack = t;
    }
    if (lastBlack !== null) { start = lastBlack; method = 'black-tail'; }
  }
  return { sceneStart: start, method };
}

export async function trimVideo(file, sceneStart) {
  const out = join(tmpdir(), `ab-trim-${randomBytes(8).toString('hex')}.mp4`);
  // Thread caps: '-threads N' before -i caps DECODE only; the x264 ENCODER
  // spawns its own pool (34 threads on multi-core hosts) unless capped via
  // x264-params. 10-bit HEVC 1080p inputs encode High10 — 34 encoder threads
  // blew the 1GB container and the kernel killed ffmpeg mid-encode.
  const args = [
    '-y', '-hide_banner', '-nostats',
    '-threads', '2',
    '-ss', String(Math.max(0, sceneStart)),
    '-i', file,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-x264-params', 'threads=2:lookahead_threads=1',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    out,
  ];
  await ffRun(args, { timeoutMs: 300_000 });
  return out;
}

export async function probeDurationSeconds(file) {
  try {
    await pExecFile(FFMPEG_BIN, ['-hide_banner', '-nostats', '-i', file], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
  }
  return null;
}

async function probeFps(file) {
  try {
    const { stdout } = await pExecFile(FFMPEG_BIN, [
      '-hide_banner', '-nostats', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file,
    ], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    const m = String(stdout).trim().match(/^(\d+)\/(\d+)$/);
    if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  } catch { /* fall through */ }
  return null;
}

/**
 * Normalize the intro clip for the provider's r2v limits: reference videos must
 * be >= 1.8s and <= 60fps. The stock clip is 1.35s @ 120fps, so it gets padded
 * with black tail frames (the mask timing lives at the start) and capped at
 * 30fps. Returns the original path when it already conforms.
 */
export async function ensureMinDuration(file, minDuration = 1.8) {
  const duration = await probeDurationSeconds(file);
  const fps = await probeFps(file);
  const needsPad = duration === null || duration < minDuration;
  const needsFps = fps === null || fps > 60;
  if (!needsPad && !needsFps) return file;

  const pad = needsPad && duration !== null ? Math.max(0.05, minDuration - duration) : 0;
  const filters = [];
  if (pad > 0) filters.push(`tpad=stop_duration=${pad.toFixed(3)}`);
  if (needsFps) filters.push('fps=30');

  const out = join(tmpdir(), `ab-pad-${randomBytes(8).toString('hex')}.mov`);
  const args = ['-y', '-hide_banner', '-nostats', '-i', file];
  if (filters.length) args.push('-vf', filters.join(','));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out);
  await ffRun(args, { timeoutMs: 120_000 });
  return out;
}

/**
 * Normalize a reference image for the provider's image refs: ARK rejects
 * images under 300px on either side and is unreliable outside jpg/png, so
 * anything else (webp, tiny images) gets transcoded to an upscaled jpg.
 * Returns the original path when it already conforms; callers must clean up
 * the returned temp path when one is produced.
 */
export async function ensureReferenceImage(file, { minSide = 320 } = {}) {
  let dims = null;
  try {
    const { stdout } = await pExecFile(FFMPEG_BIN, [
      '-hide_banner', '-nostats', '-i', file,
    ], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    const m = stderr.match(/Video:.*?, (\d{2,5})x(\d{2,5})/);
    if (m) dims = { w: Number(m[1]), h: Number(m[2]) };
  }
  const lower = String(file).toLowerCase();
  const isSafeFormat = lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png');
  if (dims && dims.w >= minSide && dims.h >= minSide && isSafeFormat) return { path: file, temp: false };

  if (!dims) {
    throw new AutoBypassError('A reference image could not be read.');
  }
  const factor = Math.max(1, minSide / Math.min(dims.w, dims.h));
  const outW = Math.max(2, Math.round((dims.w * factor) / 2) * 2);
  const outH = Math.max(2, Math.round((dims.h * factor) / 2) * 2);
  const out = join(tmpdir(), `ab-ref-${randomBytes(8).toString('hex')}.jpg`);
  await ffRun([
    '-y', '-hide_banner', '-nostats', '-threads', '2',
    '-i', file,
    '-vf', `scale=${outW}:${outH}`,
    '-q:v', '2',
    out,
  ], { timeoutMs: 60_000 });
  return { path: out, temp: true };
}

export async function cleanupTempFiles(...paths) {
  for (const p of paths) {
    if (p) await unlink(p).catch(() => {});
  }
}
