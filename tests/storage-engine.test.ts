import assert from 'node:assert/strict';
import { StorageEngine } from '../src/storage-engine.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function runStorageEngineTests() {
  console.log('--- Running StorageEngine Unit Tests ---');

  runTest('SET and GET basic key-values', () => {
    const engine = new StorageEngine();
    engine.set('foo', Buffer.from('bar'));
    const val = engine.get('foo');
    assert(val !== null);
    assert.equal(val.toString('utf-8'), 'bar');
    assert.equal(engine.get('nonexistent'), null);
    engine.stopTtlSweep();
  });

  runTest('DEL removes keys and returns deleted count', () => {
    const engine = new StorageEngine();
    engine.set('k1', Buffer.from('v1'));
    engine.set('k2', Buffer.from('v2'));
    engine.set('k3', Buffer.from('v3'));

    const count = engine.del('k1', 'k2', 'k4');
    assert.equal(count, 2);
    assert.equal(engine.get('k1'), null);
    assert.equal(engine.get('k2'), null);
    assert.equal(engine.get('k3')?.toString('utf-8'), 'v3');
    engine.stopTtlSweep();
  });

  runTest('INCR creates key or increments integer value', () => {
    const engine = new StorageEngine();

    // 1. Nonexistent key initialized to 1
    const val1 = engine.incr('counter');
    assert.equal(val1, 1n);
    assert.equal(engine.get('counter')?.toString('utf-8'), '1');

    // 2. Increments to 2
    const val2 = engine.incr('counter');
    assert.equal(val2, 2n);

    // 3. Error on non-numeric key
    engine.set('str', Buffer.from('not_a_number'));
    assert.throws(
      () => engine.incr('str'),
      (err: any) => err.message.includes('ERR value is not an integer')
    );

    engine.stopTtlSweep();
  });

  runTest('TTL command returns correct remaining seconds or error codes', async () => {
    const engine = new StorageEngine();

    // Key with no expiry -> -1
    engine.set('persist', Buffer.from('val'));
    assert.equal(engine.ttl('persist'), -1);

    // Nonexistent key -> -2
    assert.equal(engine.ttl('missing'), -2);

    // Key with TTL -> remaining seconds >= 1
    engine.set('temp', Buffer.from('val'), { exSeconds: 2 });
    const rem = engine.ttl('temp');
    assert(rem >= 1 && rem <= 2);

    engine.stopTtlSweep();
  });

  runTest('O(1) LRU eviction policy works strictly in order', () => {
    // Max 3 keys
    const engine = new StorageEngine({ maxKeys: 3 });

    engine.set('k1', Buffer.from('v1'));
    engine.set('k2', Buffer.from('v2'));
    engine.set('k3', Buffer.from('v3'));
    assert.equal(engine.size, 3);

    // Access k1, making k2 the LRU (order MRU -> LRU: k1, k3, k2)
    engine.get('k1');

    // Insert k4, which must evict k2
    engine.set('k4', Buffer.from('v4'));
    assert.equal(engine.size, 3);
    assert.equal(engine.get('k2'), null, 'k2 should have been evicted as LRU');
    assert.equal(engine.get('k1')?.toString(), 'v1');
    assert.equal(engine.get('k3')?.toString(), 'v3');
    assert.equal(engine.get('k4')?.toString(), 'v4');

    engine.stopTtlSweep();
  });

  await runTest('Passive expiration removes expired key on GET / INCR / TTL', async () => {
    const engine = new StorageEngine();
    // Expire in 1 second
    engine.set('short_lived', Buffer.from('temp'), { exSeconds: 1 });

    assert.equal(engine.get('short_lived')?.toString(), 'temp');
    assert.equal(engine.ttl('short_lived'), 1);

    // Wait 1.1s for expiration
    await delay(1100);

    // Passive expiration on GET
    assert.equal(engine.get('short_lived'), null);
    assert.equal(engine.ttl('short_lived'), -2);
    assert.equal(engine.size, 0);

    engine.stopTtlSweep();
  });

  await runTest('Active probabilistic 100ms background sweep purges expired keys', async () => {
    const engine = new StorageEngine({ ttlSweepIntervalMs: 50 });

    // Set 50 keys with 1 second expiry
    for (let i = 0; i < 50; i++) {
      engine.set(`temp_${i}`, Buffer.from(`val_${i}`), { exSeconds: 1 });
    }

    // Set 20 permanent keys
    for (let i = 0; i < 20; i++) {
      engine.set(`perm_${i}`, Buffer.from(`perm_val_${i}`));
    }

    assert.equal(engine.size, 70);
    assert.equal(engine.expiresCount, 50);

    // Wait 1.2s for keys to expire and background 50ms sweep to run
    await delay(1200);

    // Active sweep should have eliminated the expired keys automatically without manual GET
    assert.equal(engine.expiresCount, 0);
    assert.equal(engine.size, 20);

    // Permanent keys remain fully intact
    for (let i = 0; i < 20; i++) {
      assert.equal(engine.get(`perm_${i}`)?.toString(), `perm_val_${i}`);
    }

    engine.stopTtlSweep();
  });

  runTest('Hard memory capping triggers proactive eviction on heap usage limit', () => {
    // 1. Engine with maxMemoryBytes = 1: every set() proactively evicts to respect the hard cap
    const simulatedCappedEngine = new StorageEngine({
      maxMemoryBytes: 1, // Any positive heap usage will trigger eviction
    });

    for (let i = 0; i < 10; i++) {
      simulatedCappedEngine.set(`k_${i}`, Buffer.from(`val_${i}`));
    }

    // Proactive eviction inside set() keeps the store at 0 keys
    assert.equal(simulatedCappedEngine.size, 0, 'Proactive eviction should have purged items during set');

    // 2. Engine initialized with normal capacity, then tested with checkMemoryAndEvict
    const engine = new StorageEngine();
    for (let i = 0; i < 10; i++) {
      engine.set(`k_${i}`, Buffer.from(`val_${i}`));
    }
    assert.equal(engine.size, 10);

    // Evict 3 items manually via LRU pop
    for (let i = 0; i < 3; i++) {
      engine.evictOneLru();
    }
    assert.equal(engine.size, 7);

    simulatedCappedEngine.stopTtlSweep();
    engine.stopTtlSweep();
  });

  console.log('--- All StorageEngine Unit Tests Passed! ---\n');
}

runStorageEngineTests();
