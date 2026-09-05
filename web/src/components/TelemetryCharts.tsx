import React from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { Activity, BarChart3 } from 'lucide-react';
import type { TelemetrySnapshot } from '../types';

interface TelemetryChartsProps {
  history: TelemetrySnapshot[];
}

export const TelemetryCharts: React.FC<TelemetryChartsProps> = ({ history }) => {
  // Format history for Recharts time-series
  const chartData = history.map((snapshot) => {
    const d = new Date(snapshot.timestamp);
    const timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    return {
      time: timeStr,
      opsPerSec: snapshot.opsPerSec,
      p99LatencyMs: snapshot.latencies?.p99 ?? 0,
      p50LatencyMs: snapshot.latencies?.p50 ?? 0,
      heapUsedMb: snapshot.memory?.heapUsedMb ?? 0,
      heapTotalMb: snapshot.memory?.heapTotalMb ?? 0,
      rssMb: snapshot.memory?.rssMb ?? 0,
    };
  });

  // Aggregate command breakdown from latest snapshot
  const latestSnapshot = history.length > 0 ? history[history.length - 1] : null;
  const breakdown = latestSnapshot?.commandBreakdown ?? {};
  const commandData = [
    { name: 'GET', count: breakdown['GET'] || 0, fill: '#06b6d4' },
    { name: 'SET', count: breakdown['SET'] || 0, fill: '#10b981' },
    { name: 'INCR', count: breakdown['INCR'] || 0, fill: '#8b5cf6' },
    { name: 'DEL', count: breakdown['DEL'] || 0, fill: '#f43f5e' },
    { name: 'TTL', count: breakdown['TTL'] || 0, fill: '#f59e0b' },
    { name: 'PING', count: breakdown['PING'] || 0, fill: '#3b82f6' },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
      {/* 1. Throughput & P99 Latency Dual-Axis Chart */}
      <div className="glass-panel rounded-xl p-5 lg:col-span-2">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Live Cluster Throughput & Latency (60s)</h3>
              <p className="text-xs text-slate-400">Real-time command volume (ops/s) vs Sub-millisecond P99 latency</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400"></span>
              <span className="text-slate-300">Ops / sec</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
              <span className="text-slate-300">P99 Latency (ms)</span>
            </div>
          </div>
        </div>

        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="opsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="latencyGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} />
              <YAxis yAxisId="left" stroke="#06b6d4" fontSize={10} tickLine={false} />
              <YAxis yAxisId="right" orientation="right" stroke="#10b981" fontSize={10} tickLine={false} unit="ms" />
              <Tooltip
                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '0.5rem' }}
                itemStyle={{ fontSize: '12px' }}
                labelStyle={{ color: '#94a3b8', fontSize: '11px', marginBottom: '4px' }}
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="opsPerSec"
                stroke="#06b6d4"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#opsGradient)"
                name="Ops/sec"
              />
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="p99LatencyMs"
                stroke="#10b981"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#latencyGradient)"
                name="P99 Latency (ms)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 2. Operations Breakdown Bar Chart */}
      <div className="glass-panel rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-violet-500/10 text-violet-400">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Command Distribution</h3>
              <p className="text-xs text-slate-400">Executed operations breakdown</p>
            </div>
          </div>
        </div>

        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={commandData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="name" stroke="#64748b" fontSize={11} tickLine={false} />
              <YAxis stroke="#64748b" fontSize={10} tickLine={false} />
              <Tooltip
                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '0.5rem' }}
                itemStyle={{ fontSize: '12px', color: '#f1f5f9' }}
                labelStyle={{ color: '#94a3b8', fontSize: '11px', marginBottom: '4px' }}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} name="Operations" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};
