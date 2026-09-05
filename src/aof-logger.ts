import * as fs from 'node:fs/promises';
import { RespSerializer } from './resp-serializer.ts';

export type FsyncPolicy = 'always' | 'everysec' | 'no';

export interface AofLoggerOptions {
  filePath: string;
  fsyncPolicy?: FsyncPolicy;
  /** Background sync interval for 'everysec' policy in ms. Default: 1000 */
  syncIntervalMs?: number;
}

/**
 * Production-grade Append-Only File (AOF) logger.
 * Features:
 * - RESP array wire format for seamless binary compatibility with Redis standard.
 * - Non-blocking I/O using vector writes (writev) for write coalescing.
 * - Configurable fsync policies: 'always', 'everysec', 'no'.
 * - Clean shutdown flush guarantees.
 */
export class AofLogger {
  public readonly filePath: string;
  public readonly fsyncPolicy: FsyncPolicy;

  private fileHandle: fs.FileHandle | null = null;
  private writeQueue: Buffer[] = [];
  private isFlushing: boolean = false;
  private dirtyBytes: number = 0;
  private syncTimer: NodeJS.Timeout | null = null;
  private isClosed: boolean = false;

  constructor(options: AofLoggerOptions) {
    this.filePath = options.filePath;
    this.fsyncPolicy = options.fsyncPolicy ?? 'everysec';

    if (this.fsyncPolicy === 'everysec') {
      const interval = options.syncIntervalMs ?? 1000;
      this.syncTimer = setInterval(() => {
        this.syncEverySec().catch((err) => {
          console.error(`[AofLogger] Background fsync error:`, err);
        });
      }, interval);
      this.syncTimer.unref();
    }
  }

  /**
   * Initializes and opens the AOF file handle in append mode.
   */
  public async init(): Promise<void> {
    if (!this.fileHandle) {
      this.fileHandle = await fs.open(this.filePath, 'a+');
    }
  }

  /**
   * Logs a SET mutation to AOF.
   */
  public logSet(key: string, value: Buffer, exSeconds?: number): Promise<void> {
    const keyBuf = Buffer.from(key, 'utf-8');
    let serialized: Buffer;

    if (exSeconds && exSeconds > 0) {
      // *5\r\n$3\r\nSET\r\n$<klen>\r\n<key>\r\n$<vlen>\r\n<value>\r\n$2\r\nEX\r\n$<exlen>\r\n<ex>\r\n
      const exBuf = Buffer.from(exSeconds.toString(), 'utf-8');
      serialized = Buffer.concat([
        Buffer.from(`*5\r\n$3\r\nSET\r\n$${keyBuf.length}\r\n`, 'utf-8'),
        keyBuf,
        Buffer.from(`\r\n$${value.length}\r\n`, 'utf-8'),
        value,
        Buffer.from(`\r\n$2\r\nEX\r\n$${exBuf.length}\r\n`, 'utf-8'),
        exBuf,
        Buffer.from('\r\n', 'utf-8'),
      ]);
    } else {
      // *3\r\n$3\r\nSET\r\n$<klen>\r\n<key>\r\n$<vlen>\r\n<value>\r\n
      serialized = Buffer.concat([
        Buffer.from(`*3\r\n$3\r\nSET\r\n$${keyBuf.length}\r\n`, 'utf-8'),
        keyBuf,
        Buffer.from(`\r\n$${value.length}\r\n`, 'utf-8'),
        value,
        Buffer.from('\r\n', 'utf-8'),
      ]);
    }

    return this.enqueueWrite(serialized);
  }

  /**
   * Logs a DEL mutation to AOF.
   */
  public logDel(keys: string[]): Promise<void> {
    if (keys.length === 0) return Promise.resolve();

    const parts: Buffer[] = [
      Buffer.from(`*${keys.length + 1}\r\n$3\r\nDEL\r\n`, 'utf-8'),
    ];

    for (const key of keys) {
      const keyBuf = Buffer.from(key, 'utf-8');
      parts.push(Buffer.from(`$${keyBuf.length}\r\n`, 'utf-8'), keyBuf, Buffer.from('\r\n', 'utf-8'));
    }

    const serialized = Buffer.concat(parts);
    return this.enqueueWrite(serialized);
  }

  /**
   * Logs an INCR mutation to AOF.
   */
  public logIncr(key: string): Promise<void> {
    const keyBuf = Buffer.from(key, 'utf-8');
    const serialized = Buffer.concat([
      Buffer.from(`*2\r\n$4\r\nINCR\r\n$${keyBuf.length}\r\n`, 'utf-8'),
      keyBuf,
      Buffer.from('\r\n', 'utf-8'),
    ]);
    return this.enqueueWrite(serialized);
  }

  /**
   * Enqueues serialized RESP buffer for vector write to disk.
   */
  private async enqueueWrite(buffer: Buffer): Promise<void> {
    if (this.isClosed) {
      throw new Error('AofLogger is closed');
    }

    if (!this.fileHandle) {
      await this.init();
    }

    this.writeQueue.push(buffer);
    this.dirtyBytes += buffer.length;

    if (!this.isFlushing) {
      await this.flushQueue();
    }
  }

  /**
   * Flushes currently queued writes using non-blocking writev and applies fsync policy.
   */
  private async flushQueue(): Promise<void> {
    if (this.isFlushing || this.writeQueue.length === 0 || !this.fileHandle) {
      return;
    }

    this.isFlushing = true;

    try {
      while (this.writeQueue.length > 0) {
        // Drain current batch into a local array to allow vector write
        const batch = this.writeQueue;
        this.writeQueue = [];

        // Efficient vector write to OS page cache
        await this.fileHandle.writev(batch);

        if (this.fsyncPolicy === 'always') {
          // Immediately flush to physical disk
          await this.fileHandle.datasync();
          this.dirtyBytes = 0;
        }
      }
    } finally {
      this.isFlushing = false;
      // If new writes arrived while we were writing
      if (this.writeQueue.length > 0) {
        setImmediate(() => {
          this.flushQueue().catch((err) => {
            console.error(`[AofLogger] Error in cascaded flushQueue:`, err);
          });
        });
      }
    }
  }

  /**
   * Background tick for 'everysec' policy.
   */
  private async syncEverySec(): Promise<void> {
    if (this.dirtyBytes > 0 && this.fileHandle && !this.isClosed) {
      try {
        await this.fileHandle.datasync();
        this.dirtyBytes = 0;
      } catch (err) {
        console.error(`[AofLogger] datasync failed:`, err);
      }
    }
  }

  /**
   * Explicitly synchronizes unwritten data to disk.
   */
  public async sync(): Promise<void> {
    if (!this.fileHandle) return;
    await this.flushQueue();
    await this.fileHandle.datasync();
    this.dirtyBytes = 0;
  }

  /**
   * Flushes all pending writes, synchronizes to disk, and closes the file handle.
   */
  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.fileHandle) {
      await this.flushQueue();
      await this.fileHandle.datasync();
      await this.fileHandle.close();
      this.fileHandle = null;
    }
  }
}
