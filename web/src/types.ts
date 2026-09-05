export interface LatencyPercentiles {
  p50: number;
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
  utilizationPct: number;
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
  hitMissRatio: number;
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

export interface ClusterInfo {
  shardCount: number;
  vnodesPerShard: number;
  tcpPort: number;
  telemetryPort: number;
  syntheticTraffic: boolean;
}

export interface TerminalEntry {
  id: string;
  command: string;
  output: string;
  latencyUs: number;
  timestamp: string;
  isError?: boolean;
}
