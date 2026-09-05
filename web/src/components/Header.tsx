import React from 'react';
import { Cpu, Database, Flame, Server, Wifi, WifiOff, Sparkles } from 'lucide-react';
import type { ClusterInfo } from '../types';

interface HeaderProps {
  isConnected: boolean;
  clusterInfo: ClusterInfo | null;
  syntheticTraffic: boolean;
  onToggleSyntheticTraffic: (enabled: boolean) => void;
  latencyMs: number;
  onOpenAiAdvisor?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  isConnected,
  clusterInfo,
  syntheticTraffic,
  onToggleSyntheticTraffic,
  latencyMs,
  onOpenAiAdvisor,
}) => {
  return (
    <header className="glass-panel sticky top-0 z-30 px-6 py-4 border-b border-slate-800/80 mb-6">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Brand & Logo */}
        <div className="flex items-center gap-4">
          <div className="relative flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500/20 via-blue-500/20 to-violet-500/20 border border-cyan-500/40 glow-cyan">
            <Database className="w-6 h-6 text-cyan-400" />
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isConnected ? 'bg-emerald-400' : 'bg-rose-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-3 w-3 ${isConnected ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                Radix<span className="text-cyan-400">KV</span>
              </h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-950/60 text-cyan-400 border border-cyan-800/50 font-mono">
                v1.0.0
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Distributed In-Memory Engine & Real-Time Telemetry Cockpit
            </p>
          </div>
        </div>

        {/* Cluster Status Pills */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Connection Status */}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium ${
            isConnected
              ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60'
              : 'bg-rose-950/40 text-rose-300 border-rose-800/60'
          }`}>
            {isConnected ? <Wifi className="w-3.5 h-3.5 text-emerald-400" /> : <WifiOff className="w-3.5 h-3.5 text-rose-400" />}
            <span>{isConnected ? 'LIVE WS' : 'OFFLINE'}</span>
            {isConnected && <span className="text-slate-400 font-mono">({latencyMs}ms)</span>}
          </div>

          {/* TCP Port */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/60 border border-slate-800 text-xs text-slate-300 font-mono">
            <Server className="w-3.5 h-3.5 text-cyan-400" />
            <span>PORT:{clusterInfo?.tcpPort ?? 6379}</span>
          </div>

          {/* Shard Count */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/60 border border-slate-800 text-xs text-slate-300 font-mono">
            <Cpu className="w-3.5 h-3.5 text-violet-400" />
            <span>{clusterInfo?.shardCount ?? 4} SHARDS</span>
          </div>

          {/* AI Advisor Modal Trigger */}
          {onOpenAiAdvisor && (
            <button
              onClick={onOpenAiAdvisor}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 bg-gradient-to-r from-violet-950/60 via-fuchsia-950/40 to-purple-950/60 text-violet-200 border border-violet-500/60 hover:border-violet-400 hover:shadow-[0_0_15px_rgba(168,85,247,0.35)]"
              title="Open Gemini AI Cluster Diagnostics & Tuning Advisor"
            >
              <Sparkles className="w-3.5 h-3.5 text-violet-400 animate-pulse" />
              <span>AI ADVISOR</span>
            </button>
          )}

          {/* Synthetic Workload Generator Toggle */}
          <button
            onClick={() => onToggleSyntheticTraffic(!syntheticTraffic)}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
              syntheticTraffic
                ? 'bg-amber-950/50 text-amber-300 border-amber-500/60 shadow-[0_0_12px_rgba(245,158,11,0.3)] animate-pulse'
                : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-white hover:border-slate-700'
            }`}
            title="Generate synthetic load to demonstrate live telemetry metrics"
          >
            <Flame className={`w-3.5 h-3.5 ${syntheticTraffic ? 'text-amber-400 animate-bounce' : 'text-slate-500'}`} />
            <span>{syntheticTraffic ? 'SIMULATOR ACTIVE' : 'SIMULATE LOAD'}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
