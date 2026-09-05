import type { RespValue } from './types.ts';

// Pre-allocated static buffers for zero-allocation hot paths
export const STATIC_RESP = {
  PONG: Buffer.from('+PONG\r\n', 'utf-8'),
  OK: Buffer.from('+OK\r\n', 'utf-8'),
  NULL_BULK_STRING: Buffer.from('$-1\r\n', 'utf-8'),
  NULL_ARRAY: Buffer.from('*-1\r\n', 'utf-8'),
  EMPTY_ARRAY: Buffer.from('*0\r\n', 'utf-8'),
  CRLF: Buffer.from('\r\n', 'utf-8'),
} as const;

/**
 * Serializes data structures into RESP byte buffers.
 */
export class RespSerializer {
  /**
   * Serializes a Simple String (+<value>\r\n)
   */
  public static simpleString(value: string): Buffer {
    if (value === 'OK') return STATIC_RESP.OK;
    if (value === 'PONG') return STATIC_RESP.PONG;
    return Buffer.from(`+${value}\r\n`, 'utf-8');
  }

  /**
   * Serializes a Simple Error (-<value>\r\n)
   */
  public static error(message: string, prefix: string = 'ERR'): Buffer {
    return Buffer.from(`-${prefix} ${message}\r\n`, 'utf-8');
  }

  /**
   * Serializes a raw protocol error line (-<raw>\r\n)
   */
  public static rawError(rawErrorMessage: string): Buffer {
    return Buffer.from(`-${rawErrorMessage}\r\n`, 'utf-8');
  }

  /**
   * Serializes an Integer (:<value>\r\n)
   */
  public static integer(value: number | bigint): Buffer {
    return Buffer.from(`:${value.toString()}\r\n`, 'utf-8');
  }

  /**
   * Serializes a Bulk String ($<len>\r\n<data>\r\n or $-1\r\n)
   */
  public static bulkString(value: Buffer | string | null): Buffer {
    if (value === null) {
      return STATIC_RESP.NULL_BULK_STRING;
    }

    const payload = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value;
    const header = Buffer.from(`$${payload.length}\r\n`, 'utf-8');

    return Buffer.concat([header, payload, STATIC_RESP.CRLF]);
  }

  /**
   * Serializes an Array (*<count>\r\n<element 1>...<element N>)
   */
  public static array(elements: RespValue[] | null): Buffer {
    if (elements === null) {
      return STATIC_RESP.NULL_ARRAY;
    }
    if (elements.length === 0) {
      return STATIC_RESP.EMPTY_ARRAY;
    }

    const chunks: Buffer[] = [Buffer.from(`*${elements.length}\r\n`, 'utf-8')];
    for (const elem of elements) {
      chunks.push(RespSerializer.serialize(elem));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Serializes any RespValue into its RESP wire format representation.
   */
  public static serialize(value: RespValue): Buffer {
    switch (value.type) {
      case 'simple_string':
        return RespSerializer.simpleString(value.value);
      case 'error':
        return RespSerializer.rawError(value.value);
      case 'integer':
        return RespSerializer.integer(value.value);
      case 'bulk_string':
        return RespSerializer.bulkString(value.value);
      case 'array':
        return RespSerializer.array(value.value);
    }
  }
}
