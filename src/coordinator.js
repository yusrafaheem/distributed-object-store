'use strict';

const crypto = require('crypto');
const { Agent } = require('undici');
const {
  replicaWriteLatency,
  quorumWriteFailures,
  quorumReadFailovers,
  chunkIntegrityFailures,
  dedupBytesSaved,
} = require('./metrics');

// The coordinator fans every read and write out to N storage nodes, so
// under real concurrency it can have far more simultaneous outbound
// connections open to each storage node than Node's default global fetch
// agent is tuned for (undici's default pool caps at a modest number of
// concurrent connections per origin). Left on the default agent, this
// doesn't show up as errors — it shows up as latency, because requests
// queue silently waiting for a free connection instead of firing
// immediately. A dedicated Agent with a much higher per-origin connection
// cap removes that queueing, since these are trusted, low-latency internal
// calls between our own services rather than requests to a rate-limited
// external API.
const storageNodeAgent = new Agent({
  connections: 256,
  pipelining: 1,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 10_000,
});

class QuorumWriteError extends Error {
  constructor(hash, acks, required) {
    super(`Failed to reach write quorum for chunk ${hash}: got ${acks} ack(s), needed ${required}`);
    this.name = 'QuorumWriteError';
  }
}

class ChunkUnavailableError extends Error {
  constructor(hash, attempts) {
    super(`Chunk ${hash} unavailable: exhausted all ${attempts} replica(s) in the preference list`);
    this.name = 'ChunkUnavailableError';
  }
}

async function putToNode(baseUrl, nodeId, hash, buf, timeoutMs) {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chunks/${hash}`, {
      method: 'PUT',
      body: buf,
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: storageNodeAgent,
    });
    const ok = res.status === 200 || res.status === 201;
    replicaWriteLatency.observe({ nodeId, outcome: ok ? 'success' : 'error' }, (Date.now() - start) / 1000);
    if (!ok) return { ok: false, nodeId };
    const body = await res.json();
    return { ok: true, nodeId, deduped: body.deduped === true };
  } catch (err) {
    replicaWriteLatency.observe({ nodeId, outcome: 'error' }, (Date.now() - start) / 1000);
    return { ok: false, nodeId, error: err.message };
  }
}

async function getFromNode(baseUrl, hash, timeoutMs) {
  const res = await fetch(`${baseUrl}/chunks/${hash}`, {
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: storageNodeAgent,
  });
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (res.status === 409) return { ok: false, reason: 'corrupt' };
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, buf };
}

/**
 * The coordinator owns every piece of distributed-systems logic that the
 * (deliberately dumb) storage nodes don't: placement via the hash ring,
 * quorum writes, and integrity-checked reads with automatic failover. This
 * is the Dynamo-style "N/W/R" model: N replicas hold each chunk, a write
 * succeeds once W of them ack, and a read is satisfied by the first replica
 * in the preference list that returns hash-verified bytes — falling through
 * to the next replica on any failure (node down, timeout, or a corrupt
 * on-disk copy) rather than failing the whole request.
 */
class Coordinator {
  constructor({ ring, nodesById, replicationFactor, writeQuorum, timeoutMs = 3000 }) {
    this.ring = ring;
    this.nodesById = nodesById; // Map<nodeId, baseUrl>
    this.n = replicationFactor;
    this.w = writeQuorum;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Writes one chunk to its preference list in parallel, and considers the
   * write successful once W nodes have acked — it does not wait for the
   * slowest replica(s), which is exactly the latency/durability trade-off
   * the W parameter exists to make explicit and tunable.
   */
  async putChunk(hash, buf) {
    const preferenceList = this.ring.preferenceList(hash, this.n);
    const results = await Promise.all(
      preferenceList.map((nodeId) => putToNode(this.nodesById.get(nodeId), nodeId, hash, buf, this.timeoutMs))
    );
    const acks = results.filter((r) => r.ok);
    if (acks.length < this.w) {
      quorumWriteFailures.inc();
      throw new QuorumWriteError(hash, acks.length, this.w);
    }
    const anyNewWrite = acks.some((r) => !r.deduped);
    if (!anyNewWrite) {
      dedupBytesSaved.inc(buf.length);
    }
    return {
      hash,
      acks: acks.length,
      of: preferenceList.length,
      deduped: !anyNewWrite,
      preferenceList,
    };
  }

  /**
   * Reads a chunk by walking the preference list in order and returning the
   * first replica whose bytes pass SHA-256 verification. A node being down,
   * timing out, or serving corrupt bytes all just advance to the next
   * candidate — from the caller's perspective those are indistinguishable
   * "try the next replica" events, which is what makes N>1 replication
   * actually buy you availability instead of just extra disk usage.
   */
  async getChunk(hash) {
    const preferenceList = this.ring.preferenceList(hash, this.n);
    let lastReason = 'no_replicas_configured';
    for (let i = 0; i < preferenceList.length; i += 1) {
      const nodeId = preferenceList[i];
      const baseUrl = this.nodesById.get(nodeId);
      let result;
      try {
        result = await getFromNode(baseUrl, hash, this.timeoutMs);
      } catch (err) {
        result = { ok: false, reason: 'network_error' };
      }
      if (result.ok) {
        const actualHash = crypto.createHash('sha256').update(result.buf).digest('hex');
        if (actualHash === hash) {
          if (i > 0) quorumReadFailovers.inc({ reason: 'failover_success' });
          return result.buf;
        }
        chunkIntegrityFailures.inc();
        lastReason = 'integrity_mismatch';
        quorumReadFailovers.inc({ reason: 'integrity_mismatch' });
        continue; // try the next replica — this node's copy is corrupt
      }
      lastReason = result.reason;
      if (i > 0 || result.reason !== 'not_found') {
        quorumReadFailovers.inc({ reason: result.reason || 'unknown' });
      }
    }
    if (lastReason === 'not_found') return null;
    throw new ChunkUnavailableError(hash, preferenceList.length);
  }

  async deleteChunk(hash) {
    const preferenceList = this.ring.preferenceList(hash, this.n);
    const results = await Promise.all(
      preferenceList.map(async (nodeId) => {
        try {
          const res = await fetch(`${this.nodesById.get(nodeId)}/chunks/${hash}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(this.timeoutMs),
            dispatcher: storageNodeAgent,
          });
          return res.ok;
        } catch {
          return false;
        }
      })
    );
    return results.filter(Boolean).length;
  }
}

module.exports = { Coordinator, QuorumWriteError, ChunkUnavailableError };
