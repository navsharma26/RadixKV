/**
 * Standalone, zero-dependency BSON (Binary JSON) binary encoder & decoder.
 * Conforms to the official BSON specification (https://bsonspec.org/spec.html).
 */
export class BsonCodec {
  /**
   * Encodes a JavaScript object into a binary BSON Buffer.
   */
  public static encode(doc: Record<string, any>): Buffer {
    const buffers: Buffer[] = [];

    for (const [key, val] of Object.entries(doc)) {
      buffers.push(BsonCodec.encodeElement(key, val));
    }

    const payload = Buffer.concat(buffers);
    const totalLength = 4 + payload.length + 1; // 4-byte length + payload + \x00 terminator
    const header = Buffer.allocUnsafe(4);
    header.writeInt32LE(totalLength, 0);

    return Buffer.concat([header, payload, Buffer.from([0x00])]);
  }

  /**
   * Decodes a binary BSON Buffer into a JavaScript object.
   */
  public static decode(buffer: Buffer): Record<string, any> {
    if (buffer.length < 5) {
      throw new Error('Invalid BSON: buffer too small');
    }

    const totalLength = buffer.readInt32LE(0);
    if (totalLength > buffer.length) {
      throw new Error(`Invalid BSON: declared length ${totalLength} exceeds buffer size ${buffer.length}`);
    }

    let offset = 4;
    const result: Record<string, any> = {};

    while (offset < totalLength - 1) {
      const typeByte = buffer[offset++];
      // Read cstring key
      const keyEnd = buffer.indexOf(0x00, offset);
      if (keyEnd === -1 || keyEnd >= totalLength - 1) {
        throw new Error('Invalid BSON: unterminated field name');
      }
      const key = buffer.toString('utf-8', offset, keyEnd);
      offset = keyEnd + 1;

      switch (typeByte) {
        case 0x01: // Double
          result[key] = buffer.readDoubleLE(offset);
          offset += 8;
          break;

        case 0x02: { // String
          const strLen = buffer.readInt32LE(offset);
          result[key] = buffer.toString('utf-8', offset + 4, offset + 4 + strLen - 1);
          offset += 4 + strLen;
          break;
        }

        case 0x03: { // Embedded Document
          const subLen = buffer.readInt32LE(offset);
          result[key] = BsonCodec.decode(buffer.subarray(offset, offset + subLen));
          offset += subLen;
          break;
        }

        case 0x04: { // Array
          const subLen = buffer.readInt32LE(offset);
          const rawDoc = BsonCodec.decode(buffer.subarray(offset, offset + subLen));
          result[key] = Object.values(rawDoc);
          offset += subLen;
          break;
        }

        case 0x05: { // Binary data
          const binLen = buffer.readInt32LE(offset);
          // subtype is at offset + 4
          result[key] = Buffer.from(buffer.subarray(offset + 5, offset + 5 + binLen));
          offset += 5 + binLen;
          break;
        }

        case 0x08: // Boolean
          result[key] = buffer[offset] === 0x01;
          offset += 1;
          break;

        case 0x09: { // UTC Datetime (ms since Unix epoch)
          const ms = Number(buffer.readBigInt64LE(offset));
          result[key] = new Date(ms);
          offset += 8;
          break;
        }

        case 0x0a: // Null
          result[key] = null;
          break;

        case 0x10: // 32-bit Integer
          result[key] = buffer.readInt32LE(offset);
          offset += 4;
          break;

        case 0x12: // 64-bit Integer
          result[key] = buffer.readBigInt64LE(offset);
          offset += 8;
          break;

        default:
          throw new Error(`Unsupported BSON element type: 0x${typeByte.toString(16)}`);
      }
    }

    return result;
  }

  private static encodeElement(key: string, val: any): Buffer {
    const keyBuf = Buffer.from(`${key}\0`, 'utf-8');

    if (val === null || val === undefined) {
      return Buffer.concat([Buffer.from([0x0a]), keyBuf]);
    }

    if (Buffer.isBuffer(val)) {
      // Binary (subtype 0x00: generic binary)
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeInt32LE(val.length, 0);
      return Buffer.concat([Buffer.from([0x05]), keyBuf, lenBuf, Buffer.from([0x00]), val]);
    }

    if (typeof val === 'string') {
      const strBuf = Buffer.from(val, 'utf-8');
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeInt32LE(strBuf.length + 1, 0); // includes trailing \0
      return Buffer.concat([Buffer.from([0x02]), keyBuf, lenBuf, strBuf, Buffer.from([0x00])]);
    }

    if (typeof val === 'number') {
      if (Number.isInteger(val) && val >= -2147483648 && val <= 2147483647) {
        // Int32
        const numBuf = Buffer.allocUnsafe(4);
        numBuf.writeInt32LE(val, 0);
        return Buffer.concat([Buffer.from([0x10]), keyBuf, numBuf]);
      } else {
        // Double
        const numBuf = Buffer.allocUnsafe(8);
        numBuf.writeDoubleLE(val, 0);
        return Buffer.concat([Buffer.from([0x01]), keyBuf, numBuf]);
      }
    }

    if (typeof val === 'bigint') {
      // Int64
      const numBuf = Buffer.allocUnsafe(8);
      numBuf.writeBigInt64LE(val, 0);
      return Buffer.concat([Buffer.from([0x12]), keyBuf, numBuf]);
    }

    if (typeof val === 'boolean') {
      return Buffer.concat([Buffer.from([0x08]), keyBuf, Buffer.from([val ? 0x01 : 0x00])]);
    }

    if (val instanceof Date) {
      // UTC datetime
      const dateBuf = Buffer.allocUnsafe(8);
      dateBuf.writeBigInt64LE(BigInt(val.getTime()), 0);
      return Buffer.concat([Buffer.from([0x09]), keyBuf, dateBuf]);
    }

    if (Array.isArray(val)) {
      const arrDoc: Record<string, any> = {};
      for (let i = 0; i < val.length; i++) {
        arrDoc[i.toString()] = val[i];
      }
      const subDoc = BsonCodec.encode(arrDoc);
      return Buffer.concat([Buffer.from([0x04]), keyBuf, subDoc]);
    }

    if (typeof val === 'object') {
      const subDoc = BsonCodec.encode(val);
      return Buffer.concat([Buffer.from([0x03]), keyBuf, subDoc]);
    }

    throw new Error(`Unsupported BSON type for field "${key}": ${typeof val}`);
  }
}
