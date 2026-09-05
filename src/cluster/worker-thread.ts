import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CommandHandler } from '../command-handler.ts';
import { RespSerializer } from '../resp-serializer.ts';
import { StorageEngine } from '../storage-engine.ts';
import type { StorageEngineOptions } from '../storage-engine.ts';
import type { RespValue } from '../types.ts';
import { AtomicMutex } from './atomic-lock.ts';

export interface WorkerInitData {
  shardId: number;
  totalShards: number;
  sharedLockBuffer: SharedArrayBuffer;
  engineOptions?: StorageEngineOptions;
}

export type WorkerMessage =
  | { id: number; type: 'EXECUTE'; command: RespValue }
  | { id: number; type: 'CROSS_SHARD_DEL'; keys: string[] }
  | { id: number; type: 'STATS' }
  | { id: number; type: 'SAMPLE_KEYS'; limit?: number }
  | { type: 'SHUTDOWN' };

export type MasterMessage =
  | { id: number; type: 'RESPONSE'; response: Buffer; shouldClose?: boolean }
  | { id: number; type: 'CROSS_SHARD_DEL_RESPONSE'; count: number }
  | { id: number; type: 'STATS_RESPONSE'; stats: { size: number; expiresCount: number; hits: number; misses: number; totalOps: number } }
  | { id: number; type: 'SAMPLE_KEYS_RESPONSE'; keys: Array<{ key: string; sizeBytes: number; ttlRemainingMs: number }> }
  | { id: number; type: 'ERROR'; error: string };

if (!isMainThread && parentPort) {
  const data = workerData as WorkerInitData;
  const shardId = data.shardId;
  const engine = new StorageEngine(data.engineOptions);
  const mutex = new AtomicMutex(data.sharedLockBuffer);

  parentPort.on('message', async (msg: WorkerMessage) => {
    if (msg.type === 'SHUTDOWN') {
      engine.stopTtlSweep();
      process.exit(0);
    }

    if (msg.type === 'EXECUTE') {
      try {
        const result = await CommandHandler.execute(msg.command, engine);
        parentPort!.postMessage({
          id: msg.id,
          type: 'RESPONSE',
          response: result.response,
          shouldClose: result.shouldClose,
        } as MasterMessage);
      } catch (err: any) {
        parentPort!.postMessage({
          id: msg.id,
          type: 'ERROR',
          error: err.message || 'Worker execution error',
        } as MasterMessage);
      }
      return;
    }

    if (msg.type === 'CROSS_SHARD_DEL') {
      try {
        // Acquire this shard's atomic lock to ensure consistency during multi-shard delete
        mutex.acquire(shardId);
        let deletedCount = 0;
        try {
          deletedCount = engine.del(...msg.keys);
        } finally {
          mutex.release(shardId);
        }

        parentPort!.postMessage({
          id: msg.id,
          type: 'CROSS_SHARD_DEL_RESPONSE',
          count: deletedCount,
        } as MasterMessage);
      } catch (err: any) {
        parentPort!.postMessage({
          id: msg.id,
          type: 'ERROR',
          error: err.message || 'Cross-shard delete error',
        } as MasterMessage);
      }
      return;
    }

    if (msg.type === 'STATS') {
      parentPort!.postMessage({
        id: msg.id,
        type: 'STATS_RESPONSE',
        stats: engine.getStats(),
      } as MasterMessage);
      return;
    }

    if (msg.type === 'SAMPLE_KEYS') {
      parentPort!.postMessage({
        id: msg.id,
        type: 'SAMPLE_KEYS_RESPONSE',
        keys: engine.sampleKeys(msg.limit ?? 64),
      } as MasterMessage);
      return;
    }
  });
}
