import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { RespParser } from '../resp-parser.ts';
import { ClusterCoordinator } from './cluster-coordinator.ts';
import type { ClusterCoordinatorOptions } from './cluster-coordinator.ts';
import { TelemetryServer } from '../telemetry/telemetry-server.ts';

export interface ClusterServerOptions extends ClusterCoordinatorOptions {
  host?: string;
  port?: number;
  telemetryEnabled?: boolean;
  telemetryPort?: number;
}

/**
 * Multi-core Horizontally Scaled TCP Server.
 * Coordinates incoming client traffic across multiple worker_threads shards
 * using a Consistent Hash Ring and atomic lock primitives.
 */
export class ClusterServer extends EventEmitter {
  public readonly coordinator: ClusterCoordinator;
  public readonly telemetry?: TelemetryServer;
  private readonly server: net.Server;
  private readonly host: string;
  private readonly port: number;
  private readonly sockets: Set<net.Socket> = new Set();

  constructor(options: ClusterServerOptions = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 6379;
    this.coordinator = new ClusterCoordinator(options);

    if (options.telemetryEnabled) {
      this.telemetry = new TelemetryServer({
        port: options.telemetryPort ?? 3000,
        coordinator: this.coordinator,
        tcpPort: this.port,
      });
    }

    this.server = net.createServer((socket) => this.handleClient(socket));
  }

  public async start(): Promise<{ host: string; port: number; telemetryPort?: number }> {
    await this.coordinator.init();

    if (this.telemetry) {
      await this.telemetry.start();
    }

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address() as net.AddressInfo;
        resolve({
          host: addr.address,
          port: addr.port,
          telemetryPort: this.telemetry ? 3000 : undefined,
        });
      });
      this.server.once('error', reject);
    });
  }

  private handleClient(socket: net.Socket): void {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    if (this.telemetry) {
      this.telemetry.collector.setConnectedSockets(this.sockets.size);
    }

    socket.on('close', () => {
      this.sockets.delete(socket);
      if (this.telemetry) {
        this.telemetry.collector.setConnectedSockets(this.sockets.size);
      }
    });

    const parser = new RespParser();
    let processingQueue: Promise<void> = Promise.resolve();

    socket.on('data', (chunk: Buffer) => {
      processingQueue = processingQueue.then(async () => {
        const parsedValues = parser.execute(chunk);
        for (const val of parsedValues) {
          const t0 = process.hrtime.bigint();
          const result = await this.coordinator.execute(val);
          const t1 = process.hrtime.bigint();

          if (this.telemetry) {
            let cmdName = 'UNKNOWN';
            if (val.type === 'array' && val.value && val.value.length > 0 && val.value[0].type === 'bulk_string' && val.value[0].value) {
              const b = Buffer.isBuffer(val.value[0].value) ? val.value[0].value : Buffer.from(val.value[0].value);
              cmdName = b.toString('utf-8').toUpperCase();
            }
            const isRead = ['GET', 'TTL'].includes(cmdName);
            const respStr = result.response.toString('utf-8');
            const isHit = isRead ? !respStr.startsWith('$-1') && !respStr.startsWith(':-2') : undefined;
            this.telemetry.collector.recordCommand(cmdName, Number(t1 - t0), isHit);
          }

          socket.write(result.response);
          if (result.shouldClose) {
            socket.end();
            break;
          }
        }
      }).catch((err) => {
        console.error('[ClusterServer] Client processing error:', err);
        socket.destroy();
      });
    });

    socket.on('error', () => {
      socket.destroy();
    });
  }

  public async stop(): Promise<void> {
    if (this.telemetry) {
      await this.telemetry.stop();
    }

    return new Promise((resolve) => {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();

      this.server.close(async () => {
        await this.coordinator.close();
        resolve();
      });
    });
  }
}
