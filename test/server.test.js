'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const STORAGE_PORTS = [7401, 7402, 7403];

function waitForHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return resolve();
      } catch (_) {
        // not up yet
      }
      if (Date.now() > deadline) return reject(new Error(`storage node on ${port} never became healthy`));
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

async function spawnCluster() {
  const dataDirs = STORAGE_PORTS.map(() =>
    fs.mkdtempSync(path.join(os.tmpdir(), 'objstore-node-'))
  );

  const children = STORAGE_PORTS.map((port, i) =>
    spawn(process.execPath, [path.join(__dirname, '../src/storageNode.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDirs[i] },
      stdio: 'ignore',
    })
  );

  await Promise.all(STORAGE_PORTS.map((port) => waitForHealth(port)));

  const topology = STORAGE_PORTS.map((port, i) => ({
    nodeId: `node-${i}`,
    url: `http://127.0.0.1:${port}`,
  }));

  return {
    topology,
    dataDirs,
    async cleanup() {
      for (const child of children) child.kill('SIGKILL');
      for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('upload then download returns byte-identical content across multiple chunks', async (t) => {
  const cluster = await spawnCluster();
  t.after(() => cluster.cleanup());

  const { buildServer } = require('../src/server');
  const { app, metadataStore } = buildServer({ dbPath: ':memory:', topology: cluster.topology });
  t.after(async () => {
    await app.close();
    metadataStore.close();
  });

  // Multi-chunk payload: several times the 256 KiB chunk size, non-zero bytes.
  const body = Buffer.alloc(700 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = i % 256;

  const uploadRes = await app.inject({ method: 'POST', url: '/files', payload: body });
  assert.equal(uploadRes.statusCode, 201);
  const { fileId } = uploadRes.json();

  const downloadRes = await app.inject({ method: 'GET', url: `/files/${fileId}/download` });
  assert.equal(downloadRes.statusCode, 200);
  assert.ok(Buffer.from(downloadRes.rawPayload).equals(body));
});

test('uploading the same file twice deduplicates every chunk', async (t) => {
  const cluster = await spawnCluster();
  t.after(() => cluster.cleanup());

  const { buildServer } = require('../src/server');
  const { app, metadataStore } = buildServer({ dbPath: ':memory:', topology: cluster.topology });
  t.after(async () => {
    await app.close();
    metadataStore.close();
  });

  const body = Buffer.alloc(400 * 1024, 7);

  async function totalChunkCount() {
    let total = 0;
    for (const port of STORAGE_PORTS) {
      const res = await fetch(`http://127.0.0.1:${port}/stats`);
      const stats = await res.json();
      total += stats.chunkCount;
    }
    return total;
  }

  await app.inject({ method: 'POST', url: '/files', payload: body });
  const afterFirst = await totalChunkCount();

  await app.inject({ method: 'POST', url: '/files', payload: body });
  const afterSecond = await totalChunkCount();

  assert.equal(afterSecond, afterFirst, 'uploading identical content again must not add new chunks');
});

test('presigned download URL works and an expired one is rejected with 403', async (t) => {
  const cluster = await spawnCluster();
  t.after(() => cluster.cleanup());

  const { buildServer } = require('../src/server');
  const { app, metadataStore } = buildServer({ dbPath: ':memory:', topology: cluster.topology });
  t.after(async () => {
    await app.close();
    metadataStore.close();
  });

  const body = Buffer.from('presigned download integration test payload');
  const uploadRes = await app.inject({ method: 'POST', url: '/files', payload: body });
  const { fileId } = uploadRes.json();

  const presignRes = await app.inject({
    method: 'POST',
    url: `/files/${fileId}/presign-download`,
    payload: { ttlSeconds: 60 },
  });
  assert.equal(presignRes.statusCode, 200);
  const { url } = presignRes.json();

  const goodRes = await app.inject({ method: 'GET', url });
  assert.equal(goodRes.statusCode, 200);
  assert.ok(Buffer.from(goodRes.rawPayload).equals(body));

  const expiredUrl = url.replace(/expires=\d+/, `expires=${Date.now() - 1000}`);
  const expiredRes = await app.inject({ method: 'GET', url: expiredUrl });
  assert.equal(expiredRes.statusCode, 403);
});
