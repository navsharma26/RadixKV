import { DoublyLinkedList, LruNode } from './lru-list.ts';

export interface StorageEngineOptions {
  /** Maximum allowable heap memory usage in bytes before proactive LRU eviction triggers. 0 to disable */
  maxMemoryBytes?: number;
  /** Maximum number of keys allowed in the store. 0 to disable */
  maxKeys?: number;
  /** Active TTL background sweep interval in milliseconds. Default: 100ms */
  ttlSweepIntervalMs?: number;
  /** Number of random keys to sample per active TTL sweep step. Default: 20 */
  ttlSampleSize?: number;
  /** Time budget in milliseconds per active TTL sweep cycle to prevent event-loop stalls. Default: 5ms */
  ttlSweepMaxTimeMs?: number;
}

export interface SetOptions {
  /** Expiration time in seconds */
  exSeconds?: number;
}

/**
 * High-performance, in-memory key-value core engine.
 * Features:
 * - O(1) LRU eviction via DoublyLinkedList and native Map.
 * - Proactive eviction on hard memory limits (process.memoryUsage().heapUsed).
 * - Dual TTL strategy: O(1) passive read expiration + active 100ms probabilistic cleanup.
 */
export class StorageEngine {
  private readonly map: Map<string, LruNode<string, Buffer>> = new Map();
  private readonly lruList: DoublyLinkedList<string, Buffer> = new DoublyLinkedList();

  // Packed array + index map for O(1) random key sampling and O(1) removal
  private readonly expiresList: string[] = [];
  private readonly expiresIndexMap: Map<string, number> = new Map();

  private readonly maxMemoryBytes: number;
  private readonly maxKeys: number;
  private readonly ttlSweepIntervalMs: number;
  private readonly ttlSampleSize: number;
  private readonly ttlSweepMaxTimeMs: number;

  private ttlTimer: NodeJS.Timeout | null = null;

  public hits: number = 0;
  public misses: number = 0;
  public totalOps: number = 0;

  constructor(options: StorageEngineOptions = {}) {
    this.maxMemoryBytes = options.maxMemoryBytes ?? 0; // 0 = disabled
    this.maxKeys = options.maxKeys ?? 0;               // 0 = disabled
    this.ttlSweepIntervalMs = options.ttlSweepIntervalMs ?? 100;
    this.ttlSampleSize = options.ttlSampleSize ?? 20;
    this.ttlSweepMaxTimeMs = options.ttlSweepMaxTimeMs ?? 5;

    this.startTtlSweep();
  }

  /**
   * Total number of keys currently stored (including any not-yet-swept expired keys).
   */
  public get size(): number {
    return this.map.size;
  }

  /**
   * Number of keys with an active expiration set.
   */
  public get expiresCount(): number {
    return this.expiresList.length;
  }

  /**
   * Sets a key to hold a Buffer value with an optional time-to-live in seconds.
   */
  public set(key: string, value: Buffer, options?: SetOptions): void {
    this.totalOps++;
    const expiresAt = options?.exSeconds && options.exSeconds > 0
      ? Date.now() + options.exSeconds * 1000
      : null;

    const existing = this.map.get(key);

    if (existing) {
      // Update existing node in-place and move to head (MRU)
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.lruList.moveToFront(existing);

      if (expiresAt !== null) {
        this.trackExpiry(key);
      } else {
        this.untrackExpiry(key);
      }
    } else {
      // Check memory cap and evict LRU items if needed before inserting new key
      this.checkMemoryAndEvict();

      const newNode = new LruNode(key, value, expiresAt);
      this.map.set(key, newNode);
      this.lruList.pushFront(newNode);

      if (expiresAt !== null) {
        this.trackExpiry(key);
      }
    }

    // Ensure memory bounds after insertion
    this.checkMemoryAndEvict();
  }

  /**
   * Retrieves a key's value, updating its LRU position.
   * Performs passive expiration check in O(1).
   */
  public get(key: string): Buffer | null {
    this.totalOps++;
    const node = this.map.get(key);
    if (!node) {
      this.misses++;
      return null;
    }

    // Passive expiration check
    if (node.expiresAt !== null && Date.now() >= node.expiresAt) {
      this.misses++;
      this.deleteKey(key);
      return null;
    }

    this.hits++;
    // Update LRU position: move to front (MRU)
    this.lruList.moveToFront(node);
    return node.value;
  }

  /**
   * Deletes one or more keys from the store.
   * Returns the count of keys that were removed.
   */
  public del(...keys: string[]): number {
    this.totalOps++;
    let deletedCount = 0;
    const now = Date.now();

    for (const key of keys) {
      const node = this.map.get(key);
      if (node) {
        const isExpired = node.expiresAt !== null && now >= node.expiresAt;
        this.deleteKey(key);
        if (!isExpired) {
          deletedCount++;
        }
      }
    }

    return deletedCount;
  }

  /**
   * Increments the number stored at key by one.
   * If the key does not exist, it is set to 0 before performing the operation.
   * Preserves existing TTL if present.
   */
  public incr(key: string): bigint {
    this.totalOps++;
    const now = Date.now();
    let node = this.map.get(key);

    if (node && node.expiresAt !== null && now >= node.expiresAt) {
      this.deleteKey(key);
      node = undefined;
    }

    if (!node) {
      const initialVal = 1n;
      const buf = Buffer.from(initialVal.toString(), 'utf-8');
      this.set(key, buf);
      return initialVal;
    }

    // Parse current value as integer
    const rawStr = node.value.toString('utf-8').trim();
    let currentVal: bigint;
    try {
      currentVal = BigInt(rawStr);
    } catch {
      throw new Error('ERR value is not an integer or out of range');
    }

    const newVal = currentVal + 1n;
    node.value = Buffer.from(newVal.toString(), 'utf-8');
    this.lruList.moveToFront(node);

    return newVal;
  }

  /**
   * Returns the remaining time to live of a key in seconds:
   * - -2 if the key does not exist (or has expired)
   * - -1 if the key exists but has no associated expire
   * - Remaining seconds >= 0 if the key has an expiration
   */
  public ttl(key: string): number {
    this.totalOps++;
    const node = this.map.get(key);
    if (!node) {
      return -2;
    }

    if (node.expiresAt === null) {
      return -1;
    }

    const now = Date.now();
    if (now >= node.expiresAt) {
      this.deleteKey(key);
      return -2;
    }

    const remainingSeconds = Math.max(0, Math.ceil((node.expiresAt - now) / 1000));
    return remainingSeconds;
  }

  /**
   * Returns engine metrics snapshot
   */
  public getStats(): { size: number; expiresCount: number; hits: number; misses: number; totalOps: number } {
    return {
      size: this.map.size,
      expiresCount: this.expiresList.length,
      hits: this.hits,
      misses: this.misses,
      totalOps: this.totalOps,
    };
  }

  /**
   * Returns a sample of keys and their memory characteristics for the heat map
   */
  public sampleKeys(limit: number = 64): Array<{ key: string; sizeBytes: number; ttlRemainingMs: number }> {
    const result: Array<{ key: string; sizeBytes: number; ttlRemainingMs: number }> = [];
    const now = Date.now();
    let count = 0;
    for (const [key, node] of this.map.entries()) {
      if (count >= limit) break;
      const ttlRemainingMs = node.expiresAt === null ? -1 : Math.max(0, node.expiresAt - now);
      result.push({
        key,
        sizeBytes: key.length + (node.value ? node.value.length : 0),
        ttlRemainingMs,
      });
      count++;
    }
    return result;
  }

  /**
   * Retrieves up to maxCount cold/inactive entries from the tail of the LRU list.
   */
  public getColdEntries(maxCount: number): Array<{ key: string; value: Buffer; expiresAt: number | null }> {
    const nodes = this.lruList.getTailNodes(maxCount);
    return nodes.map(n => ({
      key: n.key,
      value: n.value,
      expiresAt: n.expiresAt,
    }));
  }

  /**
   * Proactively evicts LRU items if memory usage exceeds maxMemoryBytes or maxKeys.
   */
  public checkMemoryAndEvict(maxEvictions: number = 100): number {
    let evicted = 0;

    // 1. Max keys threshold
    if (this.maxKeys > 0) {
      while (this.map.size > this.maxKeys && evicted < maxEvictions) {
        if (!this.evictOneLru()) break;
        evicted++;
      }
    }

    // 2. Heap used threshold
    if (this.maxMemoryBytes > 0) {
      while (process.memoryUsage().heapUsed > this.maxMemoryBytes && evicted < maxEvictions) {
        if (!this.evictOneLru()) break;
        evicted++;
      }
    }

    return evicted;
  }

  /**
   * Evicts the single least recently used (LRU) node from the tail.
   */
  public evictOneLru(): boolean {
    const tailNode = this.lruList.popTail();
    if (!tailNode) {
      return false;
    }

    this.map.delete(tailNode.key);
    this.untrackExpiry(tailNode.key);
    return true;
  }

  /**
   * Runs one active TTL expiration cycle using Redis's probabilistic algorithm:
   * 1. Test ttlSampleSize random keys from expiresList.
   * 2. Delete all keys found expired.
   * 3. If >25% of keys expired and time budget permits, repeat immediately.
   */
  public runActiveTtlCycle(sampleSize?: number, maxTimeMs?: number): number {
    const targetSampleSize = sampleSize ?? this.ttlSampleSize;
    const timeLimitMs = maxTimeMs ?? this.ttlSweepMaxTimeMs;
    const startTime = Date.now();
    let totalExpired = 0;

    while (this.expiresList.length > 0) {
      const currentTotal = this.expiresList.length;
      const countToSample = Math.min(targetSampleSize, currentTotal);
      let expiredInBatch = 0;
      const now = Date.now();

      for (let i = 0; i < countToSample; i++) {
        if (this.expiresList.length === 0) break;

        // O(1) random key lookup from packed array
        const randomIndex = Math.floor(Math.random() * this.expiresList.length);
        const key = this.expiresList[randomIndex];
        const node = this.map.get(key);

        if (node && node.expiresAt !== null && now >= node.expiresAt) {
          this.deleteKey(key);
          expiredInBatch++;
          totalExpired++;
        }
      }

      // If more than 25% expired, continue cleaning if within time budget
      if (countToSample > 0 && expiredInBatch / countToSample > 0.25) {
        if (Date.now() - startTime >= timeLimitMs) {
          break; // Avoid starving event loop
        }
        continue;
      }
      break;
    }

    return totalExpired;
  }

  /**
   * Starts the background active TTL sweep timer.
   */
  public startTtlSweep(): void {
    if (this.ttlTimer) return;
    this.ttlTimer = setInterval(() => {
      this.runActiveTtlCycle();
    }, this.ttlSweepIntervalMs);

    // Allow Node to exit cleanly if this is the only active handle
    this.ttlTimer.unref();
  }

  /**
   * Stops the background active TTL sweep timer.
   */
  public stopTtlSweep(): void {
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = null;
    }
  }

  /**
   * Deletes a key, removing it from Map, LRU list, and TTL index.
   */
  private deleteKey(key: string): void {
    const node = this.map.get(key);
    if (!node) return;

    this.lruList.remove(node);
    this.map.delete(key);
    this.untrackExpiry(key);
  }

  /**
   * Adds key to packed expiration array with O(1) index tracking.
   */
  private trackExpiry(key: string): void {
    if (this.expiresIndexMap.has(key)) return;

    const index = this.expiresList.length;
    this.expiresList.push(key);
    this.expiresIndexMap.set(key, index);
  }

  /**
   * Removes key from packed expiration array in O(1) via swap-with-last.
   */
  private untrackExpiry(key: string): void {
    const index = this.expiresIndexMap.get(key);
    if (index === undefined) return;

    const lastKey = this.expiresList[this.expiresList.length - 1];
    this.expiresList[index] = lastKey;
    this.expiresIndexMap.set(lastKey, index);

    this.expiresList.pop();
    this.expiresIndexMap.delete(key);
  }

  /**
   * Clears all keys, indices, and LRU nodes.
   */
  public clear(): void {
    this.map.clear();
    this.lruList.clear();
    this.expiresList.length = 0;
    this.expiresIndexMap.clear();
  }
}
