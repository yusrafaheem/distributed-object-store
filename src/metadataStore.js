'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  current_version_id TEXT
);

CREATE TABLE IF NOT EXISTS versions (
  version_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(file_id)
);

-- The manifest: for each version, the ordered list of chunk hashes that
-- reconstitute the file. (version_id, seq) is the file's byte order;
-- chunk_hash is what actually lives in the distributed chunk store.
CREATE TABLE IF NOT EXISTS manifest_chunks (
  version_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  chunk_hash TEXT NOT NULL,
  PRIMARY KEY (version_id, seq)
);

-- Global reference count per chunk hash, across every version of every
-- file that has ever referenced it. This is the piece that makes garbage
-- collection safe under deduplication: a chunk is only eligible for
-- deletion when NO version of ANY file still points at it, not just when
-- it disappears from one particular file's latest version.
CREATE TABLE IF NOT EXISTS chunk_refcounts (
  chunk_hash TEXT PRIMARY KEY,
  refcount INTEGER NOT NULL DEFAULT 0
);
`;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

class MetadataStore {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      // WAL mode lets readers proceed without blocking on a writer, which
      // matters once multiple cluster workers share one metadata file —
      // still effectively one writer at a time, but readers stay fast.
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
    }
    this.db.exec(SCHEMA);
  }

  createFile() {
    const fileId = newId('file');
    this.db.prepare('INSERT INTO files (file_id, created_at, current_version_id) VALUES (?, ?, NULL)')
      .run(fileId, Date.now());
    return fileId;
  }

  /**
   * Commits a new version of a file with the given ordered chunk hash list.
   * Increments the global refcount for every chunk referenced by this
   * version (including chunks reused from the previous version — a chunk
   * that appears in both v1 and v2 of the same file is referenced twice,
   * once per version, until one of those versions is deleted).
   *
   * totalSize defaults to 0 rather than being required: callers that only
   * care about the chunk/refcount bookkeeping (GC tests, dedup tests) have
   * no reason to compute a byte size just to satisfy this call, and passing
   * `undefined` through to the SQLite bind previously crashed with "Provided
   * value cannot be bound to SQLite parameter 3." The real upload path in
   * server.js always has and passes a real size.
   */
  commitVersion(fileId, chunkHashes, totalSize = 0) {
    const versionId = newId('ver');
    const now = Date.now();
    this.db.prepare('INSERT INTO versions (version_id, file_id, size, created_at) VALUES (?, ?, ?, ?)')
      .run(versionId, fileId, totalSize, now);

    const insertChunk = this.db.prepare(
      'INSERT INTO manifest_chunks (version_id, seq, chunk_hash) VALUES (?, ?, ?)'
    );
    const bumpRefcount = this.db.prepare(`
      INSERT INTO chunk_refcounts (chunk_hash, refcount) VALUES (?, 1)
      ON CONFLICT(chunk_hash) DO UPDATE SET refcount = refcount + 1
    `);
    chunkHashes.forEach((hash, seq) => {
      insertChunk.run(versionId, seq, hash);
      bumpRefcount.run(hash);
    });

    this.db.prepare('UPDATE files SET current_version_id = ? WHERE file_id = ?').run(versionId, fileId);
    return versionId;
  }

  getFile(fileId) {
    const row = this.db.prepare('SELECT * FROM files WHERE file_id = ?').get(fileId);
    return row || null;
  }

  getVersion(versionId) {
    const version = this.db.prepare('SELECT * FROM versions WHERE version_id = ?').get(versionId);
    if (!version) return null;
    const chunks = this.db
      .prepare('SELECT seq, chunk_hash FROM manifest_chunks WHERE version_id = ? ORDER BY seq ASC')
      .all(versionId);
    return { ...version, chunkHashes: chunks.map((c) => c.chunk_hash) };
  }

  listVersions(fileId) {
    return this.db
      .prepare('SELECT version_id, size, created_at FROM versions WHERE file_id = ? ORDER BY created_at ASC')
      .all(fileId);
  }

  getRefcount(chunkHash) {
    const row = this.db.prepare('SELECT refcount FROM chunk_refcounts WHERE chunk_hash = ?').get(chunkHash);
    return row ? row.refcount : 0;
  }

  /**
   * Every chunk hash whose global refcount has dropped to (or below) zero —
   * i.e. no live version of any file references it anymore. GC deletes
   * exactly this set, and only this set, from every replica.
   */
  listOrphanedChunks() {
    return this.db
      .prepare('SELECT chunk_hash FROM chunk_refcounts WHERE refcount <= 0')
      .all()
      .map((r) => r.chunk_hash);
  }

  reapOrphanedChunk(chunkHash) {
    this.db.prepare('DELETE FROM chunk_refcounts WHERE chunk_hash = ?').run(chunkHash);
  }

  _decrementRefcounts(chunkHashes) {
    const dec = this.db.prepare('UPDATE chunk_refcounts SET refcount = refcount - 1 WHERE chunk_hash = ?');
    for (const hash of chunkHashes) dec.run(hash);
  }

  /**
   * Deletes one version of a file (e.g. because it was superseded, or the
   * whole file was deleted and this was its only/last version). Decrements
   * the global refcount for every chunk that version referenced. This is
   * the ONLY correct place to decrement refcounts — see gc.js for the
   * historical bug where a different code path did this per-file instead
   * of globally.
   */
  deleteVersion(versionId) {
    const version = this.getVersion(versionId);
    if (!version) return;
    this._decrementRefcounts(version.chunkHashes);
    this.db.prepare('DELETE FROM manifest_chunks WHERE version_id = ?').run(versionId);
    this.db.prepare('DELETE FROM versions WHERE version_id = ?').run(versionId);
  }

  close() {
    this.db.close();
  }
}

module.exports = { MetadataStore };
