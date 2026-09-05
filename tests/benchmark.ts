import * as net from 'node:net';
import * as os from 'node:os';
import { RespServer } from '../src/server.ts';
import { ClusterServer } from '../src/cluster/cluster-server.ts';
import { RespParser } from '../src/resp-parser.ts';

interface BenchmarkResult {
  name: string;
  totalOps: number;
  durationMs: number;
  opsPerSec: number;
  avgLatencyMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

class BenchmarkClient {
  private socket!: net.Socket;
  private parser = new RespParser();
  private pendingResolvers: Array<() => void> = [];

  public connect(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ port, host }, () => {
        this.socket.setNoDelay(true);
        resolve();
      });
      this.socket.once('error', reject);

      this.socket.on('data', (chunk: Buffer) => {
        const parsed = this.parser.execute(chunk);
        for (let i = 0; i < parsed.length; i++) {
          const resolveFn = this.pendingResolvers.shift();
          if (resolveFn) resolveFn();
        }
      });
    });
  }

  public sendPipelined(commands: Buffer[]): Promise<void> {
    return new Promise((resolve) => {
      let resolvedCount = 0;
      const targetCount = commands.length;

      for (let i = 0; i < targetCount; i++) {
        this.pendingResolvers.push(() => {
          resolvedCount++;
          if (resolvedCount === targetCount) {
            resolve();
          }
        });
      }

      const payload = Buffer.concat(commands);
      this.socket.write(payload);
    });
  }

  public close(): void {
    if (this.socket) {
      this.socket.destroy();
    }
  }
}

function calculatePercentiles(latencies: number[]): { avg: number; p50: number; p95: number; p99: number } {
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((acc, v) => acc + v, 0);
  const avg = sum / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.50)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  return { avg, p50, p95, p99 };
}

async function runWorkload(
  name: string,
  port: number,
  totalOps: number,
  concurrency: number,
  pipelineBatchSize: number,
  commandGenerator: (idx: number) => Buffer
): Promise<BenchmarkResult> {
  const clients: BenchmarkClient[] = [];
  for (let i = 0; i < concurrency; i++) {
    const client = new BenchmarkClient();
    await client.connect(port);
    clients.push(client);
  }

  const latencies: number[] = [];
  const opsPerClient = Math.floor(totalOps / concurrency);
  const startTime = process.hrtime.bigint();

  const promises = clients.map(async (client, clientIdx) => {
    const startIdx = clientIdx * opsPerClient;
    const endIdx = startIdx + opsPerClient;

    for (let i = startIdx; i < endIdx; i += pipelineBatchSize) {
      const batchSize = Math.min(pipelineBatchSize, endIdx - i);
      const batch: Buffer[] = [];
      for (let j = 0; j < batchSize; j++) {
        batch.push(commandGenerator(i + j));
      }

      const t0 = performance.now();
      await client.sendPipelined(batch);
      const t1 = performance.now();
      const perOpLatency = (t1 - t0) / batchSize;
      for (let j = 0; j < batchSize; j++) {
        latencies.push(perOpLatency);
      }
    }
  });

  await Promise.all(promises);
  const endTime = process.hrtime.bigint();
  const durationMs = Number(endTime - startTime) / 1_000_000;

  for (const client of clients) {
    client.close();
  }

  const { avg, p50, p95, p99 } = calculatePercentiles(latencies);
  const opsPerSec = Math.round((totalOps / (durationMs / 1000)));

  return {
    name,
    totalOps,
    durationMs,
    opsPerSec,
    avgLatencyMs: avg,
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
  };
}

function printResultsTable(results: BenchmarkResult[]): void {
  console.log('\n================================================================================================');
  console.log('| Workload / Configuration             | Ops/sec   | Duration  | Avg Latency | p50    | p95    | p99    |');
  console.log('================================================================================================');
  for (const r of results) {
    const name = r.name.padEnd(36);
    const ops = r.opsPerSec.toLocaleString().padStart(9);
    const dur = `${(r.durationMs / 1000).toFixed(2)}s`.padStart(9);
    const avg = `${r.avgLatencyMs.toFixed(3)}ms`.padStart(11);
    const p50 = `${r.p50Ms.toFixed(3)}ms`.padStart(6);
    const p95 = `${r.p95Ms.toFixed(3)}ms`.padStart(6);
    const p99 = `${r.p99Ms.toFixed(3)}ms`.padStart(6);
    console.log(`| ${name} | ${ops} | ${dur} | ${avg} | ${p50} | ${p95} | ${p99} |`);
  }
  console.log('================================================================================================\n');
}

async function main() {
  console.log('================================================================================================');
  console.log('                 RadixKV High-Performance In-Memory Engine Benchmark                           ');
  console.log(`                 Platform: ${os.type()} ${os.arch()} | Available CPUs: ${os.cpus().length}     `);
  console.log('================================================================================================');

  const TOTAL_OPS = 50_000;
  const CONCURRENCY = 8;
  const PIPELINE_BATCH = 50;

  const results: BenchmarkResult[] = [];

  // 1. Single-Threaded Server Benchmark
  console.log('\n[1/2] Benchmarking Single-Threaded Core Server...');
  const singlePort = 6490;
  const singleServer = new RespServer({ port: singlePort, aofEnabled: false });
  await singleServer.start();

  // Single Core: SET
  results.push(await runWorkload(
    'Single-Core: 100% SET',
    singlePort,
    TOTAL_OPS,
    CONCURRENCY,
    PIPELINE_BATCH,
    (i) => Buffer.from(`*3\r\n$3\r\nSET\r\n$${`key_${i}`.length}\r\nkey_${i}\r\n$${`val_${i}`.length}\r\nval_${i}\r\n`)
  ));

  // Single Core: GET
  results.push(await runWorkload(
    'Single-Core: 100% GET',
    singlePort,
    TOTAL_OPS,
    CONCURRENCY,
    PIPELINE_BATCH,
    (i) => Buffer.from(`*2\r\n$3\r\nGET\r\n$${`key_${i}`.length}\r\nkey_${i}\r\n`)
  ));

  // Single Core: INCR
  results.push(await runWorkload(
    'Single-Core: 100% INCR',
    singlePort,
    TOTAL_OPS,
    CONCURRENCY,
    PIPELINE_BATCH,
    (i) => Buffer.from(`*2\r\n$4\r\nINCR\r\n$${`counter_${i % 1000}`.length}\r\ncounter_${i % 1000}\r\n`)
  ));

  await singleServer.stop();

  // 2. Multi-Core Cluster Server Benchmark
  const workerCount = Math.min(os.cpus().length, 4);
  console.log(`\n[2/2] Benchmarking Multi-Core ClusterServer (${workerCount} Worker Threads, 150 vnodes/shard)...`);
  const clusterPort = 6491;
  const clusterServer = new ClusterServer({
    port: clusterPort,
    shardCount: workerCount,
    vnodesPerNode: 150,
  });
  await clusterServer.start();

  // Multi-Core: SET
  results.push(await runWorkload(
    `Cluster (${workerCount} workers): 100% SET`,
    clusterPort,
    TOTAL_OPS,
    CONCURRENCY,
    PIPELINE_BATCH,
    (i) => Buffer.from(`*3\r\n$3\r\nSET\r\n$${`key_${i}`.length}\r\nkey_${i}\r\n$${`val_${i}`.length}\r\nval_${i}\r\n`)
  ));

  // Multi-Core: GET
  results.push(await runWorkload(
    `Cluster (${workerCount} workers): 100% GET`,
    clusterPort,
    TOTAL_OPS,
    CONCURRENCY,
    PIPELINE_BATCH,
    (i) => Buffer.from(`*2\r\n$3\r\nGET\r\n$${`key_${i}`.length}\r\nkey_${i}\r\n`)
  ));

  // Multi-Core: Cross-Shard Multi-Key Atomic DEL
  const multiKeyOps = 10_000;
  results.push(await runWorkload(
    `Cluster (${workerCount} workers): Cross-Shard DEL`,
    clusterPort,
    multiKeyOps,
    CONCURRENCY,
    20,
    (i) => {
      const k1 = `key_${i}`;
      const k2 = `key_${i + 1}`;
      const k3 = `key_${i + 2}`;
      return Buffer.from(`*4\r\n$3\r\nDEL\r\n$${k1.length}\r\n${k1}\r\n$${k2.length}\r\n${k2}\r\n$${k3.length}\r\n${k3}\r\n`);
    }
  ));

  await clusterServer.stop();

  printResultsTable(results);
}

main().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
