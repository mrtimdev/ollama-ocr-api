import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { remoteMonitorProxy } from './monitor-proxy.js';

test('remote monitor forwards keys, status, snapshots and actions without proxying OCR', async () => {
  const remote = express();
  const seen = [];
  remote.use((req, res) => {
    seen.push([req.method, req.path, req.get('X-Monitor-Key')]);
    if (req.get('X-Monitor-Key') !== 'remote-secret') return res.status(401).json({error:'Invalid key'});
    if (req.path.endsWith('/image')) return res.type('image/jpeg').send(Buffer.from([1,2,3]));
    res.json({success:true, jobs:[{id:'remote-job'}], stats:{total:1}});
  });
  const upstream = remote.listen(0, '127.0.0.1');
  await new Promise(resolve => upstream.once('listening', resolve));
  const app = express();
  app.use('/api/v1/monitor', remoteMonitorProxy(`http://127.0.0.1:${upstream.address().port}`));
  const local = app.listen(0, '127.0.0.1');
  await new Promise(resolve => local.once('listening', resolve));
  const base = `http://127.0.0.1:${local.address().port}/api/v1/monitor`;
  try {
    assert.equal((await fetch(`${base}/jobs`)).status,401);
    const headers = {'X-Monitor-Key':'remote-secret'};
    const snapshot = await (await fetch(`${base}/jobs`,{headers})).json();
    assert.equal(snapshot.remoteMonitor,true);
    assert.equal(snapshot.jobs[0].id,'remote-job');
    for (const [method,path] of [['GET','/jobs/remote-job/scans'],['POST','/jobs/remote-job/retry'],['DELETE','/jobs/remote-job']]) {
      assert.equal((await fetch(base+path,{method,headers})).status,200);
    }
    assert.deepEqual(new Uint8Array(await (await fetch(`${base}/jobs/remote-job/scans/42/image`,{headers})).arrayBuffer()),new Uint8Array([1,2,3]));
    const count = seen.length;
    assert.equal((await fetch(`${base}/ocr/batch`,{method:'POST',headers})).status,404);
    assert.equal(seen.length,count);
    assert.ok(seen.slice(1).every(entry=>entry[2]==='remote-secret'));
  } finally {
    await Promise.all([new Promise(resolve=>local.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);
  }
});
