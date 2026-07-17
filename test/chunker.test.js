'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkBuffer, hashChunk, DEFAULT_CHUNK_SIZE } = require('../src/chunker');

test('chunkBuffer splits into fixed-size chunks with a correctly-sized remainder', () => {
  const buf = Buffer.alloc(DEFAULT_CHUNK_SIZE * 2 + 100, 7);
  const chunks = chunkBuffer(buf);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].size, DEFAULT_CHUNK_SIZE);
  assert.equal(chunks[1].size, DEFAULT_CHUNK_SIZE);
  assert.equal(chunks[2].size, 100);
});

test('chunkBuffer assigns each chunk the correct SHA-256 hash of its own bytes', () => {
  const buf = Buffer.from('abcdefgh'.repeat(1000));
  const chunks = chunkBuffer(buf, 100);
  for (const c of chunks) {
    assert.equal(c.hash, hashChunk(c.data));
  }
});

test('identical byte runs across different offsets produce identical chunk hashes (the basis of dedup)', () => {
  const repeatedBlock = Buffer.alloc(500, 42);
  const buf = Buffer.concat([repeatedBlock, Buffer.alloc(500, 1), repeatedBlock]);
  const chunks = chunkBuffer(buf, 500);
  assert.equal(chunks[0].hash, chunks[2].hash);
  assert.notEqual(chunks[0].hash, chunks[1].hash);
});

test('an empty buffer produces an empty (but valid) chunk list', () => {
  const chunks = chunkBuffer(Buffer.alloc(0));
  assert.deepEqual(chunks, []);
});

test('chunkBuffer rejects non-Buffer input', () => {
  assert.throws(() => chunkBuffer('not a buffer'), TypeError);
});
