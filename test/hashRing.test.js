'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { HashRing } = require('../src/hashRing');

test('preferenceList returns N distinct nodes', () => {
  const ring = new HashRing();
  ring.addNode('node-a');
  ring.addNode('node-b');
  ring.addNode('node-c');

  const list = ring.preferenceList('some-key', 3);
  assert.equal(list.length, 3);
  assert.equal(new Set(list).size, 3);
});

test('preferenceList is deterministic for the same key and topology', () => {
  const ring = new HashRing();
  ring.addNode('node-a');
  ring.addNode('node-b');
  ring.addNode('node-c');

  const first = ring.preferenceList('deterministic-key', 2);
  const second = ring.preferenceList('deterministic-key', 2);
  assert.deepEqual(first, second);
});

test('removing a node only reshuffles a minority of keys', () => {
  const ring = new HashRing({ virtualNodesPerPhysicalNode: 200 });
  ring.addNode('node-a');
  ring.addNode('node-b');
  ring.addNode('node-c');
  ring.addNode('node-d');

  const keys = [];
  for (let i = 0; i < 500; i++) keys.push(`key-${i}`);

  const before = new Map();
  for (const key of keys) before.set(key, ring.preferenceList(key, 1)[0]);

  ring.removeNode('node-b');

  let changed = 0;
  for (const key of keys) {
    const after = ring.preferenceList(key, 1)[0];
    if (after !== before.get(key)) changed += 1;
  }

  // Only keys that were owned by node-b (roughly 1/4 of the keyspace)
  // should move; give generous headroom for hash-distribution noise.
  assert.ok(changed < keys.length * 0.4, `expected < 40% of keys to move, got ${(changed / keys.length) * 100}%`);
});

test('virtual nodes spread keys roughly evenly across physical nodes', () => {
  const ring = new HashRing({ virtualNodesPerPhysicalNode: 200 });
  ring.addNode('node-a');
  ring.addNode('node-b');
  ring.addNode('node-c');

  const counts = new Map([['node-a', 0], ['node-b', 0], ['node-c', 0]]);
  for (let i = 0; i < 3000; i++) {
    const owner = ring.preferenceList(`distribution-key-${i}`, 1)[0];
    counts.set(owner, counts.get(owner) + 1);
  }

  for (const [, count] of counts) {
    // Expect roughly 1000 per node; allow +/- 30% for hash noise.
    assert.ok(count > 700 && count < 1300, `node got ${count} keys, expected ~1000`);
  }
});

test('preferenceList returns all nodes if replicaCount exceeds node count', () => {
  const ring = new HashRing();
  ring.addNode('node-a');
  ring.addNode('node-b');

  const list = ring.preferenceList('overflow-key', 5);
  assert.equal(list.length, 2);
});

test('empty ring returns an empty preference list', () => {
  const ring = new HashRing();
  const list = ring.preferenceList('no-nodes-key', 3);
  assert.deepEqual(list, []);
});
