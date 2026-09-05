import * as crypto from 'node:crypto';

export interface RingEntry {
  hash: number;
  nodeId: string;
}

export interface ConsistentHashRingOptions {
  /** Number of virtual nodes per physical node. Default: 150 */
  vnodesPerNode?: number;
}

/**
 * High-performance Consistent Hash Ring with virtual nodes.
 * Features:
 * - 32-bit hash ring [0, 2^32 - 1] backed by cryptographic SHA-256 truncation.
 * - Configurable virtual nodes (default: 150) to prevent hash clustering.
 * - Binary search lookup (O(log(V * N))) with circular wrap-around.
 * - Minimal key churn during node addition and removal.
 */
export class ConsistentHashRing {
  private readonly vnodesPerNode: number;
  private ring: RingEntry[] = [];
  private readonly nodes: Set<string> = new Set();

  constructor(options: ConsistentHashRingOptions = {}) {
    this.vnodesPerNode = options.vnodesPerNode ?? 150;
  }

  /**
   * Generates a uniform 32-bit unsigned integer hash from a string key.
   */
  public static hash(key: string): number {
    const digest = crypto.createHash('sha256').update(key).digest();
    return digest.readUInt32BE(0);
  }

  /**
   * Adds a physical node to the hash ring with its assigned virtual nodes.
   */
  public addNode(nodeId: string): void {
    if (this.nodes.has(nodeId)) {
      return;
    }

    this.nodes.add(nodeId);

    for (let i = 0; i < this.vnodesPerNode; i++) {
      const vnodeKey = `${nodeId}#vn${i}`;
      const hash = ConsistentHashRing.hash(vnodeKey);
      this.ring.push({ hash, nodeId });
    }

    // Maintain sorted order for binary search
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /**
   * Removes a physical node and all of its virtual nodes from the ring.
   */
  public removeNode(nodeId: string): void {
    if (!this.nodes.has(nodeId)) {
      return;
    }

    this.nodes.delete(nodeId);
    this.ring = this.ring.filter((entry) => entry.nodeId !== nodeId);
  }

  /**
   * Maps a key to its designated physical node via binary search on the ring.
   */
  public getNode(key: string): string {
    if (this.ring.length === 0) {
      throw new Error('ConsistentHashRing has no active nodes');
    }

    const keyHash = ConsistentHashRing.hash(key);
    const index = this.binarySearch(keyHash);

    // If keyHash is greater than all points on the ring, wrap around to first node
    if (index >= this.ring.length) {
      return this.ring[0].nodeId;
    }

    return this.ring[index].nodeId;
  }

  /**
   * Retrieves all unique physical nodes currently registered on the ring.
   */
  public getNodes(): string[] {
    return Array.from(this.nodes);
  }

  /**
   * Total number of virtual nodes currently placed on the ring.
   */
  public get vnodeCount(): number {
    return this.ring.length;
  }

  /**
   * Binary search (bisect right) for the first ring entry with hash >= targetHash.
   */
  private binarySearch(targetHash: number): number {
    let low = 0;
    let high = this.ring.length - 1;
    let result = this.ring.length;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (this.ring[mid].hash >= targetHash) {
        result = mid;
        high = mid - 1; // Look for earlier match
      } else {
        low = mid + 1;
      }
    }

    return result;
  }
}
