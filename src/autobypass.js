/**
 * ffmpeg helpers for /autobypass: find where the intro ends (first real scene
 * content after the black/fade intro) and trim the video to start there.
 *
 * The intro template renders as: a bright mask on a white void, then a black
 * gap / fade, then the actual scene. So the scene cut is the first sustained
 * stretch of "normal" luminance after the opening — strict threshold first,
 * then a wide one, then a fall-back to the last black frame near the start.
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

export async function analyzeVideo(file, { maxSeconds = 20 } = {}) {
  const track = await lumaTrack(file, maxSeconds);
  if (!track.length) return { sceneStart: null, method: 'no-data' };

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
  // -threads 2: without a cap x264 spawns one thread per core (22+ on Railway),
  // and the encode-time allocation blows past the container's memory limit —
  // the kernel kills ffmpeg mid-encode and the trim "fails".
  await ffRun([
    '-y', '-hide_banner', '-nostats',
    '-threads', '2',
    '-ss', String(Math.max(0, sceneStart)),
    '-i', file,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    out,
  ], { timeoutMs: 300_000 });
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

export async function cleanupTempFiles(...paths) {
  for (const p of paths) {
    if (p) await unlink(p).catch(() => {});
  }
}
