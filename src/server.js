'use strict';

const Fastify = require('fastify');
const { HashRing } = require('./hashRing');
const { Coordinator } = require('./coordinator');
const { MetadataStore } = require('./metadataStore');
const { chunkBuffer } = require('./chunker');
const { presign, verifyPresigned, PresignError } = require('./presign');
const { RateLimiter } = require('./rateLimiter');
const {
  register,
  httpRequestDuration,
  rateLimitRejections,
} = require('./metrics');
const { loadTopology, REPLICATION_FACTOR, WRITE_QUORUM } = require('./topology');

function buildServer({ dbPath, topology } = {}) {
  const nodes = topology || loadTopology();
  const ring = new HashRing({ virtualNodesPerPhysicalNode: 100 });
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
  const metadataStore = new MetadataStore(dbPath || ':memory:');
  const rateLimiter = new RateLimiter({ capacity: 500, refillPerSecond: 300 });

  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 * 1024 });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  app.addHook('onRequest', async (req, reply) => {
    const clientKey = req.headers['x-client-id'] || req.ip;
    if (!rateLimiter.allow(clientKey)) {
      rateLimitRejections.inc();
      reply.code(429).send({ error: 'rate limit exceeded' });
    }
  });

  app.addHook('onResponse', (req, reply, done) => {
    httpRequestDuration.observe(
      { method: req.method, route: req.routeOptions?.url || req.url, status: reply.statusCode },
      reply.elapsedTime / 1000
    );
    done();
  });

  async function uploadChunks(buf) {
    const chunks = chunkBuffer(buf);
    const writeResults = [];
    for (const chunk of chunks) {
      // Sequential on purpose for the write path's correctness story in
      // this reference implementation (simpler to reason about and test);
      // the benchmark issues many files concurrently, which is what
      // actually exercises replica fan-out and quorum logic under load.
      // eslint-disable-next-line no-await-in-loop
      const result = await coordinator.putChunk(chunk.hash, chunk.data);
      writeResults.push(result);
    }
    return { chunkHashes: chunks.map((c) => c.hash), writeResults, totalSize: buf.length };
  }

  // Create a new file from raw bytes (first version).
  app.post('/files', async (req, reply) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf)) return reply.code(400).send({ error: 'expected application/octet-stream body' });
    const { chunkHashes, totalSize } = await uploadChunks(buf);
    const fileId = metadataStore.createFile();
    const versionId = metadataStore.commitVersion(fileId, chunkHashes, totalSize);
    return reply.code(201).send({ fileId, versionId, chunkCount: chunkHashes.length, size: totalSize });
  });

  // Commit a new version of an existing file (an "update").
  app.put('/files/:fileId', async (req, reply) => {
    const { fileId } = req.params;
    const file = metadataStore.getFile(fileId);
    if (!file) return reply.code(404).send({ error: 'file not found' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf)) return reply.code(400).send({ error: 'expected application/octet-stream body' });

    const previousVersionId = file.current_version_id;
    const { chunkHashes, totalSize } = await uploadChunks(buf);
    const versionId = metadataStore.commitVersion(fileId, chunkHashes, totalSize);

    if (previousVersionId) {
      // Deleting the previous version only decrements the GLOBAL refcount
      // for the chunks it referenced (see metadataStore.deleteVersion). We
      // deliberately do NOT delete any chunk bytes from the replicas here,
      // even ones that look "dropped" from this file's new manifest — a
      // chunk hash can be shared by other files/versions via dedup, and the
      // per-file diff has no way to know that. Physical deletion is handled
      // exclusively by the background GC sweep (src/gc.js), which only ever
      // acts on chunks whose global refcount has actually reached zero.
      // See test/dedupCorruption.test.js for the regression this guards
      // against: an earlier version of this handler deleted "dropped"
      // chunks immediately and silently corrupted any other file that
      // still pointed at the same chunk hash.
      metadataStore.deleteVersion(previousVersionId);
    }

    return reply.send({ fileId, versionId, previousVersionId, chunkCount: chunkHashes.length, size: totalSize });
  });

  app.get('/files/:fileId', async (req, reply) => {
    const { fileId } = req.params;
    const file = metadataStore.getFile(fileId);
    if (!file) return reply.code(404).send({ error: 'file not found' });
    const versions = metadataStore.listVersions(fileId);
    return reply.send({ ...file, versions });
  });

  app.get('/files/:fileId/download', async (req, reply) => {
    const { fileId } = req.params;
    const file = metadataStore.getFile(fileId);
    if (!file || !file.current_version_id) return reply.code(404).send({ error: 'file not found' });
    const version = metadataStore.getVersion(file.current_version_id);
    // Fetched in parallel — order is preserved because Promise.all resolves
    // into an array matching the input order, and chunk fetches are
    // independent of each other (each is an idempotent GET against
    // whichever replica answers first in its own preference list).
    const parts = await Promise.all(version.chunkHashes.map((hash) => coordinator.getChunk(hash)));
    const missingIndex = parts.findIndex((p) => !p);
    if (missingIndex !== -1) {
      return reply.code(500).send({ error: `chunk ${version.chunkHashes[missingIndex]} unavailable across all replicas` });
    }
    reply.header('content-type', 'application/octet-stream');
    return reply.send(Buffer.concat(parts));
  });

  // Presigned upload/download URLs, in the S3 style: the client asks the
  // coordinator for a signed URL, then talks directly to that URL for the
  // actual bytes. Here "directly" still routes through the coordinator
  // (it's the only thing that knows the ring), but the auth check on the
  // presigned request is just signature+expiry, not a full session lookup.
  app.post('/files/:fileId/presign-download', async (req, reply) => {
    const { fileId } = req.params;
    const file = metadataStore.getFile(fileId);
    if (!file) return reply.code(404).send({ error: 'file not found' });
    const { url, expiresAt } = presign('GET', `/files/${fileId}/download`, { ttlSeconds: 300 });
    return reply.send({ url, expiresAt });
  });

  app.get('/files/:fileId/download-presigned', async (req, reply) => {
    const { fileId } = req.params;
    try {
      verifyPresigned('GET', `/files/${fileId}/download`, req.query);
    } catch (err) {
      if (err instanceof PresignError) return reply.code(403).send({ error: err.message });
      throw err;
    }
    return app.inject({ method: 'GET', url: `/files/${fileId}/download` }).then((res) => {
      reply.code(res.statusCode);
      reply.header('content-type', 'application/octet-stream');
      return reply.send(res.rawPayload);
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/metrics', async (req, reply) => {
    reply.header('content-type', register.contentType);
    return reply.send(await register.metrics());
  });

  return { app, coordinator, metadataStore, ring };
}

module.exports = { buildServer };

if (require.main === module) {
  const { app } = buildServer({ dbPath: process.env.DB_PATH || './data/metadata.sqlite' });
  const port = Number(process.env.PORT || 3000);
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`coordinator listening on ${address}`);
  });
}
