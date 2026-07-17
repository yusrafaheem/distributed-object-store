'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

function waitForHealth(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(500) });
        if (res.ok) return resolve(true);
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${url}`));
      setTimeout(attempt, 150);
    };
    attempt();
  });
}

test('updating one file does not corrupt another file that shares a deduped chunk', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objstore-test-'));
  const ports = [4700, 4701, 4702];
  const nodeProcs = ports.map((port, i) => {
    const nodeId = `node-${i}`;
    return spawn(process.execPath, [path.join(ROOT, 'src', 'storageNode.js')], {
      env: { ...process.env, NODE_ID: nodeId, PORT: String(port), DATA_DIR: path.join(runDir, nodeId) },
      stdio: 'ignore',
    });
  });
  process.env.STORAGE_NODES = ports.map((p, i) => `node-${i}=http://127.0.0.1:${p}`).join(',');

  t.after(async () => {
    for (const p of nodeProcs) p.kill('SIGKILL');
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  await Promise.all(ports.map((p) => waitForHealth(`http://127.0.0.1:${p}/health`)));

  const { buildServer } = require('../src/server');
  const { app } = buildServer({ dbPath: ':memory:' });
  await app.listen({ port: 3600, host: '127.0.0.1' });
  t.after(async () => app.close());

  const sharedChunk = crypto.randomBytes(256 * 1024);
  const fileAv1 = Buffer.concat([sharedChunk, crypto.randomBytes(256 * 1024)]);
  const fileB = Buffer.concat([crypto.randomBytes(256 * 1024), sharedChunk]);

  const uploadA = await (await fetch('http://127.0.0.1:3600/files', {
    method: 'POST', body: fileAv1, headers: { 'content-type': 'application/octet-stream' },
  })).json();
  const uploadB = await (await fetch('http://127.0.0.1:3600/files', {
    method: 'POST', body: fileB, headers: { 'content-type': 'application/octet-stream' },
  })).json();

  const bBefore = Buffer.from(await (await fetch(`http://127.0.0.1:3600/files/${uploadB.fileId}/download`)).arrayBuffer());
  assert.ok(bBefore.equals(fileB), 'file B should download correctly before file A is touched');

  const fileAv2 = Buffer.concat([crypto.randomBytes(256 * 1024), crypto.randomBytes(256 * 1024)]);
  await fetch(`http://127.0.0.1:3600/files/${uploadA.fileId}`, {
    method: 'PUT', body: fileAv2, headers: { 'content-type': 'application/octet-stream' },
  });

  const bAfterRes = await fetch(`http://127.0.0.1:3600/files/${uploadB.fileId}/download`);
  const bAfter = Buffer.from(await bAfterRes.arrayBuffer());

  assert.equal(bAfterRes.status, 200, 'file B must still be downloadable after an unrelated file A update');
  assert.ok(bAfter.equals(fileB), 'file B bytes must be unchanged after an unrelated file A update');
});
