import { ProtocolError } from './types.ts';

export interface ByteBufferOptions {
  initialCapacity?: number;
  maxCapacity?: number;
}

/**
 * High-performance, resizable byte buffer designed for streaming protocol framing.
 * Eliminates O(N^2) buffer concatenations by using read/write pointers and in-place
 * buffer compaction.
 */
export class StreamByteBuffer {
  private buffer: Buffer;
  private readOffset: number = 0;
  private writeOffset: number = 0;
  private readonly maxCapacity: number;

  constructor(options: ByteBufferOptions = {}) {
    const initialCapacity = options.initialCapacity ?? 64 * 1024; // 64 KB default
    this.maxCapacity = options.maxCapacity ?? 128 * 1024 * 1024;  // 128 MB default

    if (initialCapacity <= 0 || initialCapacity > this.maxCapacity) {
      throw new Error(`Invalid initial capacity: ${initialCapacity}. Max is ${this.maxCapacity}`);
    }

    this.buffer = Buffer.allocUnsafe(initialCapacity);
  }

  /**
   * Number of unread bytes available in the buffer.
   */
  public get readableBytes(): number {
    return this.writeOffset - this.readOffset;
  }

  /**
   * Total allocated capacity of the underlying buffer.
   */
  public get capacity(): number {
    return this.buffer.length;
  }

  /**
   * Appends an incoming chunk to the buffer, automatically compacting or
   * resizing up to maxCapacity as necessary.
   */
  public append(chunk: Buffer): void {
    if (chunk.length === 0) return;

    const neededSpace = chunk.length;
    const availableAtTail = this.buffer.length - this.writeOffset;

    if (availableAtTail < neededSpace) {
      const currentReadable = this.readableBytes;
      const totalNeeded = currentReadable + neededSpace;

      if (totalNeeded > this.maxCapacity) {
        throw new ProtocolError(
          `Buffer capacity limit exceeded: required ${totalNeeded} bytes, max capacity is ${this.maxCapacity} bytes`,
          'ERR_BUFFER_OVERFLOW'
        );
      }

      // If compaction alone frees sufficient space and avoids re-allocation
      if (this.buffer.length >= totalNeeded && this.readOffset > 0) {
        this.compact();
      } else {
        // Grow buffer exponentially (2x) or to totalNeeded, whichever is larger
        let newCapacity = Math.max(this.buffer.length * 2, totalNeeded);
        if (newCapacity > this.maxCapacity) {
          newCapacity = this.maxCapacity;
        }

        const newBuffer = Buffer.allocUnsafe(newCapacity);
        if (currentReadable > 0) {
          this.buffer.copy(newBuffer, 0, this.readOffset, this.writeOffset);
        }
        this.buffer = newBuffer;
        this.readOffset = 0;
        this.writeOffset = currentReadable;
      }
    }

    chunk.copy(this.buffer, this.writeOffset);
    this.writeOffset += chunk.length;
  }

  /**
   * Returns the byte at the current read offset without advancing the pointer.
   * Returns -1 if no bytes are readable.
   */
  public peekByte(): number {
    if (this.readOffset >= this.writeOffset) {
      return -1;
    }
    return this.buffer[this.readOffset];
  }

  /**
   * Returns the byte at a specific offset relative to readOffset without advancing.
   * Returns -1 if offset is out of bounds.
   */
  public peekByteAt(offset: number): number {
    const target = this.readOffset + offset;
    if (target < this.readOffset || target >= this.writeOffset) {
      return -1;
    }
    return this.buffer[target];
  }

  /**
   * Reads a single byte and advances the read pointer by 1.
   * Returns -1 if no bytes are readable.
   */
  public readByte(): number {
    if (this.readOffset >= this.writeOffset) {
      return -1;
    }
    const val = this.buffer[this.readOffset];
    this.readOffset++;
    this.checkAutoReset();
    return val;
  }

  /**
   * Searches for the CRLF sequence (\r\n, 0x0D 0x0A) within the unread window.
   * Scans up to maxSearchLength bytes.
   *
   * @param maxSearchLength Maximum bytes to scan from current read offset.
   * @returns Absolute index in internal buffer of \r, or -1 if CRLF not found.
   */
  public findCrlf(maxSearchLength: number = Infinity): number {
    const end = Math.min(this.writeOffset, this.readOffset + maxSearchLength);
    // Need at least 2 bytes for \r\n
    for (let i = this.readOffset; i < end - 1; i++) {
      if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Reads a string between current readOffset and the specified crlfIndex (exclusive of \r\n),
   * then advances the read pointer past the \r\n (crlfIndex + 2).
   */
  public readLineAtCrlf(crlfIndex: number, encoding: BufferEncoding = 'utf-8'): string {
    if (crlfIndex < this.readOffset || crlfIndex + 1 >= this.writeOffset) {
      throw new Error(`CRLF index ${crlfIndex} out of valid bounds [${this.readOffset}, ${this.writeOffset})`);
    }

    const str = this.buffer.toString(encoding, this.readOffset, crlfIndex);
    this.readOffset = crlfIndex + 2;
    this.checkAutoReset();
    return str;
  }

  /**
   * Reads a fixed number of bytes into a newly allocated Buffer copy,
   * advancing the read offset.
   */
  public readBytes(length: number): Buffer {
    if (length < 0) {
      throw new Error(`Invalid length to read: ${length}`);
    }
    if (this.readableBytes < length) {
      throw new Error(`Cannot read ${length} bytes: only ${this.readableBytes} readable`);
    }

    const result = Buffer.allocUnsafe(length);
    this.buffer.copy(result, 0, this.readOffset, this.readOffset + length);
    this.readOffset += length;
    this.checkAutoReset();
    return result;
  }

  /**
   * Advances the read pointer by the given length.
   */
  public advance(length: number): void {
    if (length < 0 || this.readOffset + length > this.writeOffset) {
      throw new Error(`Cannot advance ${length} bytes: only ${this.readableBytes} available`);
    }
    this.readOffset += length;
    this.checkAutoReset();
  }

  /**
   * Compacts the buffer by sliding unread bytes to the beginning of the buffer.
   */
  public compact(): void {
    const currentReadable = this.readableBytes;
    if (currentReadable === 0) {
      this.readOffset = 0;
      this.writeOffset = 0;
      return;
    }

    if (this.readOffset > 0) {
      this.buffer.copy(this.buffer, 0, this.readOffset, this.writeOffset);
      this.readOffset = 0;
      this.writeOffset = currentReadable;
    }
  }

  /**
   * Clears all buffer data and resets offsets.
   */
  public clear(): void {
    this.readOffset = 0;
    this.writeOffset = 0;
  }

  /**
   * Automatically resets read and write offsets to 0 if buffer is completely consumed,
   * avoiding future compaction overhead.
   */
  private checkAutoReset(): void {
    if (this.readOffset === this.writeOffset) {
      this.readOffset = 0;
      this.writeOffset = 0;
    }
  }
}
