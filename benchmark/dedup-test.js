'use strict';

// Demonstrates real storage savings from content-addressable dedup: two
// "different" files that share a large common asset (e.g. the same
// embedded video/image bundled into two different app builds) should
// consume far less disk than the sum of their sizes, because the shared
// chunks are only ever written once per replica.

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const NODE_PORTS = [5400, 5401, 5402];
const COORD_PORT = 3910;

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

async function main() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objstore-dedup-'));
  const nodeProcs = NODE_PORTS.map((port, i) => {
    const nodeId = `node-${i}`;
    return spawn(process.execPath, [path.join(ROOT, 'src', 'storageNode.js')], {
      env: { ...process.env, NODE_ID: nodeId, PORT: String(port), DATA_DIR: path.join(runDir, nodeId) },
      stdio: 'ignore',
    });
  });
  process.env.STORAGE_NODES = NODE_PORTS.map((p, i) => `node-${i}=http://127.0.0.1:${p}`).join(',');
  await Promise.all(NODE_PORTS.map((p) => waitForHealth(`http://127.0.0.1:${p}/health`)));

  const { buildServer } = require('../src/server');
  const { app } = buildServer({ dbPath: ':memory:' });
  await app.listen({ port: COORD_PORT, host: '127.0.0.1' });

  // A 4 MiB "shared asset" (e.g. a bundled font/image/model file identical
  // across two otherwise-unrelated file uploads), plus distinct unique
  // content around it for each file.
  const sharedAsset = crypto.randomBytes(4 * 1024 * 1024);
  const fileA = Buffer.concat([crypto.randomBytes(512 * 1024), sharedAsset, crypto.randomBytes(512 * 1024)]);
  const fileB = Buffer.concat([crypto.randomBytes(256 * 1024), sharedAsset, crypto.randomBytes(1024 * 1024)]);

  await fetch(`http://127.0.0.1:${COORD_PORT}/files`, {
    method: 'POST', body: fileA, headers: { 'content-type': 'application/octet-stream' },
  });
  await fetch(`http://127.0.0.1:${COORD_PORT}/files`, {
    method: 'POST', body: fileB, headers: { 'content-type': 'application/octet-stream' },
  });

  const stats = await (await fetch(`http://127.0.0.1:${NODE_PORTS[0]}/stats`)).json();
  const sumOfFileSizes = fileA.length + fileB.length;
  const bytesOnDisk = stats.totalBytes;
  const savedBytes = sumOfFileSizes - bytesOnDisk;
  const savedPct = ((savedBytes / sumOfFileSizes) * 100).toFixed(1);

  const summary = {
    fileASizeBytes: fileA.length,
    fileBSizeBytes: fileB.length,
    sumOfFileSizesBytes: sumOfFileSizes,
    actualBytesOnDiskPerReplica: bytesOnDisk,
    bytesSavedByDedup: savedBytes,
    percentSaved: `${savedPct}%`,
  };
  console.log(JSON.stringify(summary, null, 2));

  await app.close();
  for (const p of nodeProcs) p.kill('SIGKILL');
  fs.rmSync(runDir, { recursive: true, force: true });
  return summary;
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { main };
