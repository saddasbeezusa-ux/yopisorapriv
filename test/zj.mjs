import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const pExec = promisify(execFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function req(hostname, path, method, body, key) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) };
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = https.request({ hostname, port: 443, path, method, rejectUnauthorized: false, timeout: 60000, headers }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const K = 'sk-dfc00e7b53d215ac82995b7e5fe7402d';
const tpl = `a X mask hovering in a white void for 0.2 seconds, then at the 0.3 second mark then the video instantly cuts to a red balloon floating in a clear blue sky, cinematic [refrence Video 1 for how long X mask stays on screen when video turns black that's when cut starts]`;
const body = {
  model: 'doubao-seedance-2-5-260628',
  prompt: tpl,
  ratio: '16:9',
  duration: 5,
  generate_audio: true,
  watermark: false,
  return_last_frame: true,
  images: [],
  content: [
    { type: 'text', text: `[写实] ${tpl}` },
    { type: 'video_url', video_url: { url: 'https://u.pone.rs/wumocznn.mp4' }, role: 'reference_video' },
  ],
};
const r = await req('101.133.136.15', '/api/generate/video', 'POST', body, K);
console.log('submit:', r.status, r.text.slice(0, 150));
const { task_id } = JSON.parse(r.text);
let last = null;
while (Date.now() < Date.now() + 600000 - 600000 + 600000) {
  const j = JSON.parse((await req('101.133.136.15', `/api/generate/status/${task_id}`, 'GET', null, K)).text);
  if (j.status !== last) { last = j.status; console.log('status:', j.status); }
  if (['completed', 'failed'].includes(j.status)) {
    if (j.status === 'failed') { console.log('ERROR:', String(j.error).slice(0, 200)); break; }
    const out = `${tmpdir()}\\opencode\\vidcheck\\glim_green2.mp4`;
    const chunks = [];
    await new Promise((resolve, reject) => {
      const rq = https.request({ hostname: '101.133.136.15', port: 443, path: j.result.url, method: 'GET', rejectUnauthorized: false, timeout: 300000, headers: { Authorization: `Bearer ${K}` } }, (res) => {
        res.on('data', c => chunks.push(c));
        res.on('end', resolve);
      });
      rq.on('error', reject); rq.end();
    });
    await writeFile(out, Buffer.concat(chunks));
    const ffmpeg = (await import('ffmpeg-static')).default;
    const { stdout } = await pExec(ffmpeg, ['-v','fatal','-t','2.5','-i',out,'-vf','fps=5,scale=160:90','-f','rawvideo','-pix_fmt','rgb24','-'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    const FS = 160 * 90 * 3;
    const parts = [];
    for (let f = 0; f + FS <= stdout.length; f += FS) {
      let green = 0;
      for (let i = f; i + 2 < f + FS; i += 3) {
        const g = stdout[i + 1], rr = stdout[i], b = stdout[i + 2];
        if (g > 140 && g > rr * 1.4 && g > b * 1.4) green++;
      }
      parts.push(green);
    }
    console.log(`GREEN ref via content array — intro green px: [${parts.join(',')}]`);
    break;
  }
  await sleep(20000);
}
