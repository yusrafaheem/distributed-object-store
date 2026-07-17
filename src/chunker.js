'use strict';

const crypto = require('crypto');

// Fixed-size chunking. Real systems (LBFS, rsync, Dropbox's own early design)
// use content-defined chunking (Rabin fingerprinting) so an insertion near the
// start of a file doesn't shift every chunk boundary after it. Fixed-size is
// simpler and is what we use here since our dedup story is "same file
// re-uploaded" / "same asset embedded in two files" rather than "byte
// inserted into the middle of a huge file" — content-defined chunking would
// be the natural next step and is called out in the README.
const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 KiB

function hashChunk(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Splits a Buffer into fixed-size chunks, each identified by the SHA-256 hash
 * of its contents. Returns the ordered list of chunk descriptors — this
 * ordered list *is* the file's manifest. Two files that share long common
 * runs of bytes (e.g. the same embedded image, or literally the same file
 * uploaded twice) will produce identical chunk hashes for those runs, which
 * is the entire basis for deduplication downstream.
 */
function chunkBuffer(buf, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('chunkBuffer expects a Buffer');
  }
  const chunks = [];
  for (let offset = 0; offset < buf.length; offset += chunkSize) {
    const slice = buf.subarray(offset, Math.min(offset + chunkSize, buf.length));
    chunks.push({
      hash: hashChunk(slice),
      size: slice.length,
      data: slice,
      seq: chunks.length,
    });
  }
  // An empty file still gets a manifest — just an empty chunk list. Callers
  // should treat that as valid (a zero-byte file is a legitimate file).
  return chunks;
}

module.exports = { chunkBuffer, hashChunk, DEFAULT_CHUNK_SIZE };
