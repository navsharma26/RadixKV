import * as zlib from 'node:zlib';
import { BsonCodec } from './bson-encoder.ts';
import { StorageEngine } from './storage-engine.ts';

export interface CompressedSnapshot {
  snapshotId: string;
  timestamp: Date;
  keyCount: number;
  uncompressedBsonBytes: number;
  compressedBytes: number;
  compressedData: Buffer;
}

/**
 * Interface for MongoDB cold-storage sinks.
 */
export interface IMongoColdStorageSink {
  saveSnapshot(snapshot: CompressedSnapshot): Promise<void>;
}

/**
 * In-memory / mock cold storage sink for zero-dependency standalone usage and testing.
 */
export class InMemoryColdStorageSink implements IMongoColdStorageSink {
  public readonly snapshots: CompressedSnapshot[] = [];

  public async saveSnapshot(snapshot: CompressedSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }

  public get count(): number {
    return this.snapshots.length;
  }

  public clear(): void {
    this.snapshots.length = 0;
  }
}

/**
 * Production MongoDB driver sink adapter compatible with official mongodb collection.
 */
export class MongoDriverColdStorageSink implements IMongoColdStorageSink {
  private readonly collection: { insertOne: (doc: any) => Promise<any> };

  constructor(collection: { insertOne: (doc: any) => Promise<any> }) {
    this.collection = collection;
  }

  public async saveSnapshot(snapshot: CompressedSnapshot): Promise<void> {
    await this.collection.insertOne({
      _id: snapshot.snapshotId,
      timestamp: snapshot.timestamp,
      keyCount: snapshot.keyCount,
      uncompressedBsonBytes: snapshot.uncompressedBsonBytes,
      compressedBytes: snapshot.compressedBytes,
      data: snapshot.compressedData,
      archivedAt: new Date(),
    });
  }
}

export interface ColdStorageWorkerOptions {
  engine: StorageEngine;
  sink: IMongoColdStorageSink;
  /** Period in ms between cold storage snapshots. Default: 60,000 (1 minute) */
  intervalMs?: number;
  /** Maximum number of cold keys to package into each snapshot. Default: 500 */
  batchSize?: number;
  /** Whether to evict keys from DRAM after successfully pushing to MongoDB. Default: false */
  evictAfterArchive?: boolean;
}

/**
 * Tiered cold-storage background worker.
 * Periodically identifies inactive keys from the LRU tail, packages them into
 * a binary BSON snapshot, compresses via gzip, and persists to MongoDB
 * for long-term audit trail and disaster recovery.
 */
export class ColdStorageWorker {
  private readonly engine: StorageEngine;
  private readonly sink: IMongoColdStorageSink;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly evictAfterArchive: boolean;

  private timer: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;

  constructor(options: ColdStorageWorkerOptions) {
    this.engine = options.engine;
    this.sink = options.sink;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.batchSize = options.batchSize ?? 500;
    this.evictAfterArchive = options.evictAfterArchive ?? false;
  }

  /**
   * Starts periodic cold-storage snapshot execution.
   */
  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.createSnapshot().catch((err) => {
        console.error('[ColdStorageWorker] Snapshot generation failed:', err);
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  /**
   * Stops background snapshot timer.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Generates a compressed BSON snapshot of inactive keys and ships it to MongoDB.
   */
  public async createSnapshot(): Promise<CompressedSnapshot | null> {
    if (this.isProcessing) return null;
    this.isProcessing = true;

    try {
      const coldEntries = this.engine.getColdEntries(this.batchSize);
      if (coldEntries.length === 0) {
        return null;
      }

      const snapshotId = `snapshot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timestamp = new Date();

      // Structure document for BSON encoding
      const bsonDoc: Record<string, any> = {
        _id: snapshotId,
        timestamp,
        keyCount: coldEntries.length,
        entries: coldEntries.map((e) => ({
          key: e.key,
          value: e.value, // Binary BSON subtype 0x00
          expiresAt: e.expiresAt !== null ? BigInt(e.expiresAt) : null,
          archivedAt: timestamp,
        })),
      };

      // Encode into binary BSON
      const rawBson = BsonCodec.encode(bsonDoc);

      // Compress using native node:zlib (gzip)
      const compressedData = await new Promise<Buffer>((resolve, reject) => {
        zlib.gzip(rawBson, { level: zlib.constants.Z_BEST_COMPRESSION }, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      const snapshot: CompressedSnapshot = {
        snapshotId,
        timestamp,
        keyCount: coldEntries.length,
        uncompressedBsonBytes: rawBson.length,
        compressedBytes: compressedData.length,
        compressedData,
      };

      // Ship to MongoDB sink
      await this.sink.saveSnapshot(snapshot);

      // Optionally evict cold keys from DRAM to reclaim memory
      if (this.evictAfterArchive) {
        for (const entry of coldEntries) {
          this.engine.del(entry.key);
        }
      }

      return snapshot;
    } finally {
      this.isProcessing = false;
    }
  }
}
