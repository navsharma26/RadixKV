import assert from 'node:assert';
import { WebSocket } from 'ws';
import { ClusterCoordinator } from '../src/cluster/cluster-coordinator.ts';
import { TelemetryServer } from '../src/telemetry/telemetry-server.ts';

async function runTelemetryServerTests() {
  console.log('--- Running TelemetryServer & WebSocket Integration Tests ---');

  const coordinator = new ClusterCoordinator({ shardCount: 2, vnodesPerNode: 20 });
  await coordinator.init();

  const telemetryPort = 7890;
  const server = new TelemetryServer({
    port: telemetryPort,
    host: '127.0.0.1',
    coordinator,
    tcpPort: 6379,
    autoSimulate: false,
  });

  await server.start();

  try {
    // 1. GET /api/cluster-info
    const clusterInfoRes = await fetch(`http://127.0.0.1:${telemetryPort}/api/cluster-info`);
    assert.strictEqual(clusterInfoRes.status, 200);
    const clusterInfo = await clusterInfoRes.json();
    assert.strictEqual(clusterInfo.shardCount, 2);
    assert.strictEqual(clusterInfo.vnodesPerShard, 150);
    assert.strictEqual(clusterInfo.tcpPort, 6379);
    console.log('  ✓ GET /api/cluster-info returns valid cluster topology and ports');

    // 2. POST /api/command (SET, GET, INCR)
    const setRes = await fetch(`http://127.0.0.1:${telemetryPort}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'SET cluster:key "Hello Telemetry" EX 60' }),
    });
    assert.strictEqual(setRes.status, 200);
    const setJson = await setRes.json();
    assert.strictEqual(setJson.success, true);
    assert.strictEqual(setJson.output, 'OK');
    assert.ok(setJson.latencyUs >= 0);
    console.log(`  ✓ POST /api/command (SET) executed in ${setJson.latencyUs} µs`);

    const getRes = await fetch(`http://127.0.0.1:${telemetryPort}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'GET cluster:key' }),
    });
    assert.strictEqual(getRes.status, 200);
    const getJson = await getRes.json();
    assert.strictEqual(getJson.success, true);
    assert.strictEqual(getJson.output, '"Hello Telemetry"');
    console.log(`  ✓ POST /api/command (GET) returned "${getJson.output}" in ${getJson.latencyUs} µs`);

    const incrRes = await fetch(`http://127.0.0.1:${telemetryPort}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'INCR metric:hits' }),
    });
    const incrJson = await incrRes.json();
    assert.strictEqual(incrJson.output, '(integer) 1');
    console.log('  ✓ POST /api/command (INCR) handles Redis integer increments');

    // 3. GET /api/metrics
    const metricsRes = await fetch(`http://127.0.0.1:${telemetryPort}/api/metrics`);
    assert.strictEqual(metricsRes.status, 200);
    const metricsJson = await metricsRes.json();
    assert.ok(metricsJson.history);
    console.log('  ✓ GET /api/metrics returns current telemetry snapshot and historical buffer');

    // 4. WebSocket /ws connection & live streaming
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${telemetryPort}/ws`);

      let initialReceived = false;

      ws.on('open', () => {
        // Send command over WebSocket
        ws.send(JSON.stringify({
          type: 'COMMAND',
          id: 42,
          command: 'PING "WebSocket Ping"',
        }));
      });

      ws.on('message', (raw: string) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'INITIAL_STATE') {
          initialReceived = true;
        } else if (msg.type === 'COMMAND_RESULT' && msg.id === 42) {
          assert.strictEqual(msg.output, '"WebSocket Ping"');
          assert.ok(initialReceived);
          ws.close();
          resolve();
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('WebSocket test timeout')), 4000);
    });
    console.log('  ✓ WebSocket /ws streams initial state and processes custom commands');

  } finally {
    await server.stop();
    await coordinator.close();
  }

  console.log('--- All TelemetryServer & WebSocket Integration Tests Passed! ---\n');
}

runTelemetryServerTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
