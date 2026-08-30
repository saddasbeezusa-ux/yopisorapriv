const B = 'http://129.211.224.80:5009/api/v1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ids = [59, 60, 61, 62];
const state = new Map(ids.map(i => [i, null]));
const deadline = Date.now() + 780000;
while (Date.now() < deadline) {
  const all = await fetch(`${B}/video/tasks?page=1&pageSize=10`).then(x => x.json());
  const map = new Map((all.data || []).map(t => [t.id, t]));
  let done = true;
  for (const id of ids) {
    const t = map.get(id);
    if (!t) continue;
    if (t.status !== state.get(id)) {
      state.set(id, t.status);
      console.log(`id=${id} -> ${t.status} taskId=${t.taskId ?? '-'} err=${(t.errorMessage||'').slice(0,100)}`);
    }
    if (['pending','queued','submitting','processing'].includes(t.status)) done = false;
  }
  if (done) break;
  await sleep(15000);
}
const all = await fetch(`${B}/video/tasks?page=1&pageSize=10`).then(x => x.json());
for (const t of (all.data || []).filter(x => ids.includes(x.id))) {
  console.log(`FINAL id=${t.id} ${t.status} videoUrl=${t.videoUrl ? 'yes' : 'null'}`);
  if (t.videoUrl) {
    const v = await fetch(t.videoUrl, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    console.log(`   video check: ${v.status} ${v.headers.get('content-type')}`);
  }
}
