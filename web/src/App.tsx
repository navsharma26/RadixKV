import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { MetricCards } from './components/MetricCards';
import { TelemetryCharts } from './components/TelemetryCharts';
import { MemoryHeatMap } from './components/MemoryHeatMap';
import { TerminalEmulator } from './components/TerminalEmulator';
import type { TelemetrySnapshot, ClusterInfo } from './types';

export const App: React.FC = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [current, setCurrent] = useState<TelemetrySnapshot | null>(null);
  const [history, setHistory] = useState<TelemetrySnapshot[]>([]);
  const [clusterInfo, setClusterInfo] = useState<ClusterInfo | null>(null);
  const [syntheticTraffic, setSyntheticTraffic] = useState(false);
  const [wsLatencyMs, setWsLatencyMs] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connect to WebSocket telemetry stream
  const connectWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Connect to same host or default to 3000 if in dev mode
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.port === '5173' ? 'localhost:3000' : window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'INITIAL_STATE') {
          if (data.current) setCurrent(data.current);
          if (data.history) setHistory(data.history);
          setClusterInfo({
            shardCount: data.shardCount ?? 4,
            vnodesPerShard: 150,
            tcpPort: data.tcpPort ?? 6379,
            telemetryPort: 3000,
            syntheticTraffic: !!data.syntheticTraffic,
          });
          setSyntheticTraffic(!!data.syntheticTraffic);
        } else if (data.type === 'TELEMETRY_TICK') {
          const snapshot: TelemetrySnapshot = data.snapshot;
          setCurrent(snapshot);
          setHistory((prev) => {
            const next = [...prev, snapshot];
            return next.slice(-60); // Keep 60 seconds
          });
          if (data.syntheticTraffic !== undefined) {
            setSyntheticTraffic(data.syntheticTraffic);
          }
        }
      } catch (err) {
        console.error('WebSocket parse error:', err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      wsRef.current = null;
      // Reconnect with backoff
      reconnectTimerRef.current = setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = () => {
      setIsConnected(false);
    };
  };

  useEffect(() => {
    connectWebSocket();

    // Ping timer to measure client-server telemetry latency
    const pingInterval = setInterval(async () => {
      const t0 = performance.now();
      try {
        const res = await fetch('/api/metrics');
        if (res.ok) {
          const t1 = performance.now();
          setWsLatencyMs(Math.round(t1 - t0));
        }
      } catch {
        // offline
      }
    }, 5000);

    return () => {
      clearInterval(pingInterval);
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  const handleToggleSyntheticTraffic = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/synthetic-traffic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setSyntheticTraffic(data.syntheticTraffic);
      }
    } catch (err) {
      console.error('Failed to toggle synthetic traffic:', err);
    }
  };

  const handleSendCommand = async (command: string) => {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Command failed');
    }
    return {
      output: data.output,
      latencyUs: data.latencyUs,
    };
  };

  return (
    <div className="min-h-screen bg-[#080c14] text-slate-100 flex flex-col">
      <Header
        isConnected={isConnected}
        clusterInfo={clusterInfo}
        syntheticTraffic={syntheticTraffic}
        onToggleSyntheticTraffic={handleToggleSyntheticTraffic}
        latencyMs={wsLatencyMs}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-6">
        {/* KPI Metrics HUD */}
        <MetricCards current={current} />

        {/* Live Recharts Telemetry Charts */}
        <TelemetryCharts history={history} />

        {/* 2D Memory-Layout Heat Map */}
        <MemoryHeatMap
          blocks={current?.heatmap ?? []}
          shardCount={clusterInfo?.shardCount ?? 4}
        />

        {/* Interactive Web-Based Terminal Emulator */}
        <TerminalEmulator onSendCommand={handleSendCommand} />
      </main>

      <footer className="border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500 font-mono">
        RadixKV Observability Platform • Node.js Native • Multi-Core Consistent Hash Cluster • Zero External Caching Dependencies
      </footer>
    </div>
  );
};
