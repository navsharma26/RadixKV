import React, { useState } from 'react';
import { Grid, Info } from 'lucide-react';
import type { MemoryHeatMapBlock } from '../types';

interface MemoryHeatMapProps {
  blocks: MemoryHeatMapBlock[];
  shardCount: number;
}

export const MemoryHeatMap: React.FC<MemoryHeatMapProps> = ({ blocks, shardCount }) => {
  const [selectedShard, setSelectedShard] = useState<number | null>(null);
  const [hoveredBlock, setHoveredBlock] = useState<MemoryHeatMapBlock | null>(null);

  // Filter blocks by selected shard
  const filteredBlocks = selectedShard !== null
    ? blocks.filter((b) => b.shardId === selectedShard)
    : blocks;

  // Shard color themes
  const shardColors = [
    { border: 'border-cyan-500/40', bg: 'bg-cyan-500', text: 'text-cyan-400' },
    { border: 'border-emerald-500/40', bg: 'bg-emerald-500', text: 'text-emerald-400' },
    { border: 'border-violet-500/40', bg: 'bg-violet-500', text: 'text-violet-400' },
    { border: 'border-amber-500/40', bg: 'bg-amber-500', text: 'text-amber-400' },
  ];

  const getShardTheme = (id: number) => {
    return shardColors[id % shardColors.length];
  };

  return (
    <div className="glass-panel rounded-xl p-5 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400">
            <Grid className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Visual Memory-Layout Heat Map</h3>
            <p className="text-xs text-slate-400">64 memory regions partitioned across consistent hash ring shards</p>
          </div>
        </div>

        {/* Shard Filter Tabs */}
        <div className="flex items-center gap-1.5 bg-slate-900/80 p-1 rounded-lg border border-slate-800 text-xs font-mono">
          <button
            onClick={() => setSelectedShard(null)}
            className={`px-2.5 py-1 rounded transition-colors ${
              selectedShard === null ? 'bg-slate-700 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            All Shards
          </button>
          {Array.from({ length: shardCount }).map((_, idx) => {
            const theme = getShardTheme(idx);
            return (
              <button
                key={idx}
                onClick={() => setSelectedShard(idx)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  selectedShard === idx ? 'bg-slate-700 text-white font-semibold' : `${theme.text} hover:text-white`
                }`}
              >
                Shard {idx}
              </button>
            );
          })}
        </div>
      </div>

      {/* 2D Heat Map Grid (8 columns x 8 rows = 64 blocks) */}
      <div className="grid grid-cols-8 sm:grid-cols-16 gap-2 p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 relative">
        {filteredBlocks.map((block) => {
          const theme = getShardTheme(block.shardId);
          const opacity = Math.max(0.2, block.utilizationPct / 100);

          return (
            <div
              key={block.blockId}
              onMouseEnter={() => setHoveredBlock(block)}
              onMouseLeave={() => setHoveredBlock(null)}
              className={`aspect-square rounded-md transition-all duration-150 cursor-pointer relative flex items-center justify-center border hover:scale-110 hover:z-20 ${theme.border}`}
              style={{
                backgroundColor: `rgba(6, 182, 212, ${opacity * 0.45})`,
                boxShadow: block.utilizationPct > 60 ? '0 0 8px rgba(6, 182, 212, 0.3)' : undefined,
              }}
            >
              {/* TTL Health indicator dot */}
              {block.ttlHealth === 'expiring' && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping" />
              )}
              {block.ttlHealth === 'warning' && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-400" />
              )}
              <span className="text-[9px] font-mono text-slate-300 font-medium">
                {block.blockId}
              </span>
            </div>
          );
        })}
      </div>

      {/* Live Tooltip / Inspector HUD */}
      <div className="mt-4 p-3 rounded-lg bg-slate-900/50 border border-slate-800/60 flex flex-wrap items-center justify-between text-xs text-slate-300 gap-4">
        {hoveredBlock ? (
          <div className="flex flex-wrap items-center gap-6 font-mono">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Block:</span>
              <span className="font-bold text-white">#{hoveredBlock.blockId}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Owning Shard:</span>
              <span className={`font-bold ${getShardTheme(hoveredBlock.shardId).text}`}>
                Shard {hoveredBlock.shardId}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Vnode Range:</span>
              <span className="text-cyan-300">{hoveredBlock.vnodeRange}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Density:</span>
              <span className="text-emerald-400">{hoveredBlock.keyCount} keys (~{hoveredBlock.sizeBytes} B)</span>
            </div>
            {hoveredBlock.sampleKeys.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Sample Keys:</span>
                <span className="text-slate-200">[{hoveredBlock.sampleKeys.join(', ')}]</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-slate-500 italic">
            <Info className="w-3.5 h-3.5 text-slate-500" />
            <span>Hover over any memory block in the grid to inspect partition details, key allocation, and TTL urgency</span>
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center gap-4 text-[11px] font-mono ml-auto">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded bg-cyan-500/20 border border-cyan-500/40"></span>
            <span className="text-slate-400">Low</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded bg-cyan-500/80 border border-cyan-400"></span>
            <span className="text-slate-400">Hot</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-400"></span>
            <span className="text-slate-400">Near Expiry</span>
          </div>
        </div>
      </div>
    </div>
  );
};
