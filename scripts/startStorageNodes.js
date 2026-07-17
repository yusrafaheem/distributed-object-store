'use strict';

// Launches the local dev/benchmark storage cluster: one child process per
// node in the topology, each an independent storageNode.js server with its
// own data directory and port. This is what makes the "distributed" part
// real rather than simulated in-process — each node is a genuine OS process
// that can be killed independently, which is exactly what the resilience
// benchmark does.

const { spawn } = require('child_process');
const path = require('path');
const { loadTopology } = require('../src/topology');

const nodes = loadTopology();
const children = [];

for (const { nodeId, url } of nodes) {
  const port = new URL(url).port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'storageNode.js')], {
    env: {
      ...process.env,
      NODE_ID: nodeId,
      PORT: port,
      DATA_DIR: path.join(__dirname, '..', 'data', nodeId),
    },
    stdio: 'inherit',
  });
  children.push({ nodeId, child });
}

console.log(`Started ${children.length} storage node(s): ${nodes.map((n) => n.nodeId).join(', ')}`);

process.on('SIGINT', () => {
  console.log('\nShutting down storage nodes...');
  for (const { child } of children) child.kill('SIGTERM');
  process.exit(0);
});

module.exports = { children };
