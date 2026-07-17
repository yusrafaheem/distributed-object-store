'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const STORAGE_PORTS = [7501, 7502, 7503];

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
    fs.mkdtempSync(path.join(os.tmpdir(), 'objstore-gc-node-'))
  );

  const children = STORAGE_PORTS.map((port, i) =>
    spawn(process.execPath, [path.join(__dirname, '../src/storageNode.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDirs[i] },
      stdio: 'ignore',
    })
  );

  await Promise.all(STORAGE_PORTS.map((port) => waitForHealth(port)));

  const nodesById = new Map(
    STORAGE_PORTS.map((port, i) => [`node-${i}`, `http://127.0.0.1:${port}`])
  );

  return {
    nodesById,
    async cleanup() {
      for (const child of children) child.kill('SIGKILL');
      for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function chunkExistsOnAnyReplica(port, hash) {
  const res = await fetch(`http://127.0.0.1:${port}/chunks/${hash}`);
  return res.status === 200;
}

test('GC reclaims a truly orphaned chunk but leaves one still referenced by another file', async (t) => {
  const cluster = await spawnCluster();
  t.after(() => cluster.cleanup());

  const { HashRing } = require('../src/hashRing');
  const { Coordinator } = require('../src/coordinator');
  const { MetadataStore } = require('../src/metadataStore');
  const { chunkBuffer, hashOf } = require('../src/chunker');
  const { runGarbageCollection } = require('../src/gc');

  const ring = new HashRing();
  for (const nodeId of cluster.nodesById.keys()) ring.addNode(nodeId);

  const dbPath = path.join(os.tmpdir(), `objstore-gc-meta-${Date.now()}.sqlite`);
  const metadataStore = new MetadataStore(dbPath);
  t.after(() => {
    metadataStore.close();
    fs.rmSync(dbPath, { force: true });
  });

  const coordinator = new Coordinator({
    ring,
    nodesById: cluster.nodesById,
    replicationFactor: 3,
    writeQuorum: 2,
  });

  // "shared" chunk referenced by both file A and file B; "onlyA" referenced
  // only by file A.
  const sharedBytes = Buffer.alloc(256 * 1024, 1);
  const onlyABytes = Buffer.alloc(256 * 1024, 2);
  const sharedHash = hashOf(sharedBytes);
  const onlyAHash = hashOf(onlyABytes);

  await coordinator.putChunk(sharedHash, sharedBytes);
  await coordinator.putChunk(onlyAHash, onlyABytes);

  const fileA = metadataStore.createFile('a.bin');
  const fileB = metadataStore.createFile('b.bin');
  const versionA = metadataStore.commitVersion(fileA, [sharedHash, onlyAHash]);
  metadataStore.commitVersion(fileB, [sharedHash]);

  // Delete file A's version — its chunks lose one reference each. sharedHash
  // is still referenced by file B's live version, but onlyAHash is now
  // truly orphaned.
  metadataStore.deleteVersion(versionA);

  const result = await runGarbageCollection(metadataStore, coordinator, {
    chunkSizeHint: 256 * 1024,
  });

  assert.equal(result.reclaimedChunks, 1, 'exactly one chunk (onlyA) should be reclaimed');

  // onlyA must be gone from every replica.
  for (const port of STORAGE_PORTS) {
    assert.equal(
      await chunkExistsOnAnyReplica(port, onlyAHash),
      false,
      `onlyA chunk should be deleted from replica on port ${port}`
    );
  }

  // shared must survive on every replica, since file B still references it.
  for (const port of STORAGE_PORTS) {
    assert.equal(
      await chunkExistsOnAnyReplica(port, sharedHash),
      true,
      `shared chunk must survive on replica on port ${port} (file B still references it)`
    );
  }
});
