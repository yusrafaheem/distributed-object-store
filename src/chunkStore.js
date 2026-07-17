'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ChunkIntegrityError extends Error {
  constructor(expectedHash, actualHash) {
    super(`Chunk integrity check failed: expected ${expectedHash}, got ${actualHash}. The stored bytes do not match their content hash — this chunk is corrupt on this replica.`);
    this.name = 'ChunkIntegrityError';
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * A single storage node's on-disk chunk store. Chunks are addressed by the
 * SHA-256 hash of their contents (git-style), sharded into two levels of
 * subdirectories by hash prefix so no single directory ever holds more than
 * ~65536 siblings even at billions of chunks.
 *
 * Writes are atomic: we write to a temp file in the same directory and
 * rename() into place, which POSIX guarantees is atomic. This matters
 * because two concurrent uploads of the *same* chunk (extremely common with
 * content-addressable storage — that's the whole point of dedup) must never
 * be able to interleave their writes and leave a torn, half-old/half-new
 * file on disk. Without the temp+rename step, a direct write() from two
 * writers racing on the same path can produce exactly that.
 */
class ChunkStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  _pathFor(hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new TypeError(`Invalid chunk hash: ${hash}`);
    }
    const dir = path.join(this.rootDir, hash.slice(0, 2), hash.slice(2, 4));
    return { dir, file: path.join(dir, hash) };
  }

  has(hash) {
    const { file } = this._pathFor(hash);
    return fs.existsSync(file);
  }

  /**
   * Writes a chunk. Idempotent: if the chunk already exists, this is a
   * cheap no-op (that's the dedup win — we never pay the write cost twice
   * for the same content). Verifies the caller's claimed hash against the
   * actual content hash before accepting the write, so a corrupt or
   * mislabeled chunk can never enter the store.
   */
  put(hash, buf) {
    const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualHash !== hash) {
      throw new ChunkIntegrityError(hash, actualHash);
    }
    const { dir, file } = this._pathFor(hash);
    if (fs.existsSync(file)) {
      return { written: false, deduped: true };
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file); // atomic on POSIX filesystems
    return { written: true, deduped: false };
  }

  /**
   * Reads a chunk and re-verifies its hash before returning it. This is the
   * node-local half of end-to-end integrity checking — the coordinator does
   * a second, independent check on the response, so corruption introduced
   * anywhere between disk and network is caught rather than silently served.
   */
  get(hash) {
    const { file } = this._pathFor(hash);
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualHash !== hash) {
      throw new ChunkIntegrityError(hash, actualHash);
    }
    return buf;
  }

  delete(hash) {
    const { file } = this._pathFor(hash);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
    return false;
  }

  stats() {
    let count = 0;
    let bytes = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.tmp-')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          count += 1;
          bytes += fs.statSync(full).size;
        }
      }
    };
    if (fs.existsSync(this.rootDir)) walk(this.rootDir);
    return { chunkCount: count, totalBytes: bytes };
  }
}

module.exports = { ChunkStore, ChunkIntegrityError };
