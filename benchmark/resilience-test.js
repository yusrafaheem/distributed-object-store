'use strict';

// Demonstrates the entire point of N-way replication: kill one of three
// storage nodes mid-run and prove reads and writes both still succeed via
// quorum (W=2, R effectively covered by failover through the preference
// list). This is a real test against real child processes — nothing here
// is simulated or mocked.

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'objstore-resilience-'));

const NODE_PORTS = [4400, 4401, 4402];
const COORD_PORT = 3300;

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
  const nodeProcs = NODE_PORTS.map((port, i) => {
    const nodeId = `node-${i}`;
    return spawn(process.execPath, [path.join(ROOT, 'src', 'storageNode.js')], {
      env: { ...process.env, NODE_ID: nodeId, PORT: String(port), DATA_DIR: path.join(RUN_DIR, nodeId) },
      stdio: 'ignore',
    });
  });

  process.env.STORAGE_NODES = NODE_PORTS.map((p, i) => `node-${i}=http://127.0.0.1:${p}`).join(',');
  process.env.REPLICATION_FACTOR = '3';
  process.env.WRITE_QUORUM = '2';

  await Promise.all(NODE_PORTS.map((p) => waitForHealth(`http://127.0.0.1:${p}/health`)));
  console.log('All 3 storage nodes healthy.');

  const { buildServer } = require('../src/server');
  const { app } = buildServer({ dbPath: ':memory:' });
  await app.listen({ port: COORD_PORT, host: '127.0.0.1' });
  console.log(`Coordinator listening on ${COORD_PORT}.`);

  const fileA = crypto.randomBytes(1024 * 1024); // 1 MiB, all 3 nodes up
  let res = await fetch(`http://127.0.0.1:${COORD_PORT}/files`, {
    method: 'POST',
    body: fileA,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const { fileId } = await res.json();
  console.log(`Uploaded file ${fileId} with all 3 replicas up.`);

  console.log('\n--- Killing node-1 (1 of 3 replicas) ---\n');
  nodeProcs[1].kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));

  const downRes = await fetch(`http://127.0.0.1:${COORD_PORT}/files/${fileId}/download`);
  const downloaded = Buffer.from(await downRes.arrayBuffer());
  const readOk = downRes.ok && downloaded.equals(fileA);
  console.log(`Read with 1/3 nodes down: HTTP ${downRes.status}, bytes match original: ${readOk}`);

  const fileB = crypto.randomBytes(512 * 1024);
  const writeRes = await fetch(`http://127.0.0.1:${COORD_PORT}/files`, {
    method: 'POST',
    body: fileB,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const writeOk = writeRes.ok;
  console.log(`Write with 1/3 nodes down: HTTP ${writeRes.status} (succeeded because W=2 of N=3 replicas still ack)`);

  const metricsRes = await fetch(`http://127.0.0.1:${COORD_PORT}/metrics`);
  const metricsText = await metricsRes.text();
  const failoverLine = metricsText.split('\n').filter((l) => l.startsWith('objstore_quorum_read_failovers_total'));
  const integrityLine = metricsText.split('\n').filter((l) => l.startsWith('objstore_quorum_write_failures_total'));

  console.log('\n=== Resilience summary ===');
  console.log(JSON.stringify({
    readSucceededWithNodeDown: readOk,
    writeSucceededWithNodeDown: writeOk,
    quorumReadFailoverMetricLines: failoverLine,
    quorumWriteFailureMetricLines: integrityLine,
  }, null, 2));

  await app.close();
  for (const p of nodeProcs) p.kill('SIGKILL');
  fs.rmSync(RUN_DIR, { recursive: true, force: true });

  if (!readOk || !writeOk) {
    console.error('\nRESILIENCE TEST FAILED');
    process.exit(1);
  }
  console.log('\nRESILIENCE TEST PASSED: quorum replication survived 1/3 node failure with zero data loss and zero failed requests.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
