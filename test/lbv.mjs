import { AiStudioClient } from '../src/aistudio.js';
import { ensureMinDuration } from '../src/autobypass.js';
import { uploadToLitterbox } from '../src/litterbox.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const pExec = promisify(execFile);
const ai = new AiStudioClient();

console.log('=== 720P via OutputConfig (5s, fast probe) ===');
const { taskId } = await ai.createTask({ prompt: 'a red balloon floating in a clear blue sky, cinematic', duration: 5, resolution: '720P', ratio: '16:9' });
const { videoUrl } = await ai.waitForTask(taskId, { intervalMs: 15000, timeoutMs: 1200000 });
const file = await ai.downloadTaskResult(taskId, { firstUrl: videoUrl });
const dims = await pExec('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',file.path]);
console.log(`720P probe: dims=${dims.stdout.trim()}  ${(file.bytes/1048576).toFixed(1)} MB`);

console.log('=== litterbox .mov upload (intro hosting shape) ===');
const introPath = fileURLToPath(new URL('../videointro.mov', import.meta.url));
const padded = await ensureMinDuration(introPath, 1.8);
const link = await uploadToLitterbox(padded, { filename: 'videointro.mov', contentType: 'video/quicktime' });
console.log('litterbox:', link);
const head = await fetch(link, { method: 'GET', headers: { Range: 'bytes=0-0' } });
console.log('fetch check:', head.status, head.headers.get('content-type'));
