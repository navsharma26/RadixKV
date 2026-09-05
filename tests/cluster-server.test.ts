import assert from 'node:assert/strict';
import * as net from 'node:net';
import { ClusterServer } from '../src/cluster/cluster-server.ts';

function readFromSocket(client: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      client.off('error', onError);
      resolve(data);
    };
    const onError = (err: Error) => {
      client.off('data', onData);
      reject(err);
    };
    client.once('data', onData);
    client.once('error', onError);
  });
}

function runTest(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      throw err;
    });
}

async function runClusterServerTests() {
  console.log('--- Running Multi-Core ClusterServer Integration Tests ---');

  const cluster = new ClusterServer({
    port: 0,
    host: '127.0.0.1',
    shardCount: 4,
    vnodesPerNode: 150,
  });

  const { port, host } = await cluster.start();
  assert(port > 0);

  try {
    await runTest('Master routes PING to worker shard and returns +PONG\\r\\n', async () => {
      const client = net.createConnection({ port, host });
      await new Promise((r) => client.once('connect', r));

      client.write('*1\r\n$4\r\nPING\r\n');
      const res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '+PONG\r\n');

      client.end();
    });

    await runTest('Deterministic key partitioning routes SET/GET across worker shards', async () => {
      const client = net.createConnection({ port, host });
      await new Promise((r) => client.once('connect', r));

      // We will insert 20 keys. They will be partitioned across the 4 worker threads.
      for (let i = 0; i < 20; i++) {
        const key = `cluster_key_${i}`;
        const val = `value_${i}`;
        const cmd = `*3\r\n$3\r\nSET\r\n$${key.length}\r\n${key}\r\n$${val.length}\r\n${val}\r\n`;
        client.write(cmd);
        const res = await readFromSocket(client);
        assert.equal(res.toString('utf-8'), '+OK\r\n');
      }

      // Read all 20 keys back
      for (let i = 0; i < 20; i++) {
        const key = `cluster_key_${i}`;
        const cmd = `*2\r\n$3\r\nGET\r\n$${key.length}\r\n${key}\r\n`;
        client.write(cmd);
        const res = await readFromSocket(client);
        const expected = `$${`value_${i}`.length}\r\nvalue_${i}\r\n`;
        assert.equal(res.toString('utf-8'), expected);
      }

      client.end();
    });

    await runTest('Cross-shard multi-key DEL synchronizes atomically across worker threads', async () => {
      const client = net.createConnection({ port, host });
      await new Promise((r) => client.once('connect', r));

      // Choose keys that belong to different shards on the consistent hash ring
      const keys = ['key_shard_alpha', 'key_shard_beta', 'key_shard_gamma', 'key_shard_delta'];
      const shards = keys.map((k) => cluster.coordinator.getShardForKey(k));

      // Set all keys first
      for (const k of keys) {
        client.write(`*3\r\n$3\r\nSET\r\n$${k.length}\r\n${k}\r\n$4\r\ndata\r\n`);
        const res = await readFromSocket(client);
        assert.equal(res.toString('utf-8'), '+OK\r\n');
      }

      // Issue cross-shard multi-key DEL
      // *5\r\n$3\r\nDEL\r\n$<len>\r\nkey...\r\n...
      const delParts: string[] = ['*5\r\n$3\r\nDEL\r\n'];
      for (const k of keys) {
        delParts.push(`$${k.length}\r\n${k}\r\n`);
      }

      client.write(delParts.join(''));
      const res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), ':4\r\n');

      // Verify all keys are gone
      for (const k of keys) {
        client.write(`*2\r\n$3\r\nGET\r\n$${k.length}\r\n${k}\r\n`);
        const getRes = await readFromSocket(client);
        assert.equal(getRes.toString('utf-8'), '$-1\r\n');
      }

      client.end();
    });

  } finally {
    console.log('Stopping cluster server...');
    await cluster.stop();
    console.log('--- All ClusterServer Integration Tests Passed! ---\n');
  }
}

runClusterServerTests().catch((err) => {
  console.error('ClusterServer test suite failed:', err);
  process.exit(1);
});
