import { AiStudioClient, AISTUDIO_MODEL_25 } from '../src/aistudio.js';
const ai = new AiStudioClient();
console.log('=== t2v 5s 480P on 124.174.38.110 ===');
const { taskId } = await ai.createTask({ prompt: 'a red balloon floating in a clear blue sky, cinematic', duration: 5, resolution: '480P', ratio: '16:9' });
console.log('taskId:', taskId);
const { videoUrl } = await ai.waitForTask(taskId, { intervalMs: 15000, timeoutMs: 1200000 });
console.log('video:', videoUrl.slice(0, 80));
const file = await ai.downloadFile(videoUrl);
console.log(`done: ${(file.bytes / 1048576).toFixed(2)} MB`);
