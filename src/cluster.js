'use strict';

const cluster = require('node:cluster');
const os = require('node:os');

/**
 * Forks one coordinator worker per CPU core. The coordinator itself is
 * stateless with respect to chunk data (all durable state lives in the
 * storage nodes + the metadata DB), so scaling it horizontally is just
 * "run more of it" behind a load balancer — the same shape as scaling the
 * URL-shortener API layer, and the same shape as scaling any stateless
 * service tier in production.
 *
 * The one piece of per-worker state is the metadata SQLite file: each
 * worker in this reference setup opens its own connection to the same file
 * on disk. That's fine for the benchmark (SQLite handles concurrent
 * readers/single-writer reasonably at this scale) and is called out in the
 * README as the seam where a real deployment would swap in a shared
 * metadata service (Postgres, DynamoDB, etc.) instead.
 */
if (cluster.isPrimary) {
  const numWorkers = Number(process.env.WEB_CONCURRENCY || os.availableParallelism());
  console.log(`[primary ${process.pid}] forking ${numWorkers} coordinator worker(s)`);

  for (let i = 0; i < numWorkers; i += 1) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[primary] worker ${worker.process.pid} exited (code=${code}, signal=${signal}) — restarting`);
    cluster.fork();
  });

  process.on('SIGTERM', () => {
    console.log('[primary] SIGTERM received, shutting down workers');
    for (const worker of Object.values(cluster.workers)) worker.process.kill('SIGTERM');
    process.exit(0);
  });
} else {
  const { buildServer } = require('./server');
  // Deliberately the SAME path across every worker, not one per worker —
  // metadata (which file has which chunks) must be visible to whichever
  // worker happens to handle the next request. A single SQLite file shared
  // by N processes is a real scaling ceiling (effectively one writer at a
  // time); it's fine at this benchmark's scale and is called out in the
  // README as the seam where a shared metadata service (Postgres, etc.)
  // would take over in a real multi-machine deployment.
  const { app } = buildServer({ dbPath: process.env.DB_PATH || './data/metadata.sqlite' });
  const port = Number(process.env.PORT || 3000);
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`[worker ${process.pid}] coordinator listening on ${address}`);
  });
}
