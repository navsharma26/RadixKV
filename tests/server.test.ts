import assert from 'node:assert/strict';
import * as net from 'node:net';
import { RespServer } from '../src/server.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper to read exact response from a socket
 */
function readFromSocket(client: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    client.once('data', (data) => resolve(data));
    client.once('error', (err) => reject(err));
  });
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

async function runServerTests() {
  console.log('--- Running RespServer End-to-End Integration Tests ---');

  // Start server on ephemeral port (0)
  const server = new RespServer({
    host: '127.0.0.1',
    port: 0,
    idleTimeoutMs: 0,
    shutdownTimeoutMs: 2000,
  });

  const { port, host } = await server.start();
  assert(port > 0, `Invalid ephemeral port: ${port}`);

  try {
    await runTest('PING command with 0 arguments returns +PONG\\r\\n', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      // RESP Array format: *1\r\n$4\r\nPING\r\n
      client.write('*1\r\n$4\r\nPING\r\n');
      const res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '+PONG\r\n');
      client.end();
    });

    await runTest('PING command with custom message returns Bulk String', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      // *2\r\n$4\r\nPING\r\n$14\r\nCustom message\r\n
      client.write('*2\r\n$4\r\nPING\r\n$14\r\nCustom message\r\n');
      const res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '$14\r\nCustom message\r\n');
      client.end();
    });

    await runTest('ECHO command returns Bulk String with payload', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      // *2\r\n$4\r\nECHO\r\n$11\r\nhello world\r\n
      client.write('*2\r\n$4\r\nECHO\r\n$11\r\nhello world\r\n');
      const res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '$11\r\nhello world\r\n');
      client.end();
    });

    await runTest('ECHO with invalid arity returns error', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      // *1\r\n$4\r\nECHO\r\n
      client.write('*1\r\n$4\r\nECHO\r\n');
      const res = await readFromSocket(client);
      assert(res.toString('utf-8').startsWith('-ERR wrong number of arguments'));
      client.end();
    });

    await runTest('Handles TCP Packet Fragmentation over real network socket', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      const responsePromise = readFromSocket(client);

      const command = '*2\r\n$4\r\nECHO\r\n$10\r\nfragmented\r\n';
      const raw = Buffer.from(command);

      // Send 1 byte at a time with 3ms delays
      for (let i = 0; i < raw.length; i++) {
        client.write(raw.subarray(i, i + 1));
        await delay(3);
      }

      const res = await responsePromise;
      assert.equal(res.toString('utf-8'), '$10\r\nfragmented\r\n');
      client.end();
    });

    await runTest('Handles Pipelining (50 commands sent in single write)', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      const count = 50;
      const cmd = '*1\r\n$4\r\nPING\r\n';
      const pipelineBuf = Buffer.from(cmd.repeat(count));

      let received = Buffer.alloc(0);

      const allDataPromise = new Promise<void>((resolve) => {
        const onData = (chunk: Buffer) => {
          received = Buffer.concat([received, chunk]);
          if (received.length >= 7 * count) { // "+PONG\r\n" is 7 bytes
            client.off('data', onData);
            resolve();
          }
        };
        client.on('data', onData);
      });

      client.write(pipelineBuf);
      await allDataPromise;

      const expected = '+PONG\r\n'.repeat(count);
      assert.equal(received.toString('utf-8'), expected);
      client.end();
    });

    await runTest('QUIT command returns +OK\\r\\n and terminates connection', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      const closedPromise = new Promise<boolean>((resolve) => {
        client.on('close', () => resolve(true));
      });

      client.write('*1\r\n$4\r\nQUIT\r\n');
      const res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '+OK\r\n');

      const closed = await closedPromise;
      assert.equal(closed, true);
    });

    await runTest('Malformed protocol buffer returns Protocol error and closes socket', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      const closedPromise = new Promise<boolean>((resolve) => {
        client.on('close', () => resolve(true));
      });

      // Send malformed bulk string with missing CRLF
      client.write('$5\r\nhellothisisnotcrlf');
      const res = await readFromSocket(client);
      assert(res.toString('utf-8').includes('-ERR Protocol error'));

      const closed = await closedPromise;
      assert.equal(closed, true);
    });

    await runTest('Concurrent clients interacting simultaneously', async () => {
      const clientCount = 10;
      const clients = await Promise.all(
        Array.from({ length: clientCount }, async (_, i) => {
          const client = net.createConnection({ host, port });
          await new Promise((resolve) => client.once('connect', resolve));
          return { client, id: i };
        })
      );

      const results = await Promise.all(
        clients.map(async ({ client, id }) => {
          const msg = `client-${id}`;
          const cmd = `*2\r\n$4\r\nECHO\r\n$${msg.length}\r\n${msg}\r\n`;
          client.write(cmd);
          const res = await readFromSocket(client);
          client.end();
          return res.toString('utf-8');
        })
      );

      for (let i = 0; i < clientCount; i++) {
        assert.equal(results[i], `$${`client-${i}`.length}\r\nclient-${i}\r\n`);
      }
    });

    await runTest('SET, GET, and DEL work over real TCP socket', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      // SET mykey myvalue
      client.write('*3\r\n$3\r\nSET\r\n$5\r\nmykey\r\n$7\r\nmyvalue\r\n');
      let res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '+OK\r\n');

      // GET mykey
      client.write('*2\r\n$3\r\nGET\r\n$5\r\nmykey\r\n');
      res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '$7\r\nmyvalue\r\n');

      // DEL mykey
      client.write('*2\r\n$3\r\nDEL\r\n$5\r\nmykey\r\n');
      res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), ':1\r\n');

      // GET after DEL -> $-1\r\n
      client.write('*2\r\n$3\r\nGET\r\n$5\r\nmykey\r\n');
      res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '$-1\r\n');

      client.end();
    });

    await runTest('INCR command works over real TCP socket', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      // INCR hits -> :1\r\n
      client.write('*2\r\n$4\r\nINCR\r\n$4\r\nhits\r\n');
      let res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), ':1\r\n');

      // INCR hits -> :2\r\n
      client.write('*2\r\n$4\r\nINCR\r\n$4\r\nhits\r\n');
      res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), ':2\r\n');

      client.end();
    });

    await runTest('SET with EX and TTL command work over real TCP socket', async () => {
      const client = net.createConnection({ host, port });
      await new Promise((resolve) => client.once('connect', resolve));

      // SET session token123 EX 10
      client.write('*5\r\n$3\r\nSET\r\n$7\r\nsession\r\n$8\r\ntoken123\r\n$2\r\nEX\r\n$2\r\n10\r\n');
      let res = await readFromSocket(client);
      assert.equal(res.toString('utf-8'), '+OK\r\n');

      // TTL session -> :10\r\n (or :9\r\n)
      client.write('*2\r\n$3\r\nTTL\r\n$7\r\nsession\r\n');
      res = await readFromSocket(client);
      const ttlNum = parseInt(res.toString('utf-8').slice(1).trim(), 10);
      assert(ttlNum >= 9 && ttlNum <= 10, `Unexpected TTL: ${ttlNum}`);

      client.end();
    });

  } finally {
    console.log('Stopping server...');
    await server.stop();
    console.log('--- All RespServer Integration Tests Passed! ---\n');
  }
}

runServerTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
