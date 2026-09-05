import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { AofLogger } from './aof-logger.ts';
import { CommandHandler } from './command-handler.ts';
import { RespParser } from './resp-parser.ts';
import { RespSerializer } from './resp-serializer.ts';
import { StorageEngine } from './storage-engine.ts';
import { ProtocolError } from './types.ts';
import type { ServerOptions } from './types.ts';

let connectionIdCounter = 0;

/**
 * Manages an individual TCP client connection lifecycle, streaming RESP parsing,
 * backpressure flow control, and graceful teardown.
 */
export class Connection extends EventEmitter {
  public readonly id: number;
  public readonly socket: net.Socket;
  public readonly remoteAddress: string;
  public readonly remotePort: number;

  private readonly engine: StorageEngine;
  private readonly aof?: AofLogger;
  private readonly parser: RespParser;
  private isClosing: boolean = false;
  private isDestroyed: boolean = false;
  private isDraining: boolean = false;
  private processingQueue: Promise<void> = Promise.resolve();

  constructor(socket: net.Socket, engine: StorageEngine, aof?: AofLogger, options: ServerOptions = {}) {
    super();
    this.id = ++connectionIdCounter;
    this.socket = socket;
    this.engine = engine;
    this.aof = aof;
    this.remoteAddress = socket.remoteAddress || 'unknown';
    this.remotePort = socket.remotePort || 0;

    // Apply TCP socket options
    if (options.noDelay !== false) {
      socket.setNoDelay(true);
    }
    if (options.keepAlive !== false) {
      socket.setKeepAlive(true, options.keepAliveInitialDelayMs ?? 60000);
    }
    if (options.idleTimeoutMs && options.idleTimeoutMs > 0) {
      socket.setTimeout(options.idleTimeoutMs);
    }

    this.parser = new RespParser(options);

    this.bindSocketEvents();
  }

  private bindSocketEvents(): void {
    this.socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.socket.on('drain', () => this.handleDrain());
    this.socket.on('timeout', () => this.handleTimeout());
    this.socket.on('error', (err: Error) => this.handleSocketError(err));
    this.socket.on('end', () => this.handleEnd());
    this.socket.on('close', (hadError: boolean) => this.handleClose(hadError));
  }

  /**
   * Processes incoming TCP data chunk through the streaming RESP parser.
   * Chained via processingQueue to guarantee strict in-order execution during async AOF fsync.
   */
  private handleData(chunk: Buffer): void {
    if (this.isClosing || this.isDestroyed) return;

    this.processingQueue = this.processingQueue
      .then(() => this.processChunk(chunk))
      .catch((err) => this.handleParsingError(err));
  }

  private async processChunk(chunk: Buffer): Promise<void> {
    if (this.isClosing || this.isDestroyed) return;

    const parsedValues = this.parser.execute(chunk);
    if (parsedValues.length === 0) return;

    const responseBuffers: Buffer[] = [];
    let shouldTerminate = false;

    for (const val of parsedValues) {
      const result = await CommandHandler.execute(val, this.engine, this.aof);
      responseBuffers.push(result.response);

      if (result.shouldClose) {
        shouldTerminate = true;
        break;
      }
    }

    if (responseBuffers.length > 0) {
      const totalPayload = responseBuffers.length === 1
        ? responseBuffers[0]
        : Buffer.concat(responseBuffers);

      this.write(totalPayload);
    }

    if (shouldTerminate) {
      this.gracefulClose();
    }
  }

  /**
   * Writes data to the socket respecting TCP send buffer backpressure.
   */
  private write(data: Buffer): void {
    if (this.isDestroyed || this.socket.destroyed) return;

    const canAcceptMore = this.socket.write(data);
    if (!canAcceptMore && !this.isDraining) {
      // Kernel send buffer full; pause incoming reads until drained
      this.isDraining = true;
      this.socket.pause();
    }
  }

  /**
   * Called when kernel send buffer empties; resumes reading.
   */
  private handleDrain(): void {
    this.isDraining = false;
    if (!this.isClosing && !this.isDestroyed) {
      this.socket.resume();
    }
  }

  /**
   * Handles stream protocol violations by writing error and closing immediately.
   */
  private handleParsingError(err: unknown): void {
    if (this.isClosing || this.isDestroyed) return;

    const message = err instanceof Error ? err.message : 'Unknown protocol error';
    const errorCode = err instanceof ProtocolError ? err.code : 'ERR_PROTOCOL';

    const errorBuffer = RespSerializer.rawError(`ERR Protocol error: ${message}`);

    try {
      this.socket.write(errorBuffer, () => {
        this.destroy();
      });
    } catch {
      this.destroy();
    }

    this.emit('protocolError', {
      connectionId: this.id,
      code: errorCode,
      message,
    });
  }

  /**
   * Handles socket inactivity timeout.
   */
  private handleTimeout(): void {
    this.emit('timeout', this.id);
    this.gracefulClose();
  }

  /**
   * Handles underlying socket errors gracefully.
   */
  private handleSocketError(err: Error): void {
    this.emit('error', err);
    this.destroy();
  }

  /**
   * Client initiated connection teardown (FIN).
   */
  private handleEnd(): void {
    this.gracefulClose();
  }

  /**
   * Socket fully closed.
   */
  private handleClose(hadError: boolean): void {
    this.cleanup();
    this.emit('close', hadError);
  }

  /**
   * Closes the connection gracefully, allowing pending writes to flush.
   */
  public gracefulClose(): void {
    if (this.isClosing || this.isDestroyed) return;
    this.isClosing = true;
    this.socket.end();
  }

  /**
   * Immediately destroys the socket and aborts pending I/O.
   */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.isClosing = true;
    this.socket.destroy();
    this.cleanup();
  }

  private cleanup(): void {
    this.parser.reset();
    this.removeAllListeners();
  }
}
