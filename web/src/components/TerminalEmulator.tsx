import React, { useState, useRef, useEffect } from 'react';
import { Terminal as TerminalIcon, Send, Trash2, Sparkles } from 'lucide-react';
import type { TerminalEntry } from '../types';
import { getApiBaseUrl } from '../config';

interface TerminalEmulatorProps {
  onSendCommand: (command: string) => Promise<{ output: string; latencyUs: number; error?: string }>;
}

export const TerminalEmulator: React.FC<TerminalEmulatorProps> = ({ onSendCommand }) => {
  const [inputCommand, setInputCommand] = useState('');
  const [history, setHistory] = useState<TerminalEntry[]>([
    {
      id: 'init-1',
      command: 'INFO',
      output: 'RadixKV Cache Cluster Online — 4 Worker Shards — Consistent Hash Ring (150 vnodes)',
      latencyUs: 15,
      timestamp: new Date().toLocaleTimeString(),
    },
    {
      id: 'init-2',
      command: 'PING',
      output: 'PONG',
      latencyUs: 12,
      timestamp: new Date().toLocaleTimeString(),
    }
  ]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [commandHistory, setCommandHistory] = useState<string[]>(['INFO', 'PING']);
  const [isExecuting, setIsExecuting] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [showAiBar, setShowAiBar] = useState(true);

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll terminal container ONLY (never the whole window)
  useEffect(() => {
    if (terminalContainerRef.current) {
      terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
    }
  }, [history]);

  const handleAiGenerate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = aiPrompt.trim();
    if (!trimmed || isGeneratingAi) return;

    setIsGeneratingAi(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/ai/copilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed }),
      });
      const data = await res.json();
      if (data.success && data.commands && data.commands.length > 0) {
        const generatedCmd = data.commands[0];
        setInputCommand(generatedCmd);
        setHistory((prev) => [
          ...prev,
          {
            id: `ai-${Date.now()}`,
            command: `✨ AI Copilot: "${trimmed}"`,
            output: `Generated: ${data.commands.join(' ; ')}\nExplanation: ${data.explanation}`,
            latencyUs: 0,
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
        setAiPrompt('');
        inputRef.current?.focus();
      } else {
        alert(data.error || 'Failed to generate command with AI');
      }
    } catch (err: any) {
      alert(err.message || 'AI request failed');
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputCommand.trim();
    if (!trimmed || isExecuting) return;

    if (trimmed.toUpperCase() === 'CLEAR') {
      setHistory([]);
      setInputCommand('');
      return;
    }

    setIsExecuting(true);
    setCommandHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);

    try {
      const res = await onSendCommand(trimmed);
      const newEntry: TerminalEntry = {
        id: `cmd-${Date.now()}`,
        command: trimmed,
        output: res.output,
        latencyUs: res.latencyUs,
        timestamp: new Date().toLocaleTimeString(),
        isError: !!res.error,
      };
      setHistory((prev) => [...prev, newEntry]);
    } catch (err: any) {
      setHistory((prev) => [
        ...prev,
        {
          id: `cmd-${Date.now()}`,
          command: trimmed,
          output: `(error) ${err.message}`,
          latencyUs: 0,
          timestamp: new Date().toLocaleTimeString(),
          isError: true,
        }
      ]);
    } finally {
      setIsExecuting(false);
      setInputCommand('');
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length === 0) return;
      const nextIndex = historyIndex === -1 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInputCommand(commandHistory[nextIndex]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= commandHistory.length) {
        setHistoryIndex(-1);
        setInputCommand('');
      } else {
        setHistoryIndex(nextIndex);
        setInputCommand(commandHistory[nextIndex]);
      }
    }
  };

  const executePreset = (cmd: string) => {
    setInputCommand(cmd);
    inputRef.current?.focus();
  };

  // Syntax colorizer for RESP outputs
  const renderOutput = (output: string, isError?: boolean) => {
    if (isError || output.startsWith('(error)')) {
      return <span className="text-rose-400 font-medium">{output}</span>;
    }
    if (output === 'OK' || output === 'PONG') {
      return <span className="text-emerald-400 font-bold">{output}</span>;
    }
    if (output.startsWith('(integer)')) {
      return <span className="text-violet-400">{output}</span>;
    }
    if (output === '(nil)') {
      return <span className="text-slate-500 italic">{output}</span>;
    }
    return <span className="text-cyan-300">{output}</span>;
  };

  return (
    <div className="glass-panel rounded-xl p-5 mb-8">
      {/* Terminal Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400">
            <TerminalIcon className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Interactive RESP Cluster Terminal</h3>
            <p className="text-xs text-slate-400">Direct TCP command execution with sub-millisecond execution profiling</p>
          </div>
        </div>

        {/* Quick Command Chips */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <span className="text-[11px] text-slate-500 mr-1">Quick:</span>
          <button
            onClick={() => executePreset('PING')}
            className="px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-cyan-300 border border-slate-700 transition"
          >
            PING
          </button>
          <button
            onClick={() => executePreset('SET user:alice "Engineer" EX 60')}
            className="px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-emerald-300 border border-slate-700 transition"
          >
            SET
          </button>
          <button
            onClick={() => executePreset('GET user:alice')}
            className="px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-cyan-300 border border-slate-700 transition"
          >
            GET
          </button>
          <button
            onClick={() => executePreset('INCR counter:visits')}
            className="px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-violet-300 border border-slate-700 transition"
          >
            INCR
          </button>
          <button
            onClick={() => executePreset('TTL user:alice')}
            className="px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-amber-300 border border-slate-700 transition"
          >
            TTL
          </button>
          <button
            onClick={() => setShowAiBar(!showAiBar)}
            className={`flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-medium transition border ${
              showAiBar
                ? 'bg-violet-950/80 text-violet-300 border-violet-600 shadow-[0_0_10px_rgba(168,85,247,0.3)]'
                : 'bg-slate-800/80 hover:bg-slate-700 text-violet-300 border-violet-900/50'
            }`}
            title="Toggle Gemini AI Copilot prompt bar"
          >
            <Sparkles className="w-3 h-3 text-violet-400" />
            <span>AI Copilot</span>
          </button>
          <button
            onClick={() => setHistory([])}
            className="p-1 rounded bg-slate-800 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 transition"
            title="Clear terminal window"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Screen */}
      <div
        ref={terminalContainerRef}
        className="bg-[#05080f] rounded-xl p-4 font-mono text-xs border border-slate-900 shadow-inner h-80 overflow-y-auto flex flex-col gap-2"
      >
        {history.map((entry) => (
          <div key={entry.id} className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-slate-400">
              <div className="flex items-center gap-2">
                <span className="text-cyan-500 font-bold">radix-kv:6379&gt;</span>
                <span className="text-white font-semibold">{entry.command}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-emerald-400">
                  {entry.latencyUs < 1000 ? `${entry.latencyUs} µs` : `${(entry.latencyUs / 1000).toFixed(3)} ms`}
                </span>
                <span>{entry.timestamp}</span>
              </div>
            </div>
            <div className="pl-4 py-0.5">
              {renderOutput(entry.output, entry.isError)}
            </div>
          </div>
        ))}
      </div>

      {/* AI Copilot Prompt Bar */}
      {showAiBar && (
        <form onSubmit={handleAiGenerate} className="mt-2.5 flex items-center gap-2 p-1.5 rounded-xl bg-violet-950/20 border border-violet-900/40">
          <div className="relative flex-1 flex items-center">
            <Sparkles className="absolute left-3 w-3.5 h-3.5 text-violet-400 pointer-events-none animate-pulse" />
            <input
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              disabled={isGeneratingAi}
              placeholder="Ask Gemini AI (e.g. 'Store session for user 42 with 5 min TTL', 'increment homepage view count')..."
              className="w-full pl-9 pr-3 py-1.5 bg-slate-950/90 border border-violet-900/50 rounded-lg text-xs font-sans text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 transition-all"
            />
          </div>
          <button
            type="submit"
            disabled={isGeneratingAi || !aiPrompt.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-medium text-xs transition-all shadow-[0_0_12px_rgba(139,92,246,0.3)] shrink-0"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{isGeneratingAi ? 'Translating...' : 'Generate Redis'}</span>
          </button>
        </form>
      )}

      {/* Command Input Prompt */}
      <form onSubmit={handleSubmit} className="mt-2 flex items-center gap-2">
        <div className="relative flex-1 flex items-center">
          <span className="absolute left-3 text-cyan-400 font-mono text-xs font-bold pointer-events-none">
            radix-kv:6379&gt;
          </span>
          <input
            ref={inputRef}
            type="text"
            value={inputCommand}
            onChange={(e) => setInputCommand(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isExecuting}
            placeholder="Type any Redis command (e.g. SET key value, GET key, DEL k1 k2, INCR counter)..."
            className="w-full pl-28 pr-4 py-2.5 bg-slate-950/80 border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
          />
        </div>
        <button
          type="submit"
          disabled={isExecuting || !inputCommand.trim()}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold text-xs transition-all duration-150 shadow-md glow-cyan"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Execute</span>
        </button>
      </form>
    </div>
  );
};
