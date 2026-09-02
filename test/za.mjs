import https from 'node:https';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function req(path, key) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: '101.133.136.15', port: 443, path, method: 'GET', rejectUnauthorized: false, timeout: 60000, headers: { Accept: 'application/json', Authorization: `Bearer ${key}` } }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    r.on('error', reject); r.end();
  });
}
const K = 'sk-dfc00e7b53d215ac82995b7e5fe7402d';
const state = { '9fad8793': null, '3e78b4f6': null };
const deadline = Date.now() + 900000;
while (Date.now() < deadline) {
  let allDone = true;
  for (const [id, prev] of Object.entries(state)) {
    const j = await req(`/api/generate/status/${id}`, K);
    if (j.status !== prev) { state[id] = j.status; console.log(`${id} -> ${j.status}`); }
    if (!['completed', 'failed'].includes(j.status)) allDone = false;
  }
  if (allDone) break;
  await sleep(20000);
}
for (const [id] of Object.entries(state)) {
  const j = await req(`/api/generate/status/${id}`, K);
  console.log(`--- ${id}: ${j.status} ---`);
  if (j.error) console.log('error:', String(j.error).slice(0, 200));
  if (j.result) console.log('result:', JSON.stringify(j.result).slice(0, 250));
}
