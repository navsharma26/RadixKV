import assert from 'node:assert/strict';
import { ConsistentHashRing } from '../src/cluster/consistent-hash.ts';

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

async function runConsistentHashTests() {
  console.log('--- Running Consistent Hash Ring Tests ---');

  runTest('Initializes with default 150 virtual nodes per physical node', () => {
    const ring = new ConsistentHashRing({ vnodesPerNode: 150 });
    ring.addNode('shard-0');
    ring.addNode('shard-1');
    ring.addNode('shard-2');

    assert.equal(ring.getNodes().length, 3);
    assert.equal(ring.vnodeCount, 3 * 150);
  });

  runTest('Uniform distribution across shards (no clustering)', () => {
    const ring = new ConsistentHashRing({ vnodesPerNode: 150 });
    const shards = ['shard-0', 'shard-1', 'shard-2', 'shard-3'];
    for (const s of shards) ring.addNode(s);

    const counts: Record<string, number> = {
      'shard-0': 0,
      'shard-1': 0,
      'shard-2': 0,
      'shard-3': 0,
    };

    const TOTAL_KEYS = 10_000;
    for (let i = 0; i < TOTAL_KEYS; i++) {
      const node = ring.getNode(`user_account_key_${i}`);
      counts[node]++;
    }

    // With 150 vnodes, each shard should hold roughly 25% of keys (e.g. 20% to 30%)
    for (const s of shards) {
      const percentage = counts[s] / TOTAL_KEYS;
      assert(
        percentage >= 0.18 && percentage <= 0.32,
        `Shard ${s} has unexpected distribution: ${(percentage * 100).toFixed(1)}%`
      );
    }
  });

  runTest('Minimal churn guarantee when adding or removing a node (~1/N keys rebalanced)', () => {
    const ring = new ConsistentHashRing({ vnodesPerNode: 150 });
    ring.addNode('shard-0');
    ring.addNode('shard-1');
    ring.addNode('shard-2');
    ring.addNode('shard-3');

    const TOTAL_KEYS = 2000;
    const initialMapping = new Map<string, string>();
    for (let i = 0; i < TOTAL_KEYS; i++) {
      const k = `sample_key_${i}`;
      initialMapping.set(k, ring.getNode(k));
    }

    // Add 5th node
    ring.addNode('shard-4');

    let migrated = 0;
    for (let i = 0; i < TOTAL_KEYS; i++) {
      const k = `sample_key_${i}`;
      const newNode = ring.getNode(k);
      if (newNode !== initialMapping.get(k)) {
        migrated++;
        // Any key that migrated MUST have moved to the new node 'shard-4'
        assert.equal(newNode, 'shard-4');
      }
    }

    // Adding a 5th node should ideally move ~20% of keys (1/5th).
    // Tolerating standard statistical variance [12%, 28%]
    const migrationRatio = migrated / TOTAL_KEYS;
    assert(
      migrationRatio >= 0.12 && migrationRatio <= 0.28,
      `Unexpected migration ratio: ${(migrationRatio * 100).toFixed(1)}%`
    );
  });

  runTest('Removing a node cleanly redistributes its keys among remaining nodes', () => {
    const ring = new ConsistentHashRing({ vnodesPerNode: 150 });
    ring.addNode('shard-A');
    ring.addNode('shard-B');
    ring.addNode('shard-C');

    assert.equal(ring.getNodes().length, 3);
    assert.equal(ring.vnodeCount, 450);

    ring.removeNode('shard-B');

    assert.equal(ring.getNodes().length, 2);
    assert.equal(ring.vnodeCount, 300);

    // No keys should map to shard-B
    for (let i = 0; i < 500; i++) {
      const node = ring.getNode(`key_${i}`);
      assert(node === 'shard-A' || node === 'shard-C');
    }
  });

  console.log('--- All Consistent Hash Ring Tests Passed! ---\n');
}

runConsistentHashTests().catch((err) => {
  console.error('ConsistentHashRing test suite failed:', err);
  process.exit(1);
});
