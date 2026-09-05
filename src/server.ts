import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { AofLogger } from './aof-logger.ts';
import { AofRecovery } from './aof-recovery.ts';
import type { AofRecoveryResult } from './aof-recovery.ts';
import { Connection } from './connection.ts';
import { StorageEngine } from './storage-engine.ts';
import type { ServerOptions } from './types.ts';

export interface ServerMetrics {
  totalConnectionsAccepted: number;
  activeConnections: number;
}

/**
 * Production-grade TCP Server for RESP protocol communications.
 * Manages connection pooling, lifecycle, metrics, and clean graceful shutdowns.
 */
export class RespServer extends EventEmitter {
  private readonly options: ServerOptions;
  private readonly server: net.Server;
  private readonly storageEngine: StorageEngine;
  private aofLogger: AofLogger | null = null;
  private readonly connections: Set<Connection> = new Set();
  private isShuttingDown: boolean = false;
  private totalConnectionsAccepted: number = 0;

  constructor(options: ServerOptions = {}) {
    super();
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 6379,
      maxConnections: options.maxConnections ?? 10000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5000,
      ...options,
    };

    this.storageEngine = new StorageEngine(this.options);
    this.server = net.createServer((socket: net.Socket) => this.handleNewConnection(socket));
    this.server.maxConnections = this.options.maxConnections!;

    this.server.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.server.on('close', () => {
      this.emit('close');
    });
  }

  /**
   * Access underlying StorageEngine instance.
   */
  public get storage(): StorageEngine {
    return this.storageEngine;
  }

  /**
   * Access underlying AofLogger instance if configured.
   */
  public get aof(): AofLogger | null {
    return this.aofLogger;
  }

  /**
   * Starts server:
   * 1. Replays AOF log to restore in-memory state before opening TCP port.
   * 2. Initializes AOF logger for incoming client mutations.
   * 3. Starts listening for incoming client connections.
   */
  public async start(): Promise<{ host: string; port: number; recovery?: AofRecoveryResult }> {
    let recovery: AofRecoveryResult | undefined;

    if (this.options.aofPath) {
      recovery = await AofRecovery.restore(this.options.aofPath, this.storageEngine);
      this.aofLogger = new AofLogger({
        filePath: this.options.aofPath,
        fsyncPolicy: this.options.fsyncPolicy ?? 'everysec',
      });
      await this.aofLogger.init();
    }

    return new Promise((resolve, reject) => {
      const onListening = () => {
        const addr = this.server.address();
        let port = this.options.port!;
        let host = this.options.host!;

        if (addr && typeof addr === 'object') {
          port = addr.port;
          host = addr.address;
        }

        this.emit('listening', { host, port, recovery });
        resolve({ host, port, recovery });
      };

      const onError = (err: Error) => {
        reject(err);
      };

      this.server.once('error', onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.removeListener('error', onError);
        onListening();
      });
    });
  }

  /**
   * Handles an incoming net.Socket connection.
   */
  private handleNewConnection(socket: net.Socket): void {
    if (this.isShuttingDown) {
      socket.destroy();
      return;
    }

    this.totalConnectionsAccepted++;
    const connection = new Connection(
      socket,
      this.storageEngine,
      this.aofLogger ?? undefined,
      this.options
    );
    this.connections.add(connection);

    this.emit('connection', connection);

    connection.on('close', () => {
      this.connections.delete(connection);
    });

    connection.on('protocolError', (details) => {
      this.emit('protocolError', details);
    });
  }

  /**
   * Retrieves current server metrics.
   */
  public getMetrics(): ServerMetrics {
    return {
      totalConnectionsAccepted: this.totalConnectionsAccepted,
      activeConnections: this.connections.size,
    };
  }

  /**
   * Initiates graceful shutdown:
   * 1. Stops background active TTL sweep timer.
   * 2. Stops accepting new connections and gracefully closes active sockets.
   * 3. Flushes and syncs AOF logger to disk.
   */
  public async stop(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    // Stop background TTL timer
    this.storageEngine.stopTtlSweep();

    // Flush and close AOF
    if (this.aofLogger) {
      await this.aofLogger.close();
      this.aofLogger = null;
    }

    return new Promise((resolve) => {
      const shutdownTimer = setTimeout(() => {
        // Force-kill any lingering connections
        for (const conn of this.connections) {
          conn.destroy();
        }
        this.connections.clear();
      }, this.options.shutdownTimeoutMs);

      // Prevent timer from keeping Node process alive if everything else closed
      shutdownTimer.unref();

      // Gracefully close active connections
      for (const conn of this.connections) {
        conn.gracefulClose();
      }

      this.server.close(() => {
        clearTimeout(shutdownTimer);
        resolve();
      });

      // If already zero active connections and server closed
      if (this.connections.size === 0) {
        clearTimeout(shutdownTimer);
        resolve();
      }
    });
  }
}
