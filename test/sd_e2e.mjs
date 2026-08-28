import { readFileSync } from 'node:fs';
import { SeedanceClient, SD2_MODEL, SD25_MODEL } from '../src/sd2.js';

const sd2 = new SeedanceClient({ model: SD2_MODEL });
const sd25 = new SeedanceClient({ model: SD25_MODEL });

console.log('=== /sd2: pro t2v 5s 720p 16:9 ===');
const { taskId: t1 } = await sd2.createTask({ prompt: 'a red balloon floating in a clear blue sky', duration: 5, ratio: '16:9', resolution: '720p' });
console.log('taskId:', t1);

console.log('=== /sd2-5: v25 ref 5s 720p with img + vid ===');
const img = { url: 'https://picsum.photos/id/237/640/360.jpg', name: 'ref.jpg', contentType: 'image/jpeg' };
const vid = { url: 'http://amerie.byteplus-demo.com/uploads/ffdac9db585f4cf2a54455236cb15806.mp4', name: 'ref.mp4', contentType: 'video/mp4' };
const { taskId: t2 } = await sd25.createTask({ prompt: 'the dog in the image looks around while the scene comes alive', duration: 5, ratio: '16:9', resolution: '720p', images: [img], videos: [vid] });
console.log('taskId:', t2);

console.log('=== violation: spongebob on sd2 ===');
let violBlocked = null, violMsg = null;
try {
  const { taskId: t3 } = await sd2.createTask({ prompt: 'spongebob squarepants dancing happily in bikini bottom', duration: 5, ratio: '16:9', resolution: '720p' });
  try { await sd2.waitForTask(t3, { intervalMs: 8000, timeoutMs: 600000 }); violBlocked = false; violMsg = 'SUCCEEDED (no violation)'; }
  catch (e) { violBlocked = e.blocked; violMsg = e.message; }
} catch (e) { violBlocked = e.blocked; violMsg = e.message; }
console.log('violation test: blocked=' + violBlocked + ' msg: ' + violMsg);

const started = Date.now();
const r1 = await sd2.waitForTask(t1, { intervalMs: 10000, timeoutMs: 900000 });
const f1 = await sd2.downloadFile(r1.videoUrl);
console.log(`sd2 done: ${(f1.bytes / 1048576).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)}s`);

const r2 = await sd25.waitForTask(t2, { intervalMs: 10000, timeoutMs: 900000 });
const f2 = await sd25.downloadFile(r2.videoUrl);
console.log(`sd2-5 done: ${(f2.bytes / 1048576).toFixed(1)} MB`);
console.log('FILES: ' + f1.path + '|' + f2.path);
