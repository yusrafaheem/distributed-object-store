'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MetadataStore } = require('../src/metadataStore');

function tmpDbPath() {
  return path.join(os.tmpdir(), `metadata-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

test('commitVersion increments refcount once per chunk reference, including duplicates within one manifest', () => {
  const dbPath = tmpDbPath();
  const store = new MetadataStore(dbPath);
  try {
    const fileId = store.createFile('example.txt');
    // hash-a appears twice in the same manifest (e.g. a repeated block).
    store.commitVersion(fileId, ['hash-a', 'hash-b', 'hash-a']);

    assert.equal(store.getChunkRefcount('hash-a'), 2);
    assert.equal(store.getChunkRefcount('hash-b'), 1);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('a chunk shared across two files keeps a positive refcount after one file version is deleted', () => {
  const dbPath = tmpDbPath();
  const store = new MetadataStore(dbPath);
  try {
    const fileA = store.createFile('a.txt');
    const fileB = store.createFile('b.txt');

    const versionA = store.commitVersion(fileA, ['shared-hash', 'a-only-hash']);
    store.commitVersion(fileB, ['shared-hash']);

    assert.equal(store.getChunkRefcount('shared-hash'), 2);

    store.deleteVersion(versionA);

    // File B still references shared-hash, so it must not be orphaned.
    assert.equal(store.getChunkRefcount('shared-hash'), 1);
    assert.equal(store.getChunkRefcount('a-only-hash'), 0);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('listOrphanedChunks returns exactly the chunks with refcount <= 0', () => {
  const dbPath = tmpDbPath();
  const store = new MetadataStore(dbPath);
  try {
    const fileId = store.createFile('c.txt');
    const versionId = store.commitVersion(fileId, ['orphan-candidate', 'kept-hash']);
    store.commitVersion(fileId, ['kept-hash']); // new version drops orphan-candidate's reference
    store.deleteVersion(versionId);

    const orphaned = store.listOrphanedChunks();
    assert.ok(orphaned.includes('orphan-candidate'));
    assert.ok(!orphaned.includes('kept-hash'));
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('getVersion preserves the chunk-hash sequence order', () => {
  const dbPath = tmpDbPath();
  const store = new MetadataStore(dbPath);
  try {
    const fileId = store.createFile('ordered.txt');
    const hashes = ['h3', 'h1', 'h4', 'h1', 'h5'];
    const versionId = store.commitVersion(fileId, hashes);

    const version = store.getVersion(versionId);
    assert.deepEqual(version.chunkHashes, hashes);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('committing a new version updates the file current_version_id', () => {
  const dbPath = tmpDbPath();
  const store = new MetadataStore(dbPath);
  try {
    const fileId = store.createFile('versioned.txt');
    const v1 = store.commitVersion(fileId, ['v1-hash']);
    const v2 = store.commitVersion(fileId, ['v2-hash']);

    const file = store.getFile(fileId);
    assert.equal(file.currentVersionId, v2);
    assert.notEqual(v1, v2);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});
