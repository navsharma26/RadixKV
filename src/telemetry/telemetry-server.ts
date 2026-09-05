import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClusterCoordinator } from '../cluster/cluster-coordinator.ts';
import { TelemetryCollector } from './telemetry-collector.ts';
import { GeminiService } from './gemini-service.ts';

export interface TelemetryServerOptions {
  port?: number;
  host?: string;
  coordinator: ClusterCoordinator;
  tcpPort?: number;
  autoSimulate?: boolean;
}

export class TelemetryServer {
  public readonly app: express.Express;
  public readonly server: http.Server;
  public readonly wss: WebSocketServer;
  public readonly collector: TelemetryCollector;
  public readonly coordinator: ClusterCoordinator;
  public readonly gemini: GeminiService;

  private readonly port: number;
  private readonly host: string;
  private readonly tcpPort: number;
  private readonly autoSimulate: boolean;

  private syntheticTrafficTimer: NodeJS.Timeout | null = null;
  private isSyntheticTrafficRunning: boolean = false;

  constructor(options: TelemetryServerOptions) {
    this.port = options.port ?? 3000;
    this.host = options.host ?? '0.0.0.0';
    this.tcpPort = options.tcpPort ?? 6379;
    this.coordinator = options.coordinator;
    this.autoSimulate = options.autoSimulate ?? true;

    this.collector = new TelemetryCollector({
      coordinator: this.coordinator,
      tickIntervalMs: 1000,
      historyLength: 60,
    });

    this.gemini = new GeminiService();

    this.app = express();
    this.app.use(express.json());

    // CORS headers for development
    this.app.use((_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes(): void {
    // 1. Current metrics & 60s history
    this.app.get('/api/metrics', (_req, res) => {
      res.json({
        current: this.collector.getLatestSnapshot(),
        history: this.collector.getHistory(),
      });
    });

    // 2. Cluster topology & configuration
    this.app.get('/api/cluster-info', async (_req, res) => {
      try {
        const stats = await this.coordinator.getClusterStats();
        res.json({
          shardCount: this.coordinator.shardCount,
          vnodesPerShard: 150,
          tcpPort: this.tcpPort,
          telemetryPort: this.port,
          syntheticTraffic: this.isSyntheticTrafficRunning,
          stats,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // 3. Interactive RESP command execution endpoint
    this.app.post('/api/command', async (req, res) => {
      const { command } = req.body;
      if (!command || typeof command !== 'string') {
        res.status(400).json({ error: 'Command string required' });
        return;
      }

      try {
        const t0 = process.hrtime.bigint();
        const result = await this.coordinator.executeRawCommand(command);
        const t1 = process.hrtime.bigint();
        const durationNs = Number(t1 - t0);

        const isRead = ['GET', 'TTL'].includes(result.commandName);
        const isHit = isRead ? result.formattedOutput !== '(nil)' && result.formattedOutput !== '-2' : undefined;

        this.collector.recordCommand(result.commandName, durationNs, isHit);

        res.json({
          success: true,
          output: result.formattedOutput,
          latencyUs: Math.round(result.latencyUs),
          latencyMs: Number((result.latencyUs / 1000).toFixed(3)),
          commandName: result.commandName,
        });
      } catch (err: any) {
        res.status(500).json({
          success: false,
          error: err.message,
        });
      }
    });

    // 4. Toggle synthetic traffic generation
    this.app.post('/api/synthetic-traffic', (req, res) => {
      const { enabled } = req.body;
      if (enabled) {
        this.startSyntheticTraffic();
      } else {
        this.stopSyntheticTraffic();
      }
      res.json({ syntheticTraffic: this.isSyntheticTrafficRunning });
    });

    // 5. AI Redis Copilot Endpoint
    this.app.post('/api/ai/copilot', async (req, res) => {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'Prompt string is required' });
        return;
      }

      try {
        const result = await this.gemini.translateToRedisCommands(prompt);
        res.json({ success: true, ...result });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // 6. AI Cluster Diagnostics Endpoint
    this.app.post('/api/ai/diagnostics', async (_req, res) => {
      try {
        const snapshot = this.collector.getLatestSnapshot();
        if (!snapshot) {
          res.status(503).json({ success: false, error: 'Telemetry snapshot is initializing. Please retry in 1 second.' });
          return;
        }

        const report = await this.gemini.generateClusterDiagnostics(snapshot, {
          shardCount: this.coordinator.shardCount,
          tcpPort: this.tcpPort,
          telemetryPort: this.port,
          syntheticTraffic: this.isSyntheticTrafficRunning,
        });

        res.json({ success: true, report });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // 7. Static file hosting for compiled React frontend
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const distPath = path.resolve(currentDir, '../../web/dist');

    if (fs.existsSync(distPath)) {
      this.app.use(express.static(distPath));
      this.app.use((_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.collector.incrementConnectedSockets();

      // Send initial state & history immediately
      const initialPayload = {
        type: 'INITIAL_STATE',
        current: this.collector.getLatestSnapshot(),
        history: this.collector.getHistory(),
        tcpPort: this.tcpPort,
        shardCount: this.coordinator.shardCount,
        syntheticTraffic: this.isSyntheticTrafficRunning,
      };
      ws.send(JSON.stringify(initialPayload));

      ws.on('message', async (data: string) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'COMMAND' && typeof parsed.command === 'string') {
            const t0 = process.hrtime.bigint();
            const result = await this.coordinator.executeRawCommand(parsed.command);
            const t1 = process.hrtime.bigint();
            const durationNs = Number(t1 - t0);

            const isRead = ['GET', 'TTL'].includes(result.commandName);
            const isHit = isRead ? result.formattedOutput !== '(nil)' && result.formattedOutput !== '-2' : undefined;

            this.collector.recordCommand(result.commandName, durationNs, isHit);

            ws.send(JSON.stringify({
              type: 'COMMAND_RESULT',
              id: parsed.id,
              output: result.formattedOutput,
              latencyUs: Math.round(result.latencyUs),
              latencyMs: Number((result.latencyUs / 1000).toFixed(3)),
              commandName: result.commandName,
            }));
          }
        } catch (err: any) {
          ws.send(JSON.stringify({
            type: 'COMMAND_ERROR',
            error: err.message,
          }));
        }
      });

      ws.on('close', () => {
        this.collector.decrementConnectedSockets();
      });
    });

    // Broadcast 1-second telemetry ticks to all connected clients
    this.collector.on('snapshot', (snapshot) => {
      const payload = JSON.stringify({
        type: 'TELEMETRY_TICK',
        snapshot,
        syntheticTraffic: this.isSyntheticTrafficRunning,
      });

      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    });
  }

  public startSyntheticTraffic(rateOpsPerSec: number = 800): void {
    if (this.isSyntheticTrafficRunning) return;
    this.isSyntheticTrafficRunning = true;

    let counter = 0;
    const intervalMs = 25; // 40 batches per second
    const batchSize = Math.max(1, Math.floor(rateOpsPerSec / 40));

    this.syntheticTrafficTimer = setInterval(async () => {
      for (let i = 0; i < batchSize; i++) {
        counter++;
        const keyIdx = counter % 250;
        const key = `cache:metric:${keyIdx}`;
        const opType = counter % 10;

        try {
          if (opType < 4) {
            // 40% Writes
            const cmd = `SET ${key} "val_${counter}" EX ${30 + (counter % 60)}`;
            const t0 = process.hrtime.bigint();
            await this.coordinator.executeRawCommand(cmd);
            const t1 = process.hrtime.bigint();
            this.collector.recordCommand('SET', Number(t1 - t0));
          } else if (opType < 8) {
            // 40% Reads
            const cmd = `GET ${key}`;
            const t0 = process.hrtime.bigint();
            const res = await this.coordinator.executeRawCommand(cmd);
            const t1 = process.hrtime.bigint();
            const isHit = res.formattedOutput !== '(nil)';
            this.collector.recordCommand('GET', Number(t1 - t0), isHit);
          } else if (opType === 8) {
            // 10% INCR
            const cmd = `INCR counter:${counter % 50}`;
            const t0 = process.hrtime.bigint();
            await this.coordinator.executeRawCommand(cmd);
            const t1 = process.hrtime.bigint();
            this.collector.recordCommand('INCR', Number(t1 - t0));
          } else {
            // 10% TTL
            const cmd = `TTL ${key}`;
            const t0 = process.hrtime.bigint();
            await this.coordinator.executeRawCommand(cmd);
            const t1 = process.hrtime.bigint();
            this.collector.recordCommand('TTL', Number(t1 - t0));
          }
        } catch {
          // ignore synthetic command errors
        }
      }
    }, intervalMs);
  }

  public stopSyntheticTraffic(): void {
    if (this.syntheticTrafficTimer) {
      clearInterval(this.syntheticTrafficTimer);
      this.syntheticTrafficTimer = null;
    }
    this.isSyntheticTrafficRunning = false;
  }

  public async start(): Promise<{ host: string; port: number }> {
    this.collector.start();
    if (this.autoSimulate) {
      this.startSyntheticTraffic(600);
    }
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  public async stop(): Promise<void> {
    this.stopSyntheticTraffic();
    this.collector.stop();

    for (const ws of this.wss.clients) {
      ws.terminate();
    }

    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
