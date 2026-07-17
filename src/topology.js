'use strict';

// Static cluster topology for local dev/benchmarking. In a real deployment
// this would come from service discovery (Consul/etcd/k8s Endpoints) so the
// ring updates automatically as nodes join/leave; here it's an env-var-driven
// list so the whole cluster can be stood up with `docker compose up` or a
// single launcher script with zero external dependencies.
function loadTopology() {
  const raw = process.env.STORAGE_NODES;
  if (raw) {
    // Format: "node-0=http://localhost:4100,node-1=http://localhost:4101,..."
    return raw.split(',').map((pair) => {
      const [nodeId, url] = pair.split('=');
      return { nodeId, url };
    });
  }
  // Default: 3-node local cluster.
  return [
    { nodeId: 'node-0', url: 'http://127.0.0.1:4100' },
    { nodeId: 'node-1', url: 'http://127.0.0.1:4101' },
    { nodeId: 'node-2', url: 'http://127.0.0.1:4102' },
  ];
}

const REPLICATION_FACTOR = Number(process.env.REPLICATION_FACTOR || 3); // N
const WRITE_QUORUM = Number(process.env.WRITE_QUORUM || 2); // W
const READ_QUORUM = Number(process.env.READ_QUORUM || 1); // R (we fail over through the whole preference list on read, R governs how many *successful* reads we require to call it a confirmed success in tests)

module.exports = { loadTopology, REPLICATION_FACTOR, WRITE_QUORUM, READ_QUORUM };
