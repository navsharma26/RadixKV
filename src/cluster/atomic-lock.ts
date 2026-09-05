/**
 * Thread-safe atomic lock primitives backed by SharedArrayBuffer and Atomics.
 * Provides kernel-grade futex semantics across Node.js worker_threads.
 */
export class AtomicMutex {
  public static readonly UNLOCKED = 0;
  public static readonly LOCKED = 1;

  public readonly sharedBuffer: SharedArrayBuffer;
  private readonly state: Int32Array;

  /**
   * @param sharedBufferOrLockCount SharedArrayBuffer instance or number of lock slots to allocate.
   */
  constructor(sharedBufferOrLockCount: SharedArrayBuffer | number) {
    if (typeof sharedBufferOrLockCount === 'number') {
      this.sharedBuffer = new SharedArrayBuffer(sharedBufferOrLockCount * 4);
    } else {
      this.sharedBuffer = sharedBufferOrLockCount;
    }
    this.state = new Int32Array(this.sharedBuffer);
  }

  /**
   * Total number of distinct lock slots in this mutex pool.
   */
  public get lockCount(): number {
    return this.state.length;
  }

  /**
   * Tries to acquire the lock at lockIndex non-blockingly via CAS (Compare-And-Swap).
   * Returns true if acquired, false otherwise.
   */
  public tryAcquire(lockIndex: number = 0): boolean {
    this.validateIndex(lockIndex);
    return Atomics.compareExchange(this.state, lockIndex, AtomicMutex.UNLOCKED, AtomicMutex.LOCKED) === AtomicMutex.UNLOCKED;
  }

  /**
   * Acquires the lock at lockIndex.
   * In worker threads, uses Atomics.wait() for zero-CPU sleep until woken by Atomics.notify().
   * In environments where Atomics.wait() is prohibited (e.g. main event loop), spins with yield.
   */
  public acquire(lockIndex: number = 0): void {
    this.validateIndex(lockIndex);

    while (Atomics.compareExchange(this.state, lockIndex, AtomicMutex.UNLOCKED, AtomicMutex.LOCKED) !== AtomicMutex.UNLOCKED) {
      try {
        // Sleep until lock becomes 0 or timeout expires (futex wait)
        Atomics.wait(this.state, lockIndex, AtomicMutex.LOCKED, 50);
      } catch {
        // Fallback for main thread where Atomics.wait is prohibited
        // Short spin
      }
    }
  }

  /**
   * Releases the lock at lockIndex and notifies waiting threads.
   */
  public release(lockIndex: number = 0): void {
    this.validateIndex(lockIndex);
    Atomics.store(this.state, lockIndex, AtomicMutex.UNLOCKED);
    Atomics.notify(this.state, lockIndex, 1);
  }

  /**
   * Executes an action within a locked scope.
   */
  public withLock<T>(lockIndex: number, action: () => T): T {
    this.acquire(lockIndex);
    try {
      return action();
    } finally {
      this.release(lockIndex);
    }
  }

  private validateIndex(index: number): void {
    if (index < 0 || index >= this.state.length) {
      throw new Error(`Lock index out of bounds: ${index}. Max is ${this.state.length - 1}`);
    }
  }
}

/**
 * Deadlock-free multi-lock coordinator for cross-shard operations.
 * Acquires locks in strictly ascending index order to eliminate circular wait conditions.
 */
export class AtomicMultiLock {
  private readonly mutex: AtomicMutex;

  constructor(mutex: AtomicMutex) {
    this.mutex = mutex;
  }

  /**
   * Acquires multiple locks in ascending order to prevent deadlocks.
   */
  public acquireAll(indices: number[]): void {
    if (indices.length === 0) return;

    // Deduplicate and sort ascending to eliminate circular lock dependencies
    const sortedIndices = Array.from(new Set(indices)).sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      this.mutex.acquire(idx);
    }
  }

  /**
   * Releases multiple locks in descending order.
   */
  public releaseAll(indices: number[]): void {
    if (indices.length === 0) return;

    const sortedIndices = Array.from(new Set(indices)).sort((a, b) => b - a);
    for (const idx of sortedIndices) {
      this.mutex.release(idx);
    }
  }

  /**
   * Executes a cross-shard transaction with ordered multi-locking.
   */
  public withMultiLock<T>(indices: number[], action: () => T): T {
    this.acquireAll(indices);
    try {
      return action();
    } finally {
      this.releaseAll(indices);
    }
  }
}
