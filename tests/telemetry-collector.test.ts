import assert from 'node:assert';
import { TelemetryCollector } from '../src/telemetry/telemetry-collector.ts';

async function runTelemetryCollectorTests() {
  console.log('--- Running TelemetryCollector Unit Tests ---');

  // Test 1: Percentile computation on known latency distributions
  {
    const collector = new TelemetryCollector({ tickIntervalMs: 100 });

    // Record 100 samples from 1ms to 100ms in nanoseconds (1ms = 1_000_000 ns)
    for (let i = 1; i <= 100; i++) {
      collector.recordCommand('GET', i * 1_000_000, i % 2 === 0);
    }

    const snapshot = await collector.tick();
    assert.strictEqual(snapshot.latencies.min, 1);
    assert.strictEqual(snapshot.latencies.max, 100);
    assert.strictEqual(snapshot.latencies.p50, 51);
    assert.strictEqual(snapshot.latencies.p90, 91);
    assert.strictEqual(snapshot.latencies.p95, 96);
    assert.strictEqual(snapshot.latencies.p99, 100);
    console.log('  ✓ Computes exact sub-millisecond percentiles (P50, P90, P95, P99)');
  }

  // Test 2: Hit / Miss ratio and command breakdown
  {
    const collector = new TelemetryCollector({ tickIntervalMs: 100 });

    // 80 hits, 20 misses
    for (let i = 0; i < 80; i++) {
      collector.recordCommand('GET', 50_000, true);
    }
    for (let i = 0; i < 20; i++) {
      collector.recordCommand('GET', 30_000, false);
    }
    for (let i = 0; i < 50; i++) {
      collector.recordCommand('SET', 40_000);
    }

    const snapshot = await collector.tick();
    assert.strictEqual(snapshot.hitCount, 80);
    assert.strictEqual(snapshot.missCount, 20);
    assert.strictEqual(snapshot.hitMissRatio, 0.8);
    assert.strictEqual(snapshot.commandBreakdown['GET'], 100);
    assert.strictEqual(snapshot.commandBreakdown['SET'], 50);
    console.log('  ✓ Accurate hit/miss ratios and command distribution counters');
  }

  // Test 3: Connected socket count management
  {
    const collector = new TelemetryCollector({ tickIntervalMs: 100 });
    assert.strictEqual(collector.getLatestSnapshot(), null);

    collector.setConnectedSockets(5);
    collector.incrementConnectedSockets();
    assert.strictEqual((await collector.tick()).connectedSockets, 6);

    collector.decrementConnectedSockets();
    assert.strictEqual((await collector.tick()).connectedSockets, 5);
    console.log('  ✓ Correctly tracks connected client socket counts');
  }

  // Test 4: Memory metrics and 2D heatmap generation
  {
    const collector = new TelemetryCollector({ tickIntervalMs: 100 });
    const snapshot = await collector.tick();

    assert.ok(snapshot.memory.heapUsedBytes > 0);
    assert.ok(snapshot.memory.heapTotalBytes > 0);
    assert.ok(snapshot.memory.rssBytes > 0);
    assert.strictEqual(snapshot.heatmap.length, 64);

    const firstBlock = snapshot.heatmap[0];
    assert.strictEqual(firstBlock.blockId, 0);
    assert.ok(firstBlock.vnodeRange.includes('%'));
    assert.ok(['healthy', 'warning', 'expiring'].includes(firstBlock.ttlHealth));
    console.log('  ✓ Populates memory allocation metrics and 64-block memory heatmap');
  }

  // Test 5: History buffer bounds
  {
    const collector = new TelemetryCollector({ tickIntervalMs: 10, historyLength: 5 });
    for (let i = 0; i < 10; i++) {
      await collector.tick();
    }
    const history = collector.getHistory();
    assert.strictEqual(history.length, 5);
    console.log('  ✓ Maintains bounded circular history window without leaks');
  }

  console.log('--- All TelemetryCollector Unit Tests Passed! ---\n');
}

runTelemetryCollectorTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
