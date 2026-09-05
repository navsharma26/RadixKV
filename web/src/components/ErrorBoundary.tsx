import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('RadixKV Uncaught Dashboard Error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#080c14] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full glass-panel rounded-2xl p-6 border border-rose-800/60 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 rounded-xl bg-rose-950/60 text-rose-400 border border-rose-500/40">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Dashboard Encountered an Error</h2>
                <p className="text-xs text-slate-400 font-mono">React Component Exception Intercepted</p>
              </div>
            </div>

            <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800 font-mono text-xs text-rose-300 mb-5 overflow-x-auto max-h-40">
              {this.state.error?.message || 'Unknown render exception'}
            </div>

            <button
              onClick={() => window.location.reload()}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition duration-150 glow-cyan"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Reload Observability Cockpit</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
