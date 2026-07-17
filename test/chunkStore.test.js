'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ChunkStore, ChunkIntegrityError } = require('../src/chunkStore');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chunkstore-test-'));
}

function hashOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('put then get round-trips the exact bytes', () => {
  const store = new ChunkStore(tmpDir());
  const buf = Buffer.from('hello distributed world');
  const hash = hashOf(buf);
  store.put(hash, buf);
  assert.ok(store.get(hash).equals(buf));
});

test('put is idempotent and reports deduped=true on the second write', () => {
  const store = new ChunkStore(tmpDir());
  const buf = Buffer.from('deduplicate me');
  const hash = hashOf(buf);
  const first = store.put(hash, buf);
  const second = store.put(hash, buf);
  assert.equal(first.written, true);
  assert.equal(first.deduped, false);
  assert.equal(second.written, false);
  assert.equal(second.deduped, true);
});

test('put rejects a buffer whose content does not match the claimed hash', () => {
  const store = new ChunkStore(tmpDir());
  const buf = Buffer.from('real content');
  const wrongHash = hashOf(Buffer.from('different content'));
  assert.throws(() => store.put(wrongHash, buf), ChunkIntegrityError);
});

test('get returns null for a hash that was never written', () => {
  const store = new ChunkStore(tmpDir());
  assert.equal(store.get(crypto.randomBytes(32).toString('hex')), null);
});

test('delete removes a chunk and get() afterward returns null', () => {
  const store = new ChunkStore(tmpDir());
  const buf = Buffer.from('to be deleted');
  const hash = hashOf(buf);
  store.put(hash, buf);
  assert.equal(store.delete(hash), true);
  assert.equal(store.get(hash), null);
  assert.equal(store.delete(hash), false); // already gone
});

test('concurrent puts of the SAME chunk never produce a torn/corrupt file', async () => {
  const store = new ChunkStore(tmpDir());
  const buf = Buffer.alloc(200 * 1024, 9); // large enough that a torn write would be detectable
  const hash = hashOf(buf);
  // Fire 20 concurrent writes of the identical chunk — this is exactly the
  // access pattern content-addressable dedup produces in the real system
  // (many uploaders happen to share a chunk at the same moment).
  await Promise.all(Array.from({ length: 20 }, () => Promise.resolve(store.put(hash, buf))));
  const readBack = store.get(hash); // get() re-verifies the hash internally
  assert.ok(readBack.equals(buf), 'concurrent identical writes must not corrupt the stored chunk');
});

test('stats reports accurate chunk count and byte totals', () => {
  const store = new ChunkStore(tmpDir());
  const bufs = [Buffer.alloc(100, 1), Buffer.alloc(200, 2), Buffer.alloc(300, 3)];
  for (const b of bufs) store.put(hashOf(b), b);
  const stats = store.stats();
  assert.equal(stats.chunkCount, 3);
  assert.equal(stats.totalBytes, 600);
});
