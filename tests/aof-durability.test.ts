import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { AofLogger } from '../src/aof-logger.ts';
import { AofRecovery } from '../src/aof-recovery.ts';
import { RespServer } from '../src/server.ts';
import { StorageEngine } from '../src/storage-engine.ts';

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

function readFromSocket(client: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    client.once('data', (data) => resolve(data));
    client.once('error', (err) => reject(err));
  });
}

async function runAofTests() {
  console.log('--- Running AOF Durability & Recovery Tests ---');
  const tempDir = path.join(process.cwd(), '.test_aof_tmp');
  await fs.mkdir(tempDir, { recursive: true });

  try {
    await runTest('AofLogger writes SET, DEL, INCR mutations and closes cleanly', async () => {
      const aofPath = path.join(tempDir, 'test_basic.aof');
      const logger = new AofLogger({ filePath: aofPath, fsyncPolicy: 'always' });

      await logger.logSet('alpha', Buffer.from('value_a'));
      await logger.logSet('beta', Buffer.from('value_b'), 60);
      await logger.logIncr('counter');
      await logger.logIncr('counter');
      await logger.logDel(['alpha']);
      await logger.close();

      const raw = await fs.readFile(aofPath, 'utf-8');
      assert(raw.includes('SET'));
      assert(raw.includes('alpha'));
      assert(raw.includes('value_a'));
      assert(raw.includes('counter'));
      assert(raw.includes('DEL'));
    });

    await runTest('AofRecovery restores state into StorageEngine sequentially', async () => {
      const aofPath = path.join(tempDir, 'test_restore.aof');
      const logger = new AofLogger({ filePath: aofPath, fsyncPolicy: 'always' });

      await logger.logSet('k1', Buffer.from('v1'));
      await logger.logSet('k2', Buffer.from('v2'));
      await logger.logIncr('c1');
      await logger.logIncr('c1');
      await logger.logIncr('c1');
      await logger.logDel(['k1']);
      await logger.close();

      // Restore into fresh engine
      const freshEngine = new StorageEngine();
      const result = await AofRecovery.restore(aofPath, freshEngine);

      assert.equal(result.commandsReplayed, 6);
      assert.equal(result.truncatedBytes, 0);
      assert.equal(freshEngine.get('k1'), null, 'k1 should have been deleted');
      assert.equal(freshEngine.get('k2')?.toString(), 'v2');
      assert.equal(freshEngine.get('c1')?.toString(), '3');

      freshEngine.stopTtlSweep();
    });

    await runTest('AofRecovery detects crash truncation and repairs trailing corrupt bytes', async () => {
      const aofPath = path.join(tempDir, 'test_corrupt.aof');
      const logger = new AofLogger({ filePath: aofPath, fsyncPolicy: 'always' });

      await logger.logSet('clean_key', Buffer.from('clean_val'));
      await logger.close();

      // Append an incomplete command simulating power loss mid-write (*3\r\n$3\r\nSET\r\n$7\r\nincomp)
      const corruptedTail = Buffer.from('*3\r\n$3\r\nSET\r\n$7\r\nincomp');
      const fh = await fs.open(aofPath, 'a');
      await fh.write(corruptedTail);
      await fh.close();

      const freshEngine = new StorageEngine();
      const result = await AofRecovery.restore(aofPath, freshEngine);

      assert.equal(result.commandsReplayed, 1);
      assert.equal(result.truncatedBytes, corruptedTail.length);
      assert.equal(freshEngine.get('clean_key')?.toString(), 'clean_val');
      assert.equal(freshEngine.get('incomp'), null);

      // Verify file was truncated on disk
      const repairedContent = await fs.readFile(aofPath);
      assert(!repairedContent.includes(Buffer.from('incomp')));

      freshEngine.stopTtlSweep();
    });

    await runTest('RespServer crash-recovery restart cycle over TCP', async () => {
      const aofPath = path.join(tempDir, 'test_server_cycle.aof');

      // 1. Start server with AOF
      let server = new RespServer({
        port: 0,
        host: '127.0.0.1',
        aofPath,
        fsyncPolicy: 'always',
      });

      const { port, host } = await server.start();

      const client1 = net.createConnection({ port, host });
      await new Promise((r) => client1.once('connect', r));

      // SET persisted_key "SavedAcrossRestarts"
      client1.write('*3\r\n$3\r\nSET\r\n$13\r\npersisted_key\r\n$19\r\nSavedAcrossRestarts\r\n');
      let res = await readFromSocket(client1);
      assert.equal(res.toString(), '+OK\r\n');

      // INCR hits twice
      client1.write('*2\r\n$4\r\nINCR\r\n$4\r\nhits\r\n');
      res = await readFromSocket(client1);
      assert.equal(res.toString(), ':1\r\n');

      client1.write('*2\r\n$4\r\nINCR\r\n$4\r\nhits\r\n');
      res = await readFromSocket(client1);
      assert.equal(res.toString(), ':2\r\n');

      client1.end();
      await server.stop();

      // 2. Restart a brand new server on same AOF file
      server = new RespServer({
        port: 0,
        host: '127.0.0.1',
        aofPath,
        fsyncPolicy: 'always',
      });

      const started = await server.start();
      assert(started.recovery !== undefined);
      assert(started.recovery.commandsReplayed >= 3);

      const client2 = net.createConnection({ port: started.port, host: started.host });
      await new Promise((r) => client2.once('connect', r));

      // GET persisted_key
      client2.write('*2\r\n$3\r\nGET\r\n$13\r\npersisted_key\r\n');
      res = await readFromSocket(client2);
      assert.equal(res.toString(), '$19\r\nSavedAcrossRestarts\r\n');

      // GET hits
      client2.write('*2\r\n$3\r\nGET\r\n$4\r\nhits\r\n');
      res = await readFromSocket(client2);
      assert.equal(res.toString(), '$1\r\n2\r\n');

      client2.end();
      await server.stop();
    });

  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    console.log('--- All AOF Durability & Recovery Tests Passed! ---\n');
  }
}

runAofTests().catch((err) => {
  console.error('AOF test suite failed:', err);
  process.exit(1);
});
