'use strict';

const Fastify = require('fastify');
const { ChunkStore, ChunkIntegrityError } = require('./chunkStore');

/**
 * A storage node is a dumb, independent chunk-store server. It knows
 * nothing about files, manifests, replication, or the ring — it only knows
 * how to durably store and return byte blobs addressed by their SHA-256
 * hash, and it refuses to accept or return anything that doesn't hash-check.
 * That separation (dumb storage nodes + a smart coordinator) is deliberate:
 * it's the same split used by GFS/Colossus (chunkservers vs master),
 * Haystack (storage machines vs directory), and S3 (storage vs the routing
 * layer) — the storage tier stays simple and horizontally scalable, and all
 * the hard distributed-systems logic lives in exactly one place.
 */
function buildStorageNode({ nodeId, dataDir }) {
  const store = new ChunkStore(dataDir);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  app.put('/chunks/:hash', async (req, reply) => {
    const { hash } = req.params;
    try {
      const result = store.put(hash, req.body);
      return reply.code(result.written ? 201 : 200).send(result);
    } catch (err) {
      if (err instanceof ChunkIntegrityError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/chunks/:hash', async (req, reply) => {
    const { hash } = req.params;
    try {
      const buf = store.get(hash);
      if (!buf) return reply.code(404).send({ error: 'chunk not found' });
      reply.header('content-type', 'application/octet-stream');
      reply.header('x-chunk-hash', hash);
      return reply.send(buf);
    } catch (err) {
      if (err instanceof ChunkIntegrityError) {
        // This node's copy is corrupt. Tell the coordinator explicitly
        // (409, not 500) so it knows to fail over to another replica
        // rather than retrying the same bad copy.
        return reply.code(409).send({ error: err.message, corrupt: true });
      }
      throw err;
    }
  });

  app.delete('/chunks/:hash', async (req, reply) => {
    const { hash } = req.params;
    const deleted = store.delete(hash);
    return reply.code(200).send({ deleted });
  });

  app.get('/health', async () => ({ status: 'ok', nodeId }));

  app.get('/stats', async () => ({ nodeId, ...store.stats() }));

  return { app, store, nodeId };
}

module.exports = { buildStorageNode };

if (require.main === module) {
  const nodeId = process.env.NODE_ID || 'node-0';
  const port = Number(process.env.PORT || 4100);
  const dataDir = process.env.DATA_DIR || `./data/${nodeId}`;
  const { app } = buildStorageNode({ nodeId, dataDir });
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`[${nodeId}] storage node listening on ${address} (data: ${dataDir})`);
  });
}
