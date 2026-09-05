import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RespSerializer } from '../resp-serializer.ts';
import type { StorageEngineOptions } from '../storage-engine.ts';
import type { CommandExecutionResult, RespValue } from '../types.ts';
import { AtomicMultiLock, AtomicMutex } from './atomic-lock.ts';
import { ConsistentHashRing } from './consistent-hash.ts';
import type { MasterMessage, WorkerInitData, WorkerMessage } from './worker-thread.ts';

export interface ClusterCoordinatorOptions {
  /** Number of worker thread shards. Default: os.cpus().length or 4 */
  shardCount?: number;
  /** Number of virtual nodes per shard on the hash ring. Default: 150 */
  vnodesPerNode?: number;
  /** StorageEngine options passed to each shard */
  engineOptions?: StorageEngineOptions;
}

interface PendingRpc {
  resolve: (res: any) => void;
  reject: (err: any) => void;
}

/**
 * Master cluster coordinator.
 * Features:
 * - Distributes keys across worker threads using a Consistent Hash Ring with 150 vnodes.
 * - Manages non-blocking MessagePort RPC pipelines with request-response correlation.
 * - Coordinates thread-safe cross-shard multi-key operations using AtomicMultiLock.
 */
export class ClusterCoordinator {
  public readonly shardCount: number;
  public readonly ring: ConsistentHashRing;

  private readonly workers: Worker[] = [];
  private readonly mutex: AtomicMutex;
  private readonly multiLock: AtomicMultiLock;
  private readonly pendingRpcs: Map<number, PendingRpc> = new Map();
  private nextRpcId: number = 0;
  private isInitialized: boolean = false;

  constructor(options: ClusterCoordinatorOptions = {}) {
    this.shardCount = options.shardCount ?? Math.max(2, os.cpus().length);
    this.ring = new ConsistentHashRing({ vnodesPerNode: options.vnodesPerNode ?? 150 });

    // Allocate SharedArrayBuffer with 1 slot per shard for futex locking
    this.mutex = new AtomicMutex(this.shardCount);
    this.multiLock = new AtomicMultiLock(this.mutex);

    // Register all shards on consistent hash ring
    for (let i = 0; i < this.shardCount; i++) {
      this.ring.addNode(`shard-${i}`);
    }
  }

  /**
   * Spawns worker threads and establishes communication ports.
   */
  public async init(engineOptions?: StorageEngineOptions): Promise<void> {
    if (this.isInitialized) return;

    // Resolve path to worker-thread.ts relative to current module
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const workerScriptPath = path.join(currentDir, 'worker-thread.ts');

    for (let i = 0; i < this.shardCount; i++) {
      const initData: WorkerInitData = {
        shardId: i,
        totalShards: this.shardCount,
        sharedLockBuffer: this.mutex.sharedBuffer,
        engineOptions,
      };

      const worker = new Worker(workerScriptPath, {
        workerData: initData,
        execArgv: ['--experimental-strip-types'],
      });

      worker.on('message', (msg: MasterMessage) => {
        this.handleWorkerMessage(msg);
      });

      worker.on('error', (err) => {
        console.error(`[ClusterCoordinator] Worker ${i} error:`, err);
      });

      this.workers.push(worker);
    }

    this.isInitialized = true;
  }

  /**
   * Routes a parsed RESP command to the appropriate worker shard based on key hashing.
   * Cross-shard commands (e.g. multi-key DEL) are synchronized using AtomicMultiLock.
   */
  public async execute(val: RespValue): Promise<CommandExecutionResult> {
    const commandInfo = this.extractCommandInfo(val);
    if (!commandInfo) {
      return {
        response: RespSerializer.error('Invalid command structure'),
      };
    }

    const { commandName, keys } = commandInfo;

    // 1. Commands with no keys (PING, ECHO, QUIT, COMMAND) -> handle locally or dispatch to shard 0
    if (keys.length === 0) {
      return this.sendToWorker(0, {
        id: ++this.nextRpcId,
        type: 'EXECUTE',
        command: val,
      });
    }

    // 2. Single-key commands (GET, SET, INCR, TTL) or single-key DEL -> deterministic hash routing
    if (keys.length === 1) {
      const targetShardId = this.getShardForKey(keys[0]);
      return this.sendToWorker(targetShardId, {
        id: ++this.nextRpcId,
        type: 'EXECUTE',
        command: val,
      });
    }

    // 3. Multi-key command (e.g., DEL key1 key2 ...): check if cross-shard
    if (commandName === 'DEL') {
      return this.executeCrossShardDel(keys);
    }

    // Default fallback to first key's shard
    const defaultShardId = this.getShardForKey(keys[0]);
    return this.sendToWorker(defaultShardId, {
      id: ++this.nextRpcId,
      type: 'EXECUTE',
      command: val,
    });
  }

  /**
   * Coordinates atomic, cross-shard multi-key DEL with deadlock-free multi-locking.
   */
  private async executeCrossShardDel(keys: string[]): Promise<CommandExecutionResult> {
    // Group keys by owning shard
    const shardKeyMap = new Map<number, string[]>();
    for (const key of keys) {
      const shardId = this.getShardForKey(key);
      const existing = shardKeyMap.get(shardId) ?? [];
      existing.push(key);
      shardKeyMap.set(shardId, existing);
    }

    const involvedShards = Array.from(shardKeyMap.keys());

    // Single shard fast-path
    if (involvedShards.length === 1) {
      const shardId = involvedShards[0];
      return this.sendToWorker(shardId, {
        id: ++this.nextRpcId,
        type: 'CROSS_SHARD_DEL',
        keys: shardKeyMap.get(shardId)!,
      }).then((count) => ({
        response: RespSerializer.integer(count),
      }));
    }

    // Multi-shard cross-operation: acquire atomic multi-lock across all involved shards
    return this.multiLock.withMultiLock(involvedShards, async () => {
      // Fan out sub-deletions in parallel to all involved shards
      const promises = involvedShards.map((shardId) => {
        const subKeys = shardKeyMap.get(shardId)!;
        return this.sendToWorker(shardId, {
          id: ++this.nextRpcId,
          type: 'CROSS_SHARD_DEL',
          keys: subKeys,
        });
      });

      const counts = await Promise.all(promises);
      const totalDeleted = counts.reduce((acc, c) => acc + c, 0);

      return {
        response: RespSerializer.integer(totalDeleted),
      };
    });
  }

  /**
   * Deterministically identifies which worker shard owns a key via Consistent Hash Ring.
   */
  public getShardForKey(key: string): number {
    const nodeStr = this.ring.getNode(key); // e.g. "shard-2"
    return parseInt(nodeStr.replace('shard-', ''), 10);
  }

  /**
   * Sends an RPC message to a specific worker thread via MessagePort.
   */
  private sendToWorker<T = any>(shardId: number, msg: WorkerMessage): Promise<T> {
    const worker = this.workers[shardId];
    if (!worker) {
      return Promise.reject(new Error(`Worker shard ${shardId} does not exist`));
    }

    const id = (msg as any).id;
    return new Promise<T>((resolve, reject) => {
      this.pendingRpcs.set(id, { resolve, reject });
      worker.postMessage(msg);
    });
  }

  /**
   * Dispatches incoming worker responses to matching RPC callers.
   */
  private handleWorkerMessage(msg: MasterMessage): void {
    const pending = this.pendingRpcs.get(msg.id);
    if (!pending) return;

    this.pendingRpcs.delete(msg.id);

    if (msg.type === 'RESPONSE') {
      pending.resolve({
        response: msg.response,
        shouldClose: msg.shouldClose,
      });
    } else if (msg.type === 'CROSS_SHARD_DEL_RESPONSE') {
      pending.resolve(msg.count);
    } else if (msg.type === 'STATS_RESPONSE') {
      pending.resolve(msg.stats);
    } else if (msg.type === 'SAMPLE_KEYS_RESPONSE') {
      pending.resolve(msg.keys);
    } else if (msg.type === 'ERROR') {
      pending.reject(new Error(msg.error));
    }
  }

  /**
   * Queries all worker shards in parallel for statistics
   */
  public async getClusterStats(): Promise<{
    totalKeys: number;
    totalExpires: number;
    hits: number;
    misses: number;
    totalOps: number;
    hitRatio: number;
    shards: Array<{ shardId: number; size: number; expiresCount: number; hits: number; misses: number; totalOps: number }>;
  }> {
    const shardStatsPromises = this.workers.map((_, idx) =>
      this.sendToWorker<{ size: number; expiresCount: number; hits: number; misses: number; totalOps: number }>(idx, {
        id: ++this.nextRpcId,
        type: 'STATS',
      })
    );

    const statsList = await Promise.all(shardStatsPromises);
    let totalKeys = 0;
    let totalExpires = 0;
    let hits = 0;
    let misses = 0;
    let totalOps = 0;

    const shards = statsList.map((s, idx) => {
      totalKeys += s.size;
      totalExpires += s.expiresCount;
      hits += s.hits;
      misses += s.misses;
      totalOps += s.totalOps;
      return { shardId: idx, ...s };
    });

    const totalReads = hits + misses;
    const hitRatio = totalReads > 0 ? hits / totalReads : 1.0;

    return {
      totalKeys,
      totalExpires,
      hits,
      misses,
      totalOps,
      hitRatio,
      shards,
    };
  }

  /**
   * Samples keys across all shards for memory layout visualization
   */
  public async sampleClusterKeys(limitPerShard: number = 20): Promise<Array<{
    shardId: number;
    key: string;
    sizeBytes: number;
    ttlRemainingMs: number;
  }>> {
    const samplePromises = this.workers.map((_, idx) =>
      this.sendToWorker<Array<{ key: string; sizeBytes: number; ttlRemainingMs: number }>>(idx, {
        id: ++this.nextRpcId,
        type: 'SAMPLE_KEYS',
        limit: limitPerShard,
      }).then((keys) => keys.map((k) => ({ shardId: idx, ...k })))
    );

    const results = await Promise.all(samplePromises);
    return results.flat();
  }

  /**
   * Parses a raw text command line (e.g. `SET user:1 "Alice Bob" EX 60`),
   * executes it on the cluster, and returns execution timing and formatted output.
   */
  public async executeRawCommand(commandLine: string): Promise<{
    rawResponse: Buffer;
    formattedOutput: string;
    latencyUs: number;
    commandName: string;
  }> {
    const tokens = this.tokenizeCommandLine(commandLine);
    if (tokens.length === 0) {
      throw new Error('Empty command');
    }

    const respVal: RespValue = {
      type: 'array',
      value: tokens.map((t) => ({
        type: 'bulk_string',
        value: Buffer.from(t, 'utf-8'),
      })),
    };

    const t0 = process.hrtime.bigint();
    const result = await this.execute(respVal);
    const t1 = process.hrtime.bigint();
    const latencyUs = Number(t1 - t0) / 1000;

    const formatted = this.formatRespResponse(result.response);
    return {
      rawResponse: result.response,
      formattedOutput: formatted,
      latencyUs,
      commandName: tokens[0].toUpperCase(),
    };
  }

  private tokenizeCommandLine(line: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if ((char === '"' || char === "'") && (!inQuotes || quoteChar === char)) {
        inQuotes = !inQuotes;
        quoteChar = inQuotes ? char : '';
      } else if (char === ' ' && !inQuotes) {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current.length > 0) {
      tokens.push(current);
    }

    return tokens;
  }

  private formatRespResponse(buf: Buffer): string {
    const safeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const str = safeBuf.toString('utf-8');
    if (str.startsWith('+')) {
      return str.slice(1, -2); // Simple String: "OK"
    }
    if (str.startsWith('-')) {
      return `(error) ${str.slice(1, -2)}`; // Error
    }
    if (str.startsWith(':')) {
      return `(integer) ${str.slice(1, -2)}`; // Integer
    }
    if (str.startsWith('$-1\r\n')) {
      return '(nil)'; // Null Bulk String
    }
    if (str.startsWith('$')) {
      // Bulk string: $len\r\nbody\r\n
      const crlfIdx = str.indexOf('\r\n');
      if (crlfIdx !== -1) {
        return `"${str.substring(crlfIdx + 2, str.length - 2)}"`;
      }
    }
    return str.trim();
  }

  /**
   * Parses command name and keys from RespValue.
   */
  private extractCommandInfo(val: RespValue): { commandName: string; keys: string[] } | null {
    if (val.type === 'array' && val.value) {
      if (val.value.length === 0) return null;
      const cmdItem = val.value[0];
      const cmdBuf = cmdItem.type === 'bulk_string' && cmdItem.value
        ? (Buffer.isBuffer(cmdItem.value) ? cmdItem.value : Buffer.from(cmdItem.value))
        : null;
      const cmdName = cmdBuf ? cmdBuf.toString('utf-8').toUpperCase() : '';

      const keys: string[] = [];
      // Redis command key positions:
      // SET key ..., GET key, DEL key1 key2, INCR key, TTL key
      if (['GET', 'SET', 'INCR', 'TTL'].includes(cmdName) && val.value.length >= 2) {
        const keyItem = val.value[1];
        if (keyItem.type === 'bulk_string' && keyItem.value) {
          const kBuf = Buffer.isBuffer(keyItem.value) ? keyItem.value : Buffer.from(keyItem.value);
          keys.push(kBuf.toString('utf-8'));
        }
      } else if (cmdName === 'DEL') {
        for (let i = 1; i < val.value.length; i++) {
          const item = val.value[i];
          if (item.type === 'bulk_string' && item.value) {
            const kBuf = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
            keys.push(kBuf.toString('utf-8'));
          }
        }
      }

      return { commandName: cmdName, keys };
    }

    return null;
  }

  /**
   * Gracefully terminates all worker threads.
   */
  public async close(): Promise<void> {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'SHUTDOWN' } as WorkerMessage);
    }

    await Promise.all(
      this.workers.map((worker) => worker.terminate())
    );
    this.workers.length = 0;
    this.pendingRpcs.clear();
    this.isInitialized = false;
  }
}
