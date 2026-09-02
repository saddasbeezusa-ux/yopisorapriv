import https from 'node:https';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function req(path, method, body, key) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) };
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = https.request({ hostname: '101.133.136.15', port: 443, path, method, rejectUnauthorized: false, timeout: 60000, headers }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const K = 'sk-dfc00e7b53d215ac82995b7e5fe7402d';
let last = null;
const deadline = Date.now() + 600000;
while (Date.now() < deadline) {
  const r = await req('/api/generate/status/8d3a4f62', 'GET', null, K);
  const j = JSON.parse(r.text);
  if (j.status !== last) { last = j.status; console.log(`status: ${j.status}`); }
  if (['succeeded', 'failed', 'SUCCESS', 'FAILURE', 'done'].includes(j.status)) {
    console.log(JSON.stringify(j, null, 1).slice(0, 900));
    break;
  }
  await sleep(15000);
}
