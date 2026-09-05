import React, { useState, useEffect } from 'react';
import { Sparkles, X, RefreshCw, CheckCircle2, AlertTriangle, AlertOctagon, Cpu, Zap, ShieldCheck } from 'lucide-react';
import { getApiBaseUrl } from '../config';

export interface DiagnosticFinding {
  metric: string;
  value: string;
  status: 'optimal' | 'warning' | 'critical';
  insight: string;
}

export interface DiagnosticReport {
  status: 'OPTIMAL' | 'ATTENTION' | 'CRITICAL';
  headline: string;
  overallScore: number;
  keyFindings: DiagnosticFinding[];
  recommendations: string[];
  generatedAt: string;
  model: string;
}

interface AiAdvisorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AiAdvisorModal: React.FC<AiAdvisorModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiagnostics = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/ai/diagnostics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.success && data.report) {
        setReport(data.report);
      } else {
        setError(data.error || 'Failed to generate diagnostics');
      }
    } catch (err: any) {
      setError(err.message || 'Network error connecting to Gemini AI Advisor');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && !report && !isLoading) {
      fetchDiagnostics();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'CRITICAL':
        return 'text-rose-400 bg-rose-950/60 border-rose-500/50 shadow-rose-950/50';
      case 'ATTENTION':
        return 'text-amber-400 bg-amber-950/60 border-amber-500/50 shadow-amber-950/50';
      default:
        return 'text-emerald-400 bg-emerald-950/60 border-emerald-500/50 shadow-emerald-950/50';
    }
  };

  const getFindingIcon = (status: string) => {
    switch (status) {
      case 'critical':
        return <AlertOctagon className="w-4 h-4 text-rose-400 shrink-0" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
      default:
        return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-slate-900/95 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500/30 to-fuchsia-500/30 border border-violet-500/40 flex items-center justify-center text-violet-300 shadow-[0_0_15px_rgba(168,85,247,0.3)]">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white tracking-tight">Gemini AI Cluster Advisor</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-950/80 text-violet-300 border border-violet-700/50 font-mono">
                  Gemini 3.5 Flash
                </span>
              </div>
              <p className="text-xs text-slate-400">Autonomous diagnostic engine analyzing live telemetry & cache behavior</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isLoading && (
            <div className="py-16 flex flex-col items-center justify-center space-y-4 text-center">
              <div className="relative">
                <div className="w-14 h-14 rounded-2xl bg-violet-950/40 border border-violet-500/50 flex items-center justify-center animate-spin">
                  <RefreshCw className="w-7 h-7 text-violet-400" />
                </div>
                <div className="absolute inset-0 rounded-2xl blur-xl bg-violet-500/20 animate-pulse" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-200">Evaluating cluster telemetry with Gemini AI...</p>
                <p className="text-xs text-slate-500 mt-1">Analyzing P99 latencies, hit rates, shard balancing, and memory</p>
              </div>
            </div>
          )}

          {error && !isLoading && (
            <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-800/60 text-rose-300 text-sm flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0 text-rose-400 mt-0.5" />
              <div>
                <p className="font-semibold text-rose-200">Diagnostic Analysis Error</p>
                <p className="text-xs mt-1 text-rose-300/80">{error}</p>
                <button
                  onClick={fetchDiagnostics}
                  className="mt-3 px-3 py-1 bg-rose-900/60 hover:bg-rose-800/60 text-xs font-medium rounded-md border border-rose-700/60 transition-colors"
                >
                  Retry Analysis
                </button>
              </div>
            </div>
          )}

          {report && !isLoading && (
            <>
              {/* Executive Summary Card */}
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`px-2.5 py-0.5 rounded-md text-xs font-semibold uppercase tracking-wider border ${getStatusColor(report.status)}`}>
                      {report.status} HEALTH
                    </span>
                    <span className="text-xs text-slate-500">
                      Evaluated {new Date(report.generatedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <h4 className="text-sm font-medium text-slate-200 leading-relaxed">
                    {report.headline}
                  </h4>
                </div>

                {/* Score Gauge */}
                <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
                  <div className="text-right">
                    <span className="text-[10px] text-slate-400 uppercase font-mono block">Health Score</span>
                    <span className="text-xl font-bold font-mono text-emerald-400">{report.overallScore}/100</span>
                  </div>
                  <ShieldCheck className="w-7 h-7 text-emerald-400" />
                </div>
              </div>

              {/* Key Observations */}
              <div>
                <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-cyan-400" /> Telemetry Observations
                </h5>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {report.keyFindings.map((finding, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-xl bg-slate-950/50 border border-slate-800/80 hover:border-slate-700 transition-colors flex items-start gap-2.5"
                    >
                      {getFindingIcon(finding.status)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-slate-300">{finding.metric}</span>
                          <span className="text-xs font-mono font-semibold text-white px-1.5 py-0.5 rounded bg-slate-800">
                            {finding.value}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1 leading-normal">{finding.insight}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recommendations */}
              <div>
                <h5 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5 text-violet-400" /> Actionable Recommendations
                </h5>
                <div className="space-y-2">
                  {report.recommendations.map((rec, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-xl bg-violet-950/20 border border-violet-900/30 text-xs text-slate-300 flex items-start gap-3"
                    >
                      <span className="w-5 h-5 rounded-full bg-violet-900/50 border border-violet-700/60 text-violet-300 font-mono text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                        {idx + 1}
                      </span>
                      <p className="flex-1 leading-relaxed">{rec}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <span className="text-[11px] text-slate-500 font-mono">
            Powered by Google Gemini 3.5 Flash Lite
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchDiagnostics}
              disabled={isLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-all shadow-[0_0_12px_rgba(139,92,246,0.3)] disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Refresh Diagnosis</span>
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
