'use strict';

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'objstore_' });

const httpRequestDuration = new client.Histogram({
  name: 'objstore_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labeled by route and status code',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

const replicaWriteLatency = new client.Histogram({
  name: 'objstore_replica_write_latency_seconds',
  help: 'Latency of a single chunk write to one storage-node replica',
  labelNames: ['nodeId', 'outcome'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

const quorumWriteFailures = new client.Counter({
  name: 'objstore_quorum_write_failures_total',
  help: 'Chunk writes that failed to reach write quorum W',
  registers: [register],
});

const quorumReadFailovers = new client.Counter({
  name: 'objstore_quorum_read_failovers_total',
  help: 'Reads that had to fail over to a non-primary replica (node down or integrity mismatch)',
  labelNames: ['reason'],
  registers: [register],
});

const chunkIntegrityFailures = new client.Counter({
  name: 'objstore_chunk_integrity_failures_total',
  help: 'Times a replica returned bytes that failed the SHA-256 verification',
  registers: [register],
});

const dedupBytesSaved = new client.Counter({
  name: 'objstore_dedup_bytes_saved_total',
  help: 'Bytes not written to storage because the chunk already existed (content-addressable dedup)',
  registers: [register],
});

const gcReclaimedBytes = new client.Counter({
  name: 'objstore_gc_reclaimed_bytes_total',
  help: 'Bytes reclaimed by garbage collection of orphaned (zero-refcount) chunks',
  registers: [register],
});

const gcReclaimedChunks = new client.Counter({
  name: 'objstore_gc_reclaimed_chunks_total',
  help: 'Chunk objects deleted by garbage collection',
  registers: [register],
});

const rateLimitRejections = new client.Counter({
  name: 'objstore_rate_limit_rejections_total',
  help: 'Requests rejected by the per-client token bucket rate limiter',
  registers: [register],
});

module.exports = {
  register,
  httpRequestDuration,
  replicaWriteLatency,
  quorumWriteFailures,
  quorumReadFailovers,
  chunkIntegrityFailures,
  dedupBytesSaved,
  gcReclaimedBytes,
  gcReclaimedChunks,
  rateLimitRejections,
};
