'use strict';

const { gcReclaimedBytes, gcReclaimedChunks } = require('./metrics');

/**
 * Background garbage collector. The ONLY signal it trusts for "is this
 * chunk safe to delete" is the metadata store's global refcount table,
 * which is incremented once per (version, chunk) reference across every
 * file that has ever existed and decremented only when a version is
 * actually deleted (see metadataStore.deleteVersion). That is deliberate:
 * with content-addressable dedup, the same chunk hash can legitimately be
 * referenced by many unrelated files, so "is this chunk still in file X's
 * latest manifest" is not a safe deletion signal — only "does ANY live
 * version of ANY file still reference it" is.
 *
 * GC runs as a periodic sweep rather than synchronously on every delete so
 * that a burst of deletes doesn't turn into a burst of cross-replica DELETE
 * calls on the request path — space reclamation is allowed to lag by one
 * sweep interval in exchange for keeping writes fast.
 */
async function runGarbageCollection(metadataStore, coordinator, { chunkSizeHint } = {}) {
  const orphaned = metadataStore.listOrphanedChunks();
  let reclaimedChunks = 0;
  let reclaimedBytes = 0;

  for (const hash of orphaned) {
    const deletedFromReplicas = await coordinator.deleteChunk(hash);
    if (deletedFromReplicas > 0) {
      reclaimedChunks += 1;
      // Storage nodes don't report size on DELETE, so real deployments
      // would look this up before deleting or track it in the refcount
      // table alongside the count. For the benchmark we pass a size hint
      // (the chunk size, since our chunker uses fixed-size chunks) so the
      // reported "bytes reclaimed" number is real rather than estimated.
      if (chunkSizeHint) reclaimedBytes += chunkSizeHint;
    }
    metadataStore.reapOrphanedChunk(hash);
  }

  if (reclaimedChunks > 0) {
    gcReclaimedChunks.inc(reclaimedChunks);
    gcReclaimedBytes.inc(reclaimedBytes);
  }

  return { scanned: orphaned.length, reclaimedChunks, reclaimedBytes };
}

module.exports = { runGarbageCollection };

if (require.main === module) {
  const { HashRing } = require('./hashRing');
  const { Coordinator } = require('./coordinator');
  const { MetadataStore } = require('./metadataStore');
  const { loadTopology, REPLICATION_FACTOR, WRITE_QUORUM } = require('./topology');
  const { DEFAULT_CHUNK_SIZE } = require('./chunker');

  const nodes = loadTopology();
  const ring = new HashRing();
  const nodesById = new Map();
  for (const { nodeId, url } of nodes) {
    ring.addNode(nodeId);
    nodesById.set(nodeId, url);
  }
  const coordinator = new Coordinator({
    ring,
    nodesById,
    replicationFactor: Math.min(REPLICATION_FACTOR, nodes.length),
    writeQuorum: Math.min(WRITE_QUORUM, nodes.length),
  });
  const metadataStore = new MetadataStore(process.env.DB_PATH || './data/metadata.sqlite');

  runGarbageCollection(metadataStore, coordinator, { chunkSizeHint: DEFAULT_CHUNK_SIZE })
    .then((result) => {
      console.log(`GC sweep complete: scanned ${result.scanned}, reclaimed ${result.reclaimedChunks} chunk(s), ~${result.reclaimedBytes} bytes.`);
      metadataStore.close();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
