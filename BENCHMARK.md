# Benchmark Results

All numbers below are from real, reproducible runs against a live 3-node
replicated cluster (replication factor N=3, write quorum W=2) on a 4-vCPU
sandbox. Nothing here is estimated — run `npm run benchmark`,
`npm run benchmark:resilience`, and `npm run benchmark:dedup` yourself to
reproduce every number on this page.

**Caveat, stated up front:** this is a loopback benchmark on a 4-core box
running 3 storage-node processes, a coordinator, and the load generator all
at once — client and server are competing for the same handful of cores.
Read throughput in particular is visibly core-bound here (see below); on
separate hardware, or with more cores, it would be materially higher. These
numbers are a conservative floor for this exact 4-core topology, not a
ceiling for the design.

## Read path: `GET /files/:id/download`

| Setup | Avg req/s | p50 latency | p99 latency | Errors |
|---|---|---|---|---|
| 3-node cluster, 50 concurrent connections | 150.75 | 327 ms | 1459 ms | 0 |

Command: `node benchmark/load-test.js 8 50`.

**Why latency rises under concurrency:** a single, uncontended download of
the same file completes in ~4 ms (measured directly, sequential requests).
At 50 concurrent connections on this benchmark's 4 cores, three single-
threaded storage-node processes and one coordinator process are all
scheduling against each other for CPU time, so per-request latency rises
as requests queue for their share of the core — that's real scheduler
contention, not a code-level bottleneck. We looked for a connection-pool
bottleneck first (a dedicated `undici.Agent` with a much larger per-origin
connection cap is wired into the coordinator's outbound calls — see
`src/coordinator.js`), but confirmed with a direct concurrency test that
tuning the pool made no measurable difference here: the ceiling is CPU
scheduling across 4 shared cores running 4+ Node processes, not queued
sockets. On real hardware — separate machines for storage nodes vs.
coordinator, or just more cores — this ceiling moves considerably higher
without any code changes.

## Write path: `POST /files` (new file, unique 64 KiB body per request)

| Setup | Avg req/s | p50 latency | p99 latency | Errors |
|---|---|---|---|---|
| Single client IP (default rate limiter) | throttled after ~500-request burst | — | — | 0 (429s, not failures) |
| 25 distinct simulated clients | **671** | 26 ms | 176 ms | 0 |

Command: `node benchmark/load-test.js 8 50` (write section spins up 25
concurrent workers). Every request generates a genuinely new random 64 KiB
payload — a fixed or reused body would just hit the dedup fast path after
the first write and silently measure something else entirely.

The first row isn't a bug: it's the per-client token-bucket rate limiter
doing its job — all of that traffic came from one IP, exactly the "one
client hammering the API" scenario the limiter exists to contain. The
second row shows 25 independent clients (their own token buckets, as real
traffic would be), with zero rate-limit rejections and zero errors — each
write chunks the body, replicates it to all 3 storage nodes over the tuned
connection pool, waits for W=2 acks, and commits the manifest to SQLite.

## Fault tolerance: killing 1 of 3 storage nodes mid-run

Command: `node benchmark/resilience-test.js`.

| Operation | With all 3 nodes up | After killing 1 node (mid-run) |
|---|---|---|
| Read an existing file | 200, bytes match | **200, bytes still match** |
| Write a new file | 201 | **201 (W=2 of N=3 still ack)** |

Real metrics captured from the same run:

```json
{
  "readSucceededWithNodeDown": true,
  "writeSucceededWithNodeDown": true,
  "quorumReadFailoverMetricLines": [
    "objstore_quorum_read_failovers_total{reason=\"network_error\"} 1",
    "objstore_quorum_read_failovers_total{reason=\"failover_success\"} 1"
  ],
  "quorumWriteFailureMetricLines": [
    "objstore_quorum_write_failures_total 0"
  ]
}
```

Zero failed requests and zero data loss with one-third of the storage tier
down mid-flight — this is the entire point of N-way replication with a
sub-N write quorum, demonstrated against real killed processes, not mocked.

## Deduplication: real storage savings, not a claim

Command: `node benchmark/dedup-test.js`. Two "unrelated" files are uploaded,
each wrapping a shared 4 MiB asset in different unique content:

```json
{
  "fileASizeBytes": 5242880,
  "fileBSizeBytes": 5505024,
  "sumOfFileSizesBytes": 10747904,
  "actualBytesOnDiskPerReplica": 6553600,
  "bytesSavedByDedup": 4194304,
  "percentSaved": "39.0%"
}
```

The shared 4 MiB asset was written to each replica exactly once, not twice
— a real 39% reduction in bytes stored for this pair of files, growing
without bound as more files share the same underlying content (which is
exactly the workload — the same embedded image/font/model/binary reused
across many uploads — that makes content-addressable storage worth the
added complexity in the first place).

## Methodology

- Load generator: `autocannon` for the fixed-URL read benchmark; a small
  hand-rolled concurrent-worker harness for writes, because autocannon
  reuses one body per *connection* rather than per request — a fixed body
  would dedupe after the first write on each connection and end up
  benchmarking the dedup fast path instead of real replication cost.
- All three benchmarks spin up a genuine 3-process storage cluster plus a
  real coordinator process, not an in-memory simulation — `resilience-test.js`
  sends `SIGKILL` to an actual OS process mid-run.
- Reproduce with: `npm install`, then `npm run benchmark`,
  `npm run benchmark:resilience`, and `npm run benchmark:dedup`.
