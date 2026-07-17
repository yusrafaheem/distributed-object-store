'use strict';

const crypto = require('crypto');

function positionFor(key) {
  // 32-bit position on the ring, derived from the first 4 bytes of a SHA-1
  // hash. SHA-1 is fine here — this is a placement hash, not a security
  // boundary, and it's the same choice made by the original Dynamo paper
  // and by Ketama/libmemcached's consistent-hashing implementation.
  const digest = crypto.createHash('sha1').update(key).digest();
  return digest.readUInt32BE(0);
}

/**
 * Consistent hash ring with virtual nodes, in the style of Amazon's Dynamo
 * (2007) and Ketama. Every physical storage node is represented by many
 * points on a 2^32 ring (virtual nodes), which spreads that node's share of
 * the keyspace evenly instead of one contiguous arc — without virtual nodes,
 * removing one physical node dumps its entire arc onto exactly one
 * neighbor, which is both an uneven load spike and a durability risk.
 *
 * For a given chunk hash, walking clockwise from its ring position and
 * taking the first N *distinct physical nodes* encountered gives the
 * "preference list" — the ordered set of nodes that should hold replicas of
 * that chunk. Because virtual nodes are spread across the ring, adding or
 * removing a physical node only perturbs the placement of keys that were
 * adjacent to that node's virtual points — not the whole keyspace. That's
 * the entire point of consistent hashing over `hash(key) % nodeCount`,
 * which would remap almost everything on every topology change.
 */
class HashRing {
  constructor({ virtualNodesPerPhysicalNode = 100 } = {}) {
    this.vnodesPerNode = virtualNodesPerPhysicalNode;
    this.ring = []; // sorted array of { position, nodeId }
    this.nodes = new Set();
  }

  addNode(nodeId) {
    if (this.nodes.has(nodeId)) return;
    this.nodes.add(nodeId);
    for (let i = 0; i < this.vnodesPerNode; i += 1) {
      const position = positionFor(`${nodeId}#vnode${i}`);
      this.ring.push({ position, nodeId });
    }
    this.ring.sort((a, b) => a.position - b.position);
  }

  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) return;
    this.nodes.delete(nodeId);
    this.ring = this.ring.filter((entry) => entry.nodeId !== nodeId);
  }

  size() {
    return this.nodes.size;
  }

  /**
   * Returns the ordered preference list of up to `replicaCount` distinct
   * physical nodes for a given key, walking clockwise from the key's ring
   * position. If fewer physical nodes exist than replicaCount, returns all
   * of them.
   */
  preferenceList(key, replicaCount) {
    if (this.ring.length === 0) return [];
    const pos = positionFor(key);
    // Binary search for the first ring entry >= pos; wrap around to 0.
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].position < pos) lo = mid + 1;
      else hi = mid;
    }
    const startIdx = lo === this.ring.length ? 0 : lo;

    const result = [];
    const seen = new Set();
    for (let i = 0; i < this.ring.length && result.length < replicaCount; i += 1) {
      const entry = this.ring[(startIdx + i) % this.ring.length];
      if (!seen.has(entry.nodeId)) {
        seen.add(entry.nodeId);
        result.push(entry.nodeId);
      }
    }
    return result;
  }
}

module.exports = { HashRing, positionFor };
