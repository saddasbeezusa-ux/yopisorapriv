const B = 'http://129.211.224.80:5009/api/v1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const deadline = Date.now() + 420000;
let found = null;
while (Date.now() < deadline && (!found || ['pending','queued','submitting','processing'].includes(found.status))) {
  const r = await fetch(`${B}/video/tasks?page=1&pageSize=50`).then(x => x.json());
  const tasks = r.data || [];
  found = tasks.find(t => t.clientRef === 'opencode-probe-t2v-1');
  if (found) console.log(`db-id=${found.id} status=${found.status} taskId=${found.taskId ?? '-'} err=${found.errorMessage ?? ''}`);
  else console.log('not found yet; list head:', tasks[0]?.id, tasks[0]?.clientRef);
  if (!found || ['pending','queued','submitting','processing'].includes(found.status)) await sleep(12000);
}
console.log('FINAL:', JSON.stringify(found, null, 1)?.slice(0, 900));
if (found?.status === 'succeeded') {
  const v = await fetch(found.videoUrl);
  console.log('video fetch:', v.status, v.headers.get('content-type'), (v.headers.get('content-length') ?? '?') + 'B');
}
