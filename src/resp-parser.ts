import { EventEmitter } from 'node:events';
import { StreamByteBuffer } from './byte-buffer.ts';
import { ProtocolError, RespTypePrefix } from './types.ts';
import type {
  ParserOptions,
  RespArray,
  RespBulkString,
  RespError,
  RespInteger,
  RespSimpleString,
  RespValue,
} from './types.ts';

interface ArrayStackFrame {
  count: number;
  items: RespValue[];
}

const INTEGER_REGEX = /^[+-]?[0-9]+$/;

/**
 * Production-grade streaming RESP parser.
 * Handles TCP packet fragmentation, pipelining, and edge framing conditions
 * with constant O(1) state transitions and zero O(N^2) memory copying.
 */
export class RespParser extends EventEmitter {
  private readonly buffer: StreamByteBuffer;
  private readonly maxInlineLength: number;
  private readonly maxBulkLength: number;
  private readonly maxArrayDepth: number;

  private arrayStack: ArrayStackFrame[] = [];
  private pendingBulkLength: number | null = null;
  private totalBytesProcessed: number = 0;
  private lastCompletedOffset: number = 0;

  constructor(options: ParserOptions = {}) {
    super();
    this.maxInlineLength = options.maxInlineLength ?? 64 * 1024;      // 64 KB
    this.maxBulkLength = options.maxBulkLength ?? 64 * 1024 * 1024;   // 64 MB
    this.maxArrayDepth = options.maxArrayDepth ?? 16;                 // 16 levels

    this.buffer = new StreamByteBuffer({
      initialCapacity: options.initialBufferSize ?? 64 * 1024,
      maxCapacity: options.maxBufferSize ?? 128 * 1024 * 1024,
    });
  }

  /**
   * Resets the internal state of the parser and clears the buffer.
   */
  public reset(): void {
    this.buffer.clear();
    this.arrayStack = [];
    this.pendingBulkLength = null;
    this.totalBytesProcessed = 0;
    this.lastCompletedOffset = 0;
  }

  /**
   * Number of unconsumed/unparsed bytes currently buffered.
   */
  public get unparsedBytes(): number {
    return this.buffer.readableBytes;
  }

  /**
   * Byte offset up to which all top-level frames are fully valid and completed.
   */
  public get lastValidOffset(): number {
    return this.lastCompletedOffset;
  }

  public get totalProcessed(): number {
    return this.totalBytesProcessed;
  }

  public get isIncomplete(): boolean {
    return this.arrayStack.length > 0 || this.pendingBulkLength !== null || this.buffer.readableBytes > 0;
  }

  private emitCompleted(completed: RespValue, results: RespValue[]): void {
    results.push(completed);
    this.lastCompletedOffset = this.totalBytesProcessed - this.buffer.readableBytes;
    this.emit('value', completed);
  }

  /**
   * Feeds an incoming TCP chunk into the parser and yields all completely parsed RESP values.
   *
   * @param chunk Incoming TCP data buffer.
   * @returns Array of parsed complete RespValue instances.
   */
  public execute(chunk?: Buffer): RespValue[] {
    if (chunk && chunk.length > 0) {
      this.totalBytesProcessed += chunk.length;
      this.buffer.append(chunk);
    }

    const results: RespValue[] = [];

    while (this.buffer.readableBytes > 0) {
      // 1. If waiting for bulk string payload
      if (this.pendingBulkLength !== null) {
        const requiredBytes = this.pendingBulkLength + 2; // Payload + CRLF
        if (this.buffer.readableBytes < requiredBytes) {
          // Waiting for more chunk data
          break;
        }

        // Verify trailing CRLF
        const cr = this.buffer.peekByteAt(this.pendingBulkLength);
        const lf = this.buffer.peekByteAt(this.pendingBulkLength + 1);
        if (cr !== 0x0d || lf !== 0x0a) {
          throw new ProtocolError(
            `Malformed bulk string: missing CRLF terminator (got 0x${cr?.toString(16)} 0x${lf?.toString(16)})`,
            'ERR_MALFORMED_BULK_TERMINATOR'
          );
        }

        // Read payload bytes
        const payload = this.buffer.readBytes(this.pendingBulkLength);
        // Consume \r\n
        this.buffer.advance(2);

        this.pendingBulkLength = null;

        const val: RespBulkString = {
          type: 'bulk_string',
          value: payload,
        };

        const completed = this.completeValue(val);
        if (completed !== null) {
          this.emitCompleted(completed, results);
        }
        continue;
      }

      // 2. We need to read an inline header line (up to CRLF)
      const crlfIndex = this.buffer.findCrlf(this.maxInlineLength);
      if (crlfIndex === -1) {
        // Did we exceed the maximum allowed inline header size without a CRLF?
        if (this.buffer.readableBytes > this.maxInlineLength) {
          throw new ProtocolError(
            `Inline header exceeds maximum allowable limit (${this.maxInlineLength} bytes)`,
            'ERR_HEADER_TOO_LONG'
          );
        }
        // Incomplete line, wait for next TCP chunk
        break;
      }

      // Read the header line up to \r\n and advance past CRLF
      const line = this.buffer.readLineAtCrlf(crlfIndex, 'utf-8');
      if (line.length === 0) {
        throw new ProtocolError('Empty header line received', 'ERR_EMPTY_LINE');
      }

      const prefix = line.charCodeAt(0);
      const payload = line.slice(1);

      switch (prefix) {
        case RespTypePrefix.SIMPLE_STRING: {
          const val: RespSimpleString = {
            type: 'simple_string',
            value: payload,
          };
          const completed = this.completeValue(val);
          if (completed !== null) {
            this.emitCompleted(completed, results);
          }
          break;
        }

        case RespTypePrefix.ERROR: {
          const val: RespError = {
            type: 'error',
            value: payload,
          };
          const completed = this.completeValue(val);
          if (completed !== null) {
            this.emitCompleted(completed, results);
          }
          break;
        }

        case RespTypePrefix.INTEGER: {
          const intVal = this.parseInteger(payload);
          const val: RespInteger = {
            type: 'integer',
            value: intVal,
          };
          const completed = this.completeValue(val);
          if (completed !== null) {
            this.emitCompleted(completed, results);
          }
          break;
        }

        case RespTypePrefix.BULK_STRING: {
          const length = Number(this.parseInteger(payload));
          if (length === -1) {
            // Null Bulk String: $-1\r\n
            const val: RespBulkString = {
              type: 'bulk_string',
              value: null,
            };
            const completed = this.completeValue(val);
            if (completed !== null) {
              this.emitCompleted(completed, results);
            }
          } else if (length < -1) {
            throw new ProtocolError(`Invalid bulk string length: ${length}`, 'ERR_INVALID_BULK_LENGTH');
          } else if (length > this.maxBulkLength) {
            throw new ProtocolError(
              `Bulk string length ${length} exceeds maximum limit of ${this.maxBulkLength} bytes`,
              'ERR_BULK_TOO_LARGE'
            );
          } else {
            // Bulk string has payload; set state and continue parsing in next loop iteration
            this.pendingBulkLength = length;
          }
          break;
        }

        case RespTypePrefix.ARRAY: {
          const count = Number(this.parseInteger(payload));
          if (count === -1) {
            // Null Array: *-1\r\n
            const val: RespArray = {
              type: 'array',
              value: null,
            };
            const completed = this.completeValue(val);
            if (completed !== null) {
              this.emitCompleted(completed, results);
            }
          } else if (count < -1) {
            throw new ProtocolError(`Invalid array count: ${count}`, 'ERR_INVALID_ARRAY_COUNT');
          } else if (count === 0) {
            // Empty Array: *0\r\n
            const val: RespArray = {
              type: 'array',
              value: [],
            };
            const completed = this.completeValue(val);
            if (completed !== null) {
              this.emitCompleted(completed, results);
            }
          } else {
            if (this.arrayStack.length >= this.maxArrayDepth) {
              throw new ProtocolError(
                `Maximum array nesting depth of ${this.maxArrayDepth} exceeded`,
                'ERR_NESTING_DEPTH_EXCEEDED'
              );
            }
            this.arrayStack.push({
              count,
              items: [],
            });
          }
          break;
        }

        default: {
          throw new ProtocolError(
            `Unexpected RESP type prefix byte: 0x${prefix.toString(16)} ('${String.fromCharCode(prefix)}')`,
            'ERR_UNKNOWN_PREFIX'
          );
        }
      }
    }

    return results;
  }

  /**
   * Completes a parsed value by adding it to current array frame or returning top-level value.
   */
  private completeValue(val: RespValue): RespValue | null {
    if (this.arrayStack.length > 0) {
      const top = this.arrayStack[this.arrayStack.length - 1];
      top.items.push(val);

      if (top.items.length === top.count) {
        this.arrayStack.pop();
        const completedArray: RespArray = {
          type: 'array',
          value: top.items,
        };
        // Bubble up recursively in case this completes an enclosing array
        return this.completeValue(completedArray);
      }
      return null;
    }

    return val;
  }

  /**
   * Strict integer validation and parsing.
   */
  private parseInteger(payload: string): bigint {
    if (!INTEGER_REGEX.test(payload)) {
      throw new ProtocolError(`Invalid integer format: "${payload}"`, 'ERR_INVALID_INTEGER');
    }

    try {
      return BigInt(payload);
    } catch {
      throw new ProtocolError(`Integer overflow or parsing failure: "${payload}"`, 'ERR_INTEGER_OVERFLOW');
    }
  }
}
