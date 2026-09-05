import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { BsonCodec } from '../src/bson-encoder.ts';
import {
  ColdStorageWorker,
  InMemoryColdStorageSink,
  MongoDriverColdStorageSink,
} from '../src/cold-storage-worker.ts';
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

async function runColdStorageTests() {
  console.log('--- Running Cold-Storage & BSON Subsystem Tests ---');

  runTest('BsonCodec encodes and decodes primitives, binary buffers, dates, and arrays', () => {
    const original = {
      str: 'hello world',
      int32: 12345,
      int64: 9223372036854775807n,
      double: 3.14159,
      boolTrue: true,
      boolFalse: false,
      nullVal: null,
      date: new Date(1700000000000),
      bin: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      nested: {
        innerKey: 'innerValue',
      },
      tags: ['archive', 'radix', 'cold'],
    };

    const encoded = BsonCodec.encode(original);
    assert(encoded.length > 0);

    const decoded = BsonCodec.decode(encoded);
    assert.equal(decoded.str, original.str);
    assert.equal(decoded.int32, original.int32);
    assert.equal(decoded.int64, original.int64);
    assert(Math.abs(decoded.double - original.double) < 0.0001);
    assert.equal(decoded.boolTrue, true);
    assert.equal(decoded.boolFalse, false);
    assert.equal(decoded.nullVal, null);
    assert.equal(decoded.date.getTime(), original.date.getTime());
    assert.deepEqual(decoded.bin, original.bin);
    assert.equal(decoded.nested.innerKey, 'innerValue');
    assert.deepEqual(decoded.tags, ['archive', 'radix', 'cold']);
  });

  await runTest('ColdStorageWorker packages, compresses (gzip), and ships BSON snapshots', async () => {
    const engine = new StorageEngine();
    const sink = new InMemoryColdStorageSink();

    // Insert 50 keys into storage engine
    for (let i = 0; i < 50; i++) {
      engine.set(`user:${i}`, Buffer.from(`data_payload_for_user_${i}_testing_compression_ratio`));
    }

    const worker = new ColdStorageWorker({
      engine,
      sink,
      batchSize: 30,
      evictAfterArchive: false,
    });

    const snapshot = await worker.createSnapshot();
    assert(snapshot !== null);
    assert.equal(snapshot.keyCount, 30);
    assert(snapshot.uncompressedBsonBytes > 0);
    assert(snapshot.compressedBytes > 0);
    // Compression should reduce size significantly on repeated text data
    assert(snapshot.compressedBytes < snapshot.uncompressedBsonBytes);

    // Verify snapshot stored in sink
    assert.equal(sink.count, 1);
    const stored = sink.snapshots[0];
    assert.equal(stored.snapshotId, snapshot.snapshotId);

    // Decompress with gzip and decode BSON to verify data integrity
    const decompressed = zlib.gunzipSync(stored.compressedData);
    assert.equal(decompressed.length, snapshot.uncompressedBsonBytes);

    const decodedDoc = BsonCodec.decode(decompressed);
    assert.equal(decodedDoc.keyCount, 30);
    assert(Array.isArray(decodedDoc.entries));
    assert.equal(decodedDoc.entries.length, 30);

    // Verify entry fields
    const firstEntry = decodedDoc.entries[0];
    assert(firstEntry.key.startsWith('user:'));
    assert(Buffer.isBuffer(firstEntry.value));
    assert(firstEntry.value.toString().startsWith('data_payload_for_user_'));

    engine.stopTtlSweep();
  });

  await runTest('ColdStorageWorker with evictAfterArchive reclaims DRAM memory', async () => {
    const engine = new StorageEngine();
    const sink = new InMemoryColdStorageSink();

    for (let i = 0; i < 10; i++) {
      engine.set(`cold:${i}`, Buffer.from(`val_${i}`));
    }
    assert.equal(engine.size, 10);

    const worker = new ColdStorageWorker({
      engine,
      sink,
      batchSize: 5,
      evictAfterArchive: true, // Evict after archiving to MongoDB
    });

    const snapshot = await worker.createSnapshot();
    assert(snapshot !== null);
    assert.equal(snapshot.keyCount, 5);

    // Engine size should decrease by 5
    assert.equal(engine.size, 5);
    assert.equal(sink.count, 1);

    engine.stopTtlSweep();
  });

  await runTest('MongoDriverColdStorageSink integrates with MongoDB collection adapter', async () => {
    const insertedDocs: any[] = [];
    const mockCollection = {
      insertOne: async (doc: any) => {
        insertedDocs.push(doc);
        return { acknowledged: true, insertedId: doc._id };
      },
    };

    const mongoSink = new MongoDriverColdStorageSink(mockCollection);
    const engine = new StorageEngine();

    engine.set('audit_key', Buffer.from('critical_log_data'));

    const worker = new ColdStorageWorker({
      engine,
      sink: mongoSink,
      batchSize: 10,
    });

    await worker.createSnapshot();

    assert.equal(insertedDocs.length, 1);
    const doc = insertedDocs[0];
    assert(doc._id.startsWith('snapshot_'));
    assert.equal(doc.keyCount, 1);
    assert(Buffer.isBuffer(doc.data)); // Compressed payload

    engine.stopTtlSweep();
  });

  console.log('--- All Cold-Storage & BSON Subsystem Tests Passed! ---\n');
}

runColdStorageTests().catch((err) => {
  console.error('Cold-storage test suite failed:', err);
  process.exit(1);
});
