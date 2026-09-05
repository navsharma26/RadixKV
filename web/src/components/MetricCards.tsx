import React from 'react';
import { Activity, Clock, MemoryStick, Network, PieChart } from 'lucide-react';
import type { TelemetrySnapshot } from '../types';

interface MetricCardsProps {
  current: TelemetrySnapshot | null;
}

export const MetricCards: React.FC<MetricCardsProps> = ({ current }) => {
  const opsPerSec = current?.opsPerSec ?? 0;
  const p99Ms = current?.latencies?.p99 ?? 0;
  const p50Ms = current?.latencies?.p50 ?? 0;
  const avgMs = current?.latencies?.avg ?? 0;

  // Format latency in microseconds if < 0.1ms for human readability
  const formatLatency = (ms: number) => {
    if (ms === 0) return '0 µs';
    if (ms < 0.1) {
      return `${Math.round(ms * 1000)} µs`;
    }
    return `${ms.toFixed(3)} ms`;
  };

  const hitRatio = (current?.hitMissRatio ?? 1) * 100;
  const heapUsedMb = current?.memory?.heapUsedMb ?? 0;
  const heapTotalMb = current?.memory?.heapTotalMb ?? 0;
  const rssMb = current?.memory?.rssMb ?? 0;
  const socketCount = current?.connectedSockets ?? 0;
  const totalCmds = current?.totalCommands ?? 0;

  // Latency status coloring
  const getLatencyColor = (ms: number) => {
    if (ms < 0.2) return 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20';
    if (ms < 1.0) return 'text-cyan-400 border-cyan-500/30 bg-cyan-950/20';
    if (ms < 3.0) return 'text-amber-400 border-amber-500/30 bg-amber-950/20';
    return 'text-rose-400 border-rose-500/30 bg-rose-950/20';
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      {/* 1. Ops / Sec Card */}
      <div className="glass-panel rounded-xl p-4 relative overflow-hidden transition-all duration-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Throughput</span>
          <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <Activity className="w-4 h-4" />
          </div>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold font-mono text-white tracking-tight">
            {opsPerSec.toLocaleString()}
          </span>
          <span className="text-xs text-cyan-400 font-medium font-mono">ops/s</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
          <span>Total Executed</span>
          <span className="font-mono text-slate-300">{totalCmds.toLocaleString()}</span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-500 to-blue-500" />
      </div>

      {/* 2. P99 Latency Card */}
      <div className="glass-panel rounded-xl p-4 relative overflow-hidden transition-all duration-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">P99 Latency</span>
          <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Clock className="w-4 h-4" />
          </div>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-white tracking-tight">
            {formatLatency(p99Ms)}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${getLatencyColor(p99Ms)}`}>
            {p99Ms < 0.5 ? 'SUB-MS' : 'STABLE'}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
          <span>P50: <span className="font-mono text-slate-300">{formatLatency(p50Ms)}</span></span>
          <span>Avg: <span className="font-mono text-slate-300">{formatLatency(avgMs)}</span></span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-emerald-500 to-teal-500" />
      </div>

      {/* 3. Hit / Miss Ratio Card */}
      <div className="glass-panel rounded-xl p-4 relative overflow-hidden transition-all duration-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Hit / Miss Ratio</span>
          <div className="p-2 rounded-lg bg-violet-500/10 text-violet-400 border border-violet-500/20">
            <PieChart className="w-4 h-4" />
          </div>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold font-mono text-white tracking-tight">
            {hitRatio.toFixed(1)}%
          </span>
          <span className="text-xs text-violet-400 font-medium">efficiency</span>
        </div>
        {/* Progress bar */}
        <div className="w-full bg-slate-800 rounded-full h-1.5 mt-2 overflow-hidden flex">
          <div className="bg-gradient-to-r from-violet-500 to-indigo-500 h-full rounded-full transition-all duration-500" style={{ width: `${hitRatio}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400 font-mono">
          <span>Hits: {current?.hitCount ?? 0}</span>
          <span>Miss: {current?.missCount ?? 0}</span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-500 to-indigo-500" />
      </div>

      {/* 4. Memory Allocations Card */}
      <div className="glass-panel rounded-xl p-4 relative overflow-hidden transition-all duration-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Heap Memory</span>
          <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <MemoryStick className="w-4 h-4" />
          </div>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold font-mono text-white tracking-tight">
            {heapUsedMb}
          </span>
          <span className="text-xs text-amber-400 font-medium font-mono">MB</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
          <span>Total: <span className="font-mono text-slate-300">{heapTotalMb} MB</span></span>
          <span>RSS: <span className="font-mono text-slate-300">{rssMb} MB</span></span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-amber-500 to-orange-500" />
      </div>

      {/* 5. Connected Sockets Card */}
      <div className="glass-panel rounded-xl p-4 relative overflow-hidden transition-all duration-200 sm:col-span-2 lg:col-span-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Sockets</span>
          <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Network className="w-4 h-4" />
          </div>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold font-mono text-white tracking-tight">
            {socketCount}
          </span>
          <span className="text-xs text-blue-400 font-medium">clients</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400 font-mono">
          <span>TCP Sockets</span>
          <span className="text-emerald-400">HEALTHY</span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-cyan-500" />
      </div>
    </div>
  );
};
