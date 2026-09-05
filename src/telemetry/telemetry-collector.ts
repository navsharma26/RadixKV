import { EventEmitter } from 'node:events';
import type { ClusterCoordinator } from '../cluster/cluster-coordinator.ts';

export interface LatencyPercentiles {
  p50: number; // in milliseconds
  p90: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
}

export interface MemoryMetrics {
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
}

export interface MemoryHeatMapBlock {
  blockId: number;
  shardId: number;
  vnodeRange: string;
  keyCount: number;
  sizeBytes: number;
  utilizationPct: number; // 0 to 100%
  ttlHealth: 'healthy' | 'warning' | 'expiring';
  sampleKeys: string[];
}

export interface TelemetrySnapshot {
  timestamp: number;
  isoTime: string;
  opsPerSec: number;
  totalCommands: number;
  latencies: LatencyPercentiles;
  hitCount: number;
  missCount: number;
  hitMissRatio: number; // 0.0 to 1.0 (1.0 = 100% hits)
  connectedSockets: number;
  memory: MemoryMetrics;
  commandBreakdown: Record<string, number>;
  shardStats: Array<{
    shardId: number;
    keyCount: number;
    expiresCount: number;
    hits: number;
    misses: number;
    totalOps: number;
  }>;
  heatmap: MemoryHeatMapBlock[];
}

export interface TelemetryCollectorOptions {
  coordinator?: ClusterCoordinator;
  tickIntervalMs?: number; // default: 1000ms
  historyLength?: number;   // default: 60 ticks (60s)
}

/**
 * TelemetryCollector
 * Gathers sub-millisecond metrics, memory metrics, and memory heat map data
 * every 1 second, maintaining a 60-second historical window.
 */
export class TelemetryCollector extends EventEmitter {
  private readonly coordinator?: ClusterCoordinator;
  private readonly tickIntervalMs: number;
  private readonly historyLength: number;

  private activeSockets: number = 0;
  private totalCommands: number = 0;
  private commandCountInterval: number = 0;
  private commandBreakdownInterval: Record<string, number> = {};
  private hitsInterval: number = 0;
  private missesInterval: number = 0;
  private totalHits: number = 0;
  private totalMisses: number = 0;

  // Bounded circular buffer for sub-millisecond duration samples (nanoseconds)
  private readonly maxSamplesPerInterval = 20_000;
  private latencySamplesNs: number[] = [];

  private timer: NodeJS.Timeout | null = null;
  private lastTickTime: bigint = process.hrtime.bigint();
  private readonly history: TelemetrySnapshot[] = [];
  private latestSnapshot: TelemetrySnapshot | null = null;

  constructor(options: TelemetryCollectorOptions = {}) {
    super();
    this.coordinator = options.coordinator;
    this.tickIntervalMs = options.tickIntervalMs ?? 1000;
    this.historyLength = options.historyLength ?? 60;
  }

  public start(): void {
    if (this.timer) return;
    this.lastTickTime = process.hrtime.bigint();
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[TelemetryCollector] Error in tick:', err);
      });
    }, this.tickIntervalMs);
    this.timer.unref(); // Don't block process exit
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public setConnectedSockets(count: number): void {
    this.activeSockets = Math.max(0, count);
  }

  public incrementConnectedSockets(): void {
    this.activeSockets++;
  }

  public decrementConnectedSockets(): void {
    this.activeSockets = Math.max(0, this.activeSockets - 1);
  }

  /**
   * Records a completed command execution with nanosecond resolution
   */
  public recordCommand(commandName: string, durationNs: number, isHit?: boolean): void {
    this.totalCommands++;
    this.commandCountInterval++;

    const normalizedCmd = commandName.toUpperCase();
    this.commandBreakdownInterval[normalizedCmd] = (this.commandBreakdownInterval[normalizedCmd] || 0) + 1;

    if (this.latencySamplesNs.length < this.maxSamplesPerInterval) {
      this.latencySamplesNs.push(durationNs);
    }

    if (isHit !== undefined) {
      if (isHit) {
        this.hitsInterval++;
        this.totalHits++;
      } else {
        this.missesInterval++;
        this.totalMisses++;
      }
    }
  }

  /**
   * Ticks every 1 second: calculates rates, percentiles, gathers memory and shard stats
   */
  public async tick(): Promise<TelemetrySnapshot> {
    const nowBigint = process.hrtime.bigint();
    const elapsedSec = Number(nowBigint - this.lastTickTime) / 1_000_000_000;
    this.lastTickTime = nowBigint;

    const opsPerSec = elapsedSec > 0 ? Math.round(this.commandCountInterval / elapsedSec) : 0;
    const latencies = this.computePercentiles(this.latencySamplesNs);

    // Reset interval latency samples
    this.latencySamplesNs = [];
    const commandBreakdown = { ...this.commandBreakdownInterval };
    this.commandBreakdownInterval = {};
    this.commandCountInterval = 0;

    // Hit / Miss calculation
    const intervalReads = this.hitsInterval + this.missesInterval;
    const intervalHitRatio = intervalReads > 0 ? this.hitsInterval / intervalReads : 1.0;
    const hitCount = this.totalHits;
    const missCount = this.totalMisses;
    const allReads = hitCount + missCount;
    const overallHitRatio = allReads > 0 ? hitCount / allReads : 1.0;

    this.hitsInterval = 0;
    this.missesInterval = 0;

    // Memory stats
    const memUsage = process.memoryUsage();
    const memory: MemoryMetrics = {
      heapUsedBytes: memUsage.heapUsed,
      heapTotalBytes: memUsage.heapTotal,
      rssBytes: memUsage.rss,
      externalBytes: memUsage.external,
      arrayBuffersBytes: memUsage.arrayBuffers ?? 0,
      heapUsedMb: Number((memUsage.heapUsed / (1024 * 1024)).toFixed(2)),
      heapTotalMb: Number((memUsage.heapTotal / (1024 * 1024)).toFixed(2)),
      rssMb: Number((memUsage.rss / (1024 * 1024)).toFixed(2)),
    };

    // Shard stats & Heat Map
    let shardStats: Array<{
      shardId: number;
      keyCount: number;
      expiresCount: number;
      hits: number;
      misses: number;
      totalOps: number;
    }> = [];

    let sampleKeys: Array<{ shardId: number; key: string; sizeBytes: number; ttlRemainingMs: number }> = [];

    if (this.coordinator) {
      try {
        const clusterStats = await this.coordinator.getClusterStats();
        shardStats = clusterStats.shards.map((s) => ({
          shardId: s.shardId,
          keyCount: s.size,
          expiresCount: s.expiresCount,
          hits: s.hits,
          misses: s.misses,
          totalOps: s.totalOps,
        }));

        sampleKeys = await this.coordinator.sampleClusterKeys(20);
      } catch (err) {
        // Fallback if coordinator busy
      }
    }

    const heatmap = this.generateMemoryHeatmap(shardStats, sampleKeys);

    const now = Date.now();
    const snapshot: TelemetrySnapshot = {
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      opsPerSec,
      totalCommands: this.totalCommands,
      latencies,
      hitCount,
      missCount,
      hitMissRatio: Number(overallHitRatio.toFixed(3)),
      connectedSockets: this.activeSockets,
      memory,
      commandBreakdown,
      shardStats,
      heatmap,
    };

    this.latestSnapshot = snapshot;
    this.history.push(snapshot);
    if (this.history.length > this.historyLength) {
      this.history.shift();
    }

    this.emit('snapshot', snapshot);
    return snapshot;
  }

  public getLatestSnapshot(): TelemetrySnapshot | null {
    return this.latestSnapshot;
  }

  public getHistory(): TelemetrySnapshot[] {
    return [...this.history];
  }

  private computePercentiles(samplesNs: number[]): LatencyPercentiles {
    if (samplesNs.length === 0) {
      return { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 };
    }

    // Convert nanoseconds to milliseconds
    const samplesMs = samplesNs.map((ns) => ns / 1_000_000);
    samplesMs.sort((a, b) => a - b);

    const len = samplesMs.length;
    const sum = samplesMs.reduce((acc, v) => acc + v, 0);
    const avg = Number((sum / len).toFixed(4));
    const min = Number(samplesMs[0].toFixed(4));
    const max = Number(samplesMs[len - 1].toFixed(4));

    const p50 = Number(samplesMs[Math.floor(len * 0.50)].toFixed(4));
    const p90 = Number(samplesMs[Math.min(len - 1, Math.floor(len * 0.90))].toFixed(4));
    const p95 = Number(samplesMs[Math.min(len - 1, Math.floor(len * 0.95))].toFixed(4));
    const p99 = Number(samplesMs[Math.min(len - 1, Math.floor(len * 0.99))].toFixed(4));

    return { p50, p90, p95, p99, avg, min, max };
  }

  /**
   * Generates a 64-block 2D memory-layout grid partitioned across shards
   */
  private generateMemoryHeatmap(
    shardStats: Array<{ shardId: number; keyCount: number; expiresCount: number }>,
    sampleKeys: Array<{ shardId: number; key: string; sizeBytes: number; ttlRemainingMs: number }>
  ): MemoryHeatMapBlock[] {
    const TOTAL_BLOCKS = 64;
    const shardCount = Math.max(1, shardStats.length);
    const blocksPerShard = Math.floor(TOTAL_BLOCKS / shardCount);

    const blocks: MemoryHeatMapBlock[] = [];

    for (let i = 0; i < TOTAL_BLOCKS; i++) {
      const shardId = Math.min(shardCount - 1, Math.floor(i / blocksPerShard));
      const shard = shardStats[shardId] || { keyCount: 0, expiresCount: 0 };

      // Filter sample keys belonging to this shard
      const shardKeys = sampleKeys.filter((k) => k.shardId === shardId);
      const blockKeys = shardKeys.slice(0, 3).map((k) => k.key);

      // Estimate utilization based on key count and active ops
      const estimatedKeysInBlock = Math.round(shard.keyCount / blocksPerShard);
      const estimatedBytesInBlock = estimatedKeysInBlock * 128; // ~128 bytes per key-value avg

      let utilizationPct = Math.min(100, Math.round((estimatedKeysInBlock / 50) * 100));
      if (utilizationPct === 0 && shard.keyCount > 0) utilizationPct = 12;

      let ttlHealth: 'healthy' | 'warning' | 'expiring' = 'healthy';
      if (shard.expiresCount > 0) {
        const expiringSoon = shardKeys.some((k) => k.ttlRemainingMs > 0 && k.ttlRemainingMs < 10_000);
        if (expiringSoon) {
          ttlHealth = 'expiring';
        } else if (shard.expiresCount > shard.keyCount * 0.4) {
          ttlHealth = 'warning';
        }
      }

      blocks.push({
        blockId: i,
        shardId,
        vnodeRange: `${(i * (100 / TOTAL_BLOCKS)).toFixed(1)}% - ${((i + 1) * (100 / TOTAL_BLOCKS)).toFixed(1)}%`,
        keyCount: estimatedKeysInBlock,
        sizeBytes: estimatedBytesInBlock,
        utilizationPct,
        ttlHealth,
        sampleKeys: blockKeys,
      });
    }

    return blocks;
  }
}
