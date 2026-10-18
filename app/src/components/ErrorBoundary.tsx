import React, { Component, ReactNode } from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 text-white p-6">
          <div className="max-w-md w-full quantum-panel rounded-2xl p-8 border border-red-500/20">
            <div className="text-center mb-6">
              <div className="text-6xl mb-4">🚨</div>
              <h2 className="text-2xl font-bold text-red-400 mb-2">
                Component Crash Detected
              </h2>
              <p className="text-slate-400 text-sm mb-6">
                {this.state.error?.message || 'Unknown error occurred'}
              </p>
            </div>

            <div className="space-y-3">
              <button
                onClick={this.handleRetry}
                className="w-full quantum-btn-primary py-3 bg-gradient-to-r from-red-600 to-orange-600 rounded-xl font-bold text-white"
              >
                🔄 Reload Application
              </button>
              
              <button
                onClick={() => {
                  // v6.2: selective clear — a raw localStorage.clear() here
                  // destroyed the exact keys flushCache carefully preserves
                  // (WEALTH_AI_KEYS, TG creds, portfolio, txn_history,
                  // price_alerts…). enc: ciphertext blobs survive verbatim
                  // (raw string round-trip, no decryption involved).
                  try {
                    const KEEP = ['WEALTH_AI_KEYS', 'WEALTH_AI_GROQ', 'WEALTH_AI_TAVILY', 'TG_TOKEN', 'TG_CHAT_ID',
                      'theme', 'portfolio', 'plannerSettings', 'wealth_goals', 'authDone', 'txn_history',
                      'price_alerts', 'plan_tracker_us_freq', 'cloud_state_ts', 'usdAppRate', 'usdAppRate_migrated'];
                    const saved: Record<string, string> = {};
                    for (const k of KEEP) {
                      const v = localStorage.getItem(k);
                      if (v != null) saved[k] = v;
                      const b = localStorage.getItem(`${k}_undecryptable`);
                      if (b != null) saved[`${k}_undecryptable`] = b;
                    }
                    localStorage.clear();
                    for (const [k, v] of Object.entries(saved)) {
                      try { localStorage.setItem(k, v); } catch { /* quota */ }
                    }
                  } catch { /* ignore */ }
                  this.handleRetry();
                }}
                className="w-full py-3 bg-slate-800 hover:bg-slate-700 rounded-xl font-bold text-slate-300 text-sm transition-colors"
              >
                🧹 Clear Cache & Reload
              </button>
            </div>

            {this.state.error && (
              <details className="mt-6 text-xs text-slate-500 bg-black/30 rounded-lg p-3">
                <summary className="cursor-pointer text-red-400 font-bold mb-2">
                  Error Details (for debugging)
                </summary>
                <pre className="whitespace-pre-wrap break-words">
                  {this.state.error.toString()}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
