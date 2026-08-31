import { AiStudioClient } from '../src/aistudio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pExec = promisify(execFile);
const ai = new AiStudioClient();
const map = {
  'G content-array': 'napi:vid2:task_aI5ZxW5RFPhQ9IsCYtuZOh9FvMgbNq9h',
  'F flat-refs': 'napi:vid2:task_fiLIHwBAZvYAltpEs882Ok4IJ1fnGCZ5',
};
for (const [label, id] of Object.entries(map)) {
  try {
    const { videoUrl } = await ai.waitForTask(id, { intervalMs: 15000, timeoutMs: 1200000 });
    const file = await ai.downloadTaskResult(id, { firstUrl: videoUrl });
    const frame = file.path.replace(/\.mp4$/, '-frame.png');
    await pExec('ffmpeg-static' in process.env ? 'ffmpeg' : process.argv[0], []).catch(() => {});
    const ffmpeg = (await import('ffmpeg-static')).default;
    await pExec(ffmpeg, ['-y', '-ss', '3', '-i', file.path, '-frames:v', '1', frame]);
    const stat = await pExec('powershell', ['-NoProfile', '-Command', `(Get-Item "${frame.replace(/"/g, '`"')}").Length`]);
    console.log(`${label}: ${(file.bytes/1048576).toFixed(1)} MB, frame@3s -> ${frame} (${stat.stdout.trim()} bytes)`);
  } catch (err) {
    console.log(`${label}: FAILED ${err.message}`);
  }
}
