import assert from 'node:assert/strict';
import { RespParser } from '../src/resp-parser.ts';
import { ProtocolError } from '../src/types.ts';
import type { RespValue } from '../src/types.ts';

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

async function runParserTests() {
  console.log('--- Running RespParser Unit Tests ---');

  runTest('Parses Simple String (+OK\\r\\n)', () => {
    const parser = new RespParser();
    const result = parser.execute(Buffer.from('+OK\r\n'));
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { type: 'simple_string', value: 'OK' });
  });

  runTest('Parses Simple Error (-ERR unknown\\r\\n)', () => {
    const parser = new RespParser();
    const result = parser.execute(Buffer.from('-ERR unknown command\r\n'));
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { type: 'error', value: 'ERR unknown command' });
  });

  runTest('Parses Integers (:1000\\r\\n, :-42\\r\\n, :+99\\r\\n, large 64-bit)', () => {
    const parser = new RespParser();
    let res = parser.execute(Buffer.from(':1000\r\n'));
    assert.deepEqual(res[0], { type: 'integer', value: 1000n });

    res = parser.execute(Buffer.from(':-42\r\n'));
    assert.deepEqual(res[0], { type: 'integer', value: -42n });

    res = parser.execute(Buffer.from(':+99\r\n'));
    assert.deepEqual(res[0], { type: 'integer', value: 99n });

    res = parser.execute(Buffer.from(':9223372036854775807\r\n'));
    assert.deepEqual(res[0], { type: 'integer', value: 9223372036854775807n });
  });

  runTest('Parses Bulk String ($5\\r\\nhello\\r\\n)', () => {
    const parser = new RespParser();
    const result = parser.execute(Buffer.from('$5\r\nhello\r\n'));
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'bulk_string');
    assert.equal(result[0].value?.toString('utf-8'), 'hello');
  });

  runTest('Parses Empty Bulk String ($0\\r\\n\\r\\n)', () => {
    const parser = new RespParser();
    const result = parser.execute(Buffer.from('$0\r\n\r\n'));
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'bulk_string');
    assert.equal(result[0].value?.length, 0);
  });

  runTest('Parses Null Bulk String ($-1\\r\\n)', () => {
    const parser = new RespParser();
    const result = parser.execute(Buffer.from('$-1\r\n'));
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { type: 'bulk_string', value: null });
  });

  runTest('Parses Array (*2\\r\\n$4\\r\\nECHO\\r\\n$5\\r\\nhello\\r\\n)', () => {
    const parser = new RespParser();
    const result = parser.execute(Buffer.from('*2\r\n$4\r\nECHO\r\n$5\r\nhello\r\n'));
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'array');
    const arr = result[0].value;
    assert(arr !== null);
    assert.equal(arr.length, 2);
    assert.equal((arr[0] as any).value.toString(), 'ECHO');
    assert.equal((arr[1] as any).value.toString(), 'hello');
  });

  runTest('Parses Empty and Null Arrays (*0\\r\\n, *-1\\r\\n)', () => {
    const parser = new RespParser();
    let res = parser.execute(Buffer.from('*0\r\n'));
    assert.deepEqual(res[0], { type: 'array', value: [] });

    res = parser.execute(Buffer.from('*-1\r\n'));
    assert.deepEqual(res[0], { type: 'array', value: null });
  });

  runTest('Parses Nested Arrays', () => {
    const parser = new RespParser();
    // [ [ "PING" ], [ "PONG" ] ]
    const input = '*2\r\n*1\r\n$4\r\nPING\r\n*1\r\n$4\r\nPONG\r\n';
    const result = parser.execute(Buffer.from(input));
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'array');
    const root = result[0].value!;
    assert.equal(root.length, 2);
    assert.equal((root[0] as any).value[0].value.toString(), 'PING');
    assert.equal((root[1] as any).value[0].value.toString(), 'PONG');
  });

  runTest('Handles Extreme 1-Byte TCP Packet Fragmentation', () => {
    const parser = new RespParser();
    const raw = Buffer.from('*2\r\n$4\r\nECHO\r\n$11\r\nhello world\r\n');
    const accumulated: RespValue[] = [];

    // Feed the entire command 1 single byte at a time
    for (let i = 0; i < raw.length; i++) {
      const byteChunk = raw.subarray(i, i + 1);
      const res = parser.execute(byteChunk);
      if (i < raw.length - 1) {
        assert.equal(res.length, 0, `Premature yield at byte index ${i}`);
      } else {
        assert.equal(res.length, 1, `Expected 1 result at final byte`);
        accumulated.push(...res);
      }
    }

    assert.equal(accumulated.length, 1);
    const arr = accumulated[0].value as any[];
    assert.equal(arr[0].value.toString(), 'ECHO');
    assert.equal(arr[1].value.toString(), 'hello world');
  });

  runTest('Handles Split CRLF Across TCP Packets (\\r in chunk 1, \\n in chunk 2)', () => {
    const parser = new RespParser();
    const chunk1 = Buffer.from('+PING-RESPONSE\r');
    const chunk2 = Buffer.from('\n');

    let res = parser.execute(chunk1);
    assert.equal(res.length, 0);

    res = parser.execute(chunk2);
    assert.equal(res.length, 1);
    assert.deepEqual(res[0], { type: 'simple_string', value: 'PING-RESPONSE' });
  });

  runTest('Handles Command Pipelining (Multiple Frames in One Chunk)', () => {
    const parser = new RespParser();
    const command = '*1\r\n$4\r\nPING\r\n';
    const pipelined = Buffer.from(command.repeat(100));

    const results = parser.execute(pipelined);
    assert.equal(results.length, 100);
    for (const item of results) {
      assert.equal(item.type, 'array');
      assert.equal((item.value as any[])[0].value.toString(), 'PING');
    }
  });

  runTest('Throws on Missing CRLF After Bulk String Body', () => {
    const parser = new RespParser();
    // $4\r\ntestXX instead of $4\r\ntest\r\n
    const corrupted = Buffer.from('$4\r\ntestXX');
    assert.throws(
      () => parser.execute(corrupted),
      (err: any) => err instanceof ProtocolError && err.code === 'ERR_MALFORMED_BULK_TERMINATOR'
    );
  });

  runTest('Throws on Invalid Integer Format', () => {
    const parser = new RespParser();
    assert.throws(
      () => parser.execute(Buffer.from(':abc\r\n')),
      (err: any) => err instanceof ProtocolError && err.code === 'ERR_INVALID_INTEGER'
    );
  });

  runTest('Throws on Invalid Bulk String Length', () => {
    const parser = new RespParser();
    assert.throws(
      () => parser.execute(Buffer.from('$-2\r\n')),
      (err: any) => err instanceof ProtocolError && err.code === 'ERR_INVALID_BULK_LENGTH'
    );
  });

  runTest('Throws on Unknown Type Prefix', () => {
    const parser = new RespParser();
    assert.throws(
      () => parser.execute(Buffer.from('?hello\r\n')),
      (err: any) => err instanceof ProtocolError && err.code === 'ERR_UNKNOWN_PREFIX'
    );
  });

  runTest('Enforces Max Inline Header Length Guard', () => {
    const parser = new RespParser({ maxInlineLength: 100 });
    const hugeLine = Buffer.alloc(150, 0x61); // 150 'a's with no CRLF
    assert.throws(
      () => parser.execute(hugeLine),
      (err: any) => err instanceof ProtocolError && err.code === 'ERR_HEADER_TOO_LONG'
    );
  });

  runTest('Enforces Max Bulk String Length Guard', () => {
    const parser = new RespParser({ maxBulkLength: 1024 });
    assert.throws(
      () => parser.execute(Buffer.from('$2048\r\n')),
      (err: any) => err instanceof ProtocolError && err.code === 'ERR_BULK_TOO_LARGE'
    );
  });

  runTest('Enforces Max Array Nesting Depth Guard', () => {
    const parser = new RespParser({ maxArrayDepth: 3 });
    // Attempt 4 levels deep
    assert.throws(
      () => parser.execute(Buffer.from('*1\r\n*1\r\n*1\r\n*1\r\n$4\r\nPING\r\n')),
      (err: any) => err instanceof ProtocolError && err.code === 'ERR_NESTING_DEPTH_EXCEEDED'
    );
  });

  console.log('--- All RespParser Unit Tests Passed! ---\n');
}

runParserTests();
