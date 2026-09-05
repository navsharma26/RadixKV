import * as os from 'node:os';
import { RespServer } from './server.ts';
import { ClusterServer } from './cluster/cluster-server.ts';

export * from './types.ts';
export * from './byte-buffer.ts';
export * from './lru-list.ts';
export * from './storage-engine.ts';
export * from './resp-parser.ts';
export * from './resp-serializer.ts';
export * from './command-handler.ts';
export * from './connection.ts';
export * from './server.ts';
export * from './aof-logger.ts';
export * from './aof-recovery.ts';
export * from './bson-encoder.ts';
export * from './cold-storage-worker.ts';
export * from './cluster/consistent-hash.ts';
export * from './cluster/atomic-lock.ts';
export * from './cluster/cluster-coordinator.ts';
export * from './cluster/cluster-server.ts';
export * from './telemetry/telemetry-collector.ts';
export * from './telemetry/telemetry-server.ts';

/**
 * CLI execution entrypoint when run directly
 */
async function main() {
  const args = process.argv.slice(2);
  const isCluster = args.includes('--cluster') ||
    process.env.CLUSTER === 'true' ||
    process.env.CLUSTER === '1' ||
    process.env.CLUSTER_MODE === 'true';

  const isTelemetry = args.includes('--telemetry') ||
    args.includes('--dashboard') ||
    process.env.TELEMETRY === 'true' ||
    process.env.TELEMETRY === '1';

  const port = parseInt(process.env.PORT || '6379', 10);
  const host = process.env.HOST || '127.0.0.1';
  const telemetryPort = parseInt(process.env.TELEMETRY_PORT || '3000', 10);

  let workers = os.cpus().length;
  const workersArgIdx = args.indexOf('--workers');
  if (workersArgIdx !== -1 && args[workersArgIdx + 1]) {
    workers = parseInt(args[workersArgIdx + 1], 10);
  } else if (process.env.WORKERS) {
    workers = parseInt(process.env.WORKERS, 10);
  }

  if (isCluster || isTelemetry) {
    console.log(`[RadixKV] Starting in MULTI-CORE CLUSTER MODE...`);
    console.log(`[RadixKV] Spawning ${workers} worker threads partitioned via Consistent Hash Ring (150 vnodes/shard)...`);

    const server = new ClusterServer({
      port,
      host,
      shardCount: workers,
      vnodesPerNode: 150,
      telemetryEnabled: isTelemetry,
      telemetryPort,
    });

    try {
      const addr = await server.start();
      console.log(`[RadixKV] Cluster TCP Server listening on ${addr.host}:${addr.port}`);
      console.log(`[RadixKV] Ready to accept Redis client connections on ${workers} CPU cores`);
      if (isTelemetry) {
        console.log(`[RadixKV] Observability Cockpit & Telemetry Control Plane: http://localhost:${telemetryPort}`);
        console.log(`[RadixKV] Real-Time WebSocket Telemetry Stream: ws://localhost:${telemetryPort}/ws`);
      }
    } catch (err) {
      console.error(`[RadixKV] Failed to start cluster server:`, err);
      process.exit(1);
    }

    const shutdown = async (signal: string) => {
      console.log(`\n[RadixKV] Received ${signal}. Initiating graceful cluster teardown...`);
      try {
        await server.stop();
        console.log(`[RadixKV] Graceful teardown complete. Exiting.`);
        process.exit(0);
      } catch (err) {
        console.error(`[RadixKV] Error during cluster teardown:`, err);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } else {
    console.log(`[RadixKV] Starting in SINGLE-THREADED CORE MODE (with AOF durability & LRU)...`);

    const server = new RespServer({
      port,
      host,
      idleTimeoutMs: 300_000,
      shutdownTimeoutMs: 5_000,
    });

    server.on('error', (err) => {
      console.error(`[RadixKV] [ERROR] ${err.message}`, err);
    });

    server.on('protocolError', (details) => {
      console.warn(`[RadixKV] [PROTOCOL_ERROR] Connection ${details.connectionId}: ${details.message} (${details.code})`);
    });

    try {
      const addr = await server.start();
      console.log(`[RadixKV] Listening on ${addr.host}:${addr.port}`);
      console.log(`[RadixKV] Ready to accept Redis client connections (PING, ECHO, SET, GET, DEL, INCR, TTL, QUIT)`);
    } catch (err) {
      console.error(`[RadixKV] Failed to start server:`, err);
      process.exit(1);
    }

    const shutdown = async (signal: string) => {
      console.log(`\n[RadixKV] Received ${signal}. Initiating graceful teardown...`);
      try {
        await server.stop();
        console.log(`[RadixKV] Graceful teardown complete. Exiting.`);
        process.exit(0);
      } catch (err) {
        console.error(`[RadixKV] Error during teardown:`, err);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// If invoked as the primary script
if (process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))) {
  main().catch((err) => {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  });
}
