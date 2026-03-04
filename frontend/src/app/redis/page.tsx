'use client';
import { useEffect, useState, useCallback } from 'react';
import { Cpu, Copy, Check, CheckCircle2, XCircle, Download, Zap } from 'lucide-react';
import Shell from '@/components/Shell';
import { api, RedisInfo } from '@/lib/api';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button onClick={copy} className="p-1.5 rounded-lg text-gray-600 hover:text-white hover:bg-white/5 transition-all" title="Copy">
      {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
    </button>
  );
}

export default function RedisPage() {
  const [info,       setInfo]       = useState<RedisInfo | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error,      setError]      = useState('');

  const fetchInfo = useCallback(async () => {
    const res = await api.get<RedisInfo>('/redis');
    if (res.success && res.data) setInfo(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchInfo(); }, [fetchInfo]);

  async function install() {
    setInstalling(true); setError('');
    const res = await api.post('/redis/install');
    setInstalling(false);
    if (res.success) await fetchInfo();
    else setError(res.error ?? 'Installation failed');
  }

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Redis</h1>
        <p className="text-sm text-gray-600 mt-1">In-memory data store for caching and sessions</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          <div className="card h-24 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
        </div>
      ) : (
        <div className="space-y-4 animate-slide-up">
          {/* Status card */}
          <div className="card hover:border-white/[0.1] transition-all duration-200"
            style={{ background: 'rgba(255,255,255,0.02)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0"
                  style={info?.running
                    ? { background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }
                    : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <Cpu size={22} className={info?.running ? 'text-emerald-400' : 'text-gray-600'} />
                </div>
                <div>
                  <div className="flex items-center gap-2.5">
                    <p className="font-semibold text-white">Redis</p>
                    {info?.running ? (
                      <span className="badge-green"><CheckCircle2 size={10} /> Running</span>
                    ) : info?.installed ? (
                      <span className="badge-yellow">Stopped</span>
                    ) : (
                      <span className="badge-gray"><XCircle size={10} /> Not installed</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mt-0.5">
                    {info?.running
                      ? 'Listening on port 6379 · localhost only'
                      : info?.installed
                        ? 'Installed but not running'
                        : 'Install Redis to enable caching'}
                  </p>
                </div>
              </div>

              {!info?.installed && (
                <button onClick={install} className="btn-primary" disabled={installing}>
                  {installing ? (
                    <span className="flex items-center gap-2">
                      <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      Installing…
                    </span>
                  ) : (
                    <><Download size={13} /> Install Redis</>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Connection info */}
          {info?.connection && (
            <div className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <Zap size={14} className="text-violet-400" />
                Connection Details
              </h2>
              <div className="space-y-3">
                {[
                  { label: 'Host',    value: info.connection.host },
                  { label: 'Port',    value: String(info.connection.port) },
                  { label: 'URL',     value: info.connection.url },
                  { label: 'Env Var', value: info.connection.env_var },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="label">{label}</p>
                    <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
                      <code className="text-sm text-gray-300 font-mono flex-1 truncate">{value}</code>
                      <CopyButton text={value} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Usage hint */}
              <div className="mt-5 rounded-xl border border-white/[0.05] bg-white/[0.01] px-4 py-3 text-xs text-gray-600 space-y-1.5">
                <p className="text-gray-500 font-medium">Quick Start</p>
                <p>Add to your app's environment variables:</p>
                <code className="block text-gray-400 font-mono">REDIS_URL=redis://localhost:6379</code>
                <p>Then use any Redis client library in your Next.js app.</p>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">{error}</div>
          )}
        </div>
      )}
    </Shell>
  );
}
