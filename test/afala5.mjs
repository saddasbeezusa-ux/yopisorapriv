import { AiStudioClient } from '../src/aistudio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pExec = promisify(execFile);
const ffmpeg = (await import('ffmpeg-static')).default;
const ai = new AiStudioClient();
const map = { H_both: 'napi:vid2:task_uXJiyOzQSQ6PtEIkuPVzLHGBMvP2xmnv', I_inputconfig: 'napi:vid2:task_yYumXF53PjaWoV1ViDAPBJfSuygxJtDz' };
for (const [label, id] of Object.entries(map)) {
  try {
    const { videoUrl } = await ai.waitForTask(id, { intervalMs: 15000, timeoutMs: 1200000 });
    const file = await ai.downloadTaskResult(id, { firstUrl: videoUrl });
    const { stdout } = await pExec(ffmpeg, ['-v', 'fatal', '-i', file.path, '-vf', 'fps=5,scale=160:90', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const FS = 160 * 90 * 3;
    let sum = 0, n = 0, parts = [];
    for (let f = 0; f + FS <= stdout.length; f += FS) {
      let red = 0;
      for (let i = f; i + 2 < f + FS; i += 3) {
        const r = stdout[i], g = stdout[i + 1], b = stdout[i + 2];
        if (r > 120 && r > g * 1.4 && r > b * 1.4) red++;
      }
      sum += red; n++; parts.push(red);
    }
    console.log(`${label}: avg ${Math.round(sum / n)}/14400  [${parts.join(',')}]`);
  } catch (err) {
    console.log(`${label}: FAILED ${String(err.message).slice(0, 120)}`);
  }
}
