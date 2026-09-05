import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AtomicMultiLock, AtomicMutex } from '../src/cluster/atomic-lock.ts';

function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => console.log(`  ✓ ${name}`))
        .catch((err) => {
          console.error(`  ✗ ${name}`);
          throw err;
        });
    }
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

async function runAtomicLockTests() {
  console.log('--- Running Atomic Lock Concurrency Tests ---');

  runTest('AtomicMutex tryAcquire, acquire, and release', () => {
    const mutex = new AtomicMutex(4);

    // Initial state: unlocked
    assert.equal(mutex.tryAcquire(0), true);

    // Contended: cannot re-acquire same lock
    assert.equal(mutex.tryAcquire(0), false);

    // Other lock slots are unaffected
    assert.equal(mutex.tryAcquire(1), true);
    mutex.release(1);

    // Release and re-acquire
    mutex.release(0);
    assert.equal(mutex.tryAcquire(0), true);
    mutex.release(0);
  });

  runTest('AtomicMultiLock acquires and releases in sorted order', () => {
    const mutex = new AtomicMutex(4);
    const multiLock = new AtomicMultiLock(mutex);

    // Acquire locks for shards 3, 1, 0
    multiLock.acquireAll([3, 1, 0]);

    // Verify all 3 are locked
    assert.equal(mutex.tryAcquire(0), false);
    assert.equal(mutex.tryAcquire(1), false);
    assert.equal(mutex.tryAcquire(2), true); // Unlocked
    assert.equal(mutex.tryAcquire(3), false);

    mutex.release(2);
    multiLock.releaseAll([3, 1, 0]);

    // All released
    assert.equal(mutex.tryAcquire(0), true);
    assert.equal(mutex.tryAcquire(1), true);
    assert.equal(mutex.tryAcquire(3), true);
    mutex.release(0);
    mutex.release(1);
    mutex.release(3);
  });

  await runTest('Concurrent multi-worker contention stress test on SharedArrayBuffer', async () => {
    // Shared buffer layout:
    // Slot 0: Lock slot (AtomicMutex)
    // Slot 1: Shared counter
    const sharedBuffer = new SharedArrayBuffer(8);
    const sharedArray = new Int32Array(sharedBuffer);

    const WORKER_COUNT = 4;
    const INCREMENTS_PER_WORKER = 2500;

    const workerCode = `
      const { workerData, parentPort } = require('node:worker_threads');
      const sharedArray = new Int32Array(workerData.sharedBuffer);
      const UNLOCKED = 0;
      const LOCKED = 1;

      function acquire() {
        while (Atomics.compareExchange(sharedArray, 0, UNLOCKED, LOCKED) !== UNLOCKED) {
          Atomics.wait(sharedArray, 0, LOCKED, 50);
        }
      }

      function release() {
        Atomics.store(sharedArray, 0, UNLOCKED);
        Atomics.notify(sharedArray, 0, 1);
      }

      for (let i = 0; i < workerData.increments; i++) {
        acquire();
        // Critical section: read-modify-write on shared counter
        const current = sharedArray[1];
        sharedArray[1] = current + 1;
        release();
      }

      parentPort.postMessage('DONE');
    `;

    const workers = Array.from({ length: WORKER_COUNT }, () => {
      return new Worker(workerCode, {
        eval: true,
        workerData: {
          sharedBuffer,
          increments: INCREMENTS_PER_WORKER,
        },
      });
    });

    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            w.on('message', () => resolve());
            w.on('error', reject);
          })
      )
    );

    // Total increments must equal exactly WORKER_COUNT * INCREMENTS_PER_WORKER
    const expected = WORKER_COUNT * INCREMENTS_PER_WORKER;
    assert.equal(
      sharedArray[1],
      expected,
      `Expected counter to reach ${expected}, but got ${sharedArray[1]} (lost updates detected)`
    );

    await Promise.all(workers.map((w) => w.terminate()));
  });

  console.log('--- All Atomic Lock Concurrency Tests Passed! ---\n');
}

runAtomicLockTests().catch((err) => {
  console.error('Atomic lock test suite failed:', err);
  process.exit(1);
});
