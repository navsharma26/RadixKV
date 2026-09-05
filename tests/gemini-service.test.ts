import assert from 'node:assert/strict';
import { GeminiService } from '../src/telemetry/gemini-service.ts';
import type { TelemetrySnapshot } from '../src/telemetry/telemetry-collector.ts';

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log('--- Running Gemini AI Service Integration Tests ---');

async function main() {
  const service = new GeminiService();

  await runTest('GeminiService is properly initialized with API key', async () => {
    assert.equal(service.isAvailable(), true, 'GEMINI_API_KEY should be loaded from .env');
  });

  await runTest('Translates natural language into valid Redis commands', async () => {
    const res = await service.translateToRedisCommands('Store user 101 name as Alice with 20 minutes expiration');
    assert(Array.isArray(res.commands) && res.commands.length > 0, 'Should return an array of commands');
    
    const cmd = res.commands[0].toUpperCase();
    assert(cmd.includes('SET'), `Generated command should include SET, got: ${res.commands[0]}`);
    assert(cmd.includes('101') || cmd.includes('ALICE'), `Generated command should include user or name, got: ${res.commands[0]}`);
    assert(res.explanation.length > 0, 'Explanation should be present');
  });

  await runTest('Translates read / counter prompts into GET / INCR / TTL', async () => {
    const resIncr = await service.translateToRedisCommands('Increment the view count for homepage');
    assert(resIncr.commands[0].toUpperCase().includes('INCR'), `Expected INCR command, got: ${resIncr.commands[0]}`);

    const resTtl = await service.translateToRedisCommands('Check remaining time to live for session:token:abc');
    assert(resTtl.commands[0].toUpperCase().includes('TTL'), `Expected TTL command, got: ${resTtl.commands[0]}`);
  });

  await runTest('Generates cluster performance diagnostics from mock telemetry', async () => {
    const mockSnapshot: TelemetrySnapshot = {
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      opsPerSec: 850,
      totalCommands: 15420,
      latencies: {
        p50: 0.085,
        p90: 0.180,
        p95: 0.220,
        p99: 0.350,
        avg: 0.110,
        min: 0.020,
        max: 0.450,
      },
      hitCount: 5200,
      missCount: 800,
      hitMissRatio: 0.866,
      connectedSockets: 4,
      memory: {
        heapUsedBytes: 15_000_000,
        heapTotalBytes: 40_000_000,
        rssBytes: 90_000_000,
        externalBytes: 5_000_000,
        arrayBuffersBytes: 2_000_000,
        heapUsedMb: 14.3,
        heapTotalMb: 38.1,
        rssMb: 85.8,
      },
      commandBreakdown: { SET: 340, GET: 340, INCR: 85, TTL: 85 },
      shardStats: [
        { shardId: 0, keyCount: 15, expiresCount: 12, hits: 650, misses: 100, totalOps: 1927 },
        { shardId: 1, keyCount: 18, expiresCount: 14, hits: 650, misses: 100, totalOps: 1928 },
      ],
      heatmap: [],
    };

    const report = await service.generateClusterDiagnostics(mockSnapshot, {
      shardCount: 2,
      tcpPort: 6379,
      telemetryPort: 3000,
      syntheticTraffic: true,
    });

    assert(['OPTIMAL', 'ATTENTION', 'CRITICAL'].includes(report.status), `Invalid status: ${report.status}`);
    assert(report.headline.length > 5, 'Headline should be informative');
    assert(report.overallScore >= 0 && report.overallScore <= 100, 'Score should be 0-100');
    assert(Array.isArray(report.recommendations), 'Recommendations should be an array');
    assert(report.recommendations.length > 0, 'Should provide at least one recommendation');
  });

  await runTest('Throws clear error when API key is missing', async () => {
    const unauthedService = new GeminiService('');
    await assert.rejects(async () => {
      await unauthedService.translateToRedisCommands('PING');
    }, /not configured/);
  });

  console.log('--- All Gemini AI Service Integration Tests Passed! ---');
}

main().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
