import { useEffect, useState, useCallback } from 'react';
import {
  Cpu, Copy, Check, CheckCircle2, XCircle, Download, Zap,
  MemoryStick, Users, Activity, Clock, HardDrive, Key,
  RefreshCw, Database, Shield, Trash2,
} from 'lucide-react';
import Shell from '@/components/Shell';
import { api, RedisInfo } from '@/lib/api';

/* ---- Types ---- */

interface RedisKeyspace {
  db: string; keys: number; expires: number; avgTtl: number;
}

interface RedisStats {
  version: string; uptime: number; uptimeHuman: string;
  connectedClients: number; blockedClients: number;
  usedMemory: number; usedMemoryHuman: string;
  usedMemoryPeak: number; usedMemoryPeakHuman: string;
  memFragRatio: number;
  totalConnsRecv: number; totalCmdsProc: number; opsPerSec: number;
  keyspaceHits: number; keyspaceMisses: number; hitRate: number;
  totalKeys: number; expiringKeys: number; evictedKeys: number;
  rdbLastSave: number; rdbChanges: number; role: string;
  keyspaces: RedisKeyspace[];
}

/* ---- Helpers ---- */

function bytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function fmtNum(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function timeSince(unix: number): string {
  if (!unix) return 'Never';
  const secs = Math.floor(Date.now() / 1000) - unix;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/* ---- Reusable Components ---- */

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

function RingGauge({ value, color, size = 60 }: { value: number; color: string; size?: number }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * (1 - Math.min(value, 100) / 100);
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="4" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={circ} strokeDashoffset={dash} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.8s ease-out', filter: `drop-shadow(0 0 4px ${color}60)` }} />
    </svg>
  );
}

function MiniCard({ title, value, sub, icon: Icon, color }: {
  title: string; value: string; sub?: string; icon: React.ElementType; color: string;
}) {
  return (
    <div className="card p-4 group hover:border-white/[0.12] transition-all" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5">{title}</p>
          <p className="text-xl font-bold text-white leading-none">{value}</p>
          {sub && <p className="text-[11px] text-gray-600 mt-1">{sub}</p>}
        </div>
        <div className="h-9 w-9 flex items-center justify-center rounded-xl shrink-0"
          style={{ background: `${color}12`, border: `1px solid ${color}22` }}>
          <Icon size={16} style={{ color }} />
        </div>
      </div>
    </div>
  );
}

/* ---- Memory Gauge ---- */

function MemoryGauge({ used, peak, human, peakHuman, fragRatio }: {
  used: number; peak: number; human: string; peakHuman: string; fragRatio: number;
}) {
  const pct = peak > 0 ? (used / peak) * 100 : 0;
  const fragColor = fragRatio > 1.5 ? '#ef4444' : fragRatio > 1.2 ? '#f59e0b' : '#10b981';
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Memory Usage</p>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <RingGauge value={pct} color="#ef4444" size={64} />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-bold text-gray-300">{Math.round(pct)}%</span>
          </div>
        </div>
        <div className="flex-1 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-600">Used</span>
            <span className="text-xs font-bold text-white">{human}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-600">Peak</span>
            <span className="text-xs font-mono text-gray-400">{peakHuman}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-600">Frag Ratio</span>
            <span className="text-xs font-mono" style={{ color: fragColor }}>{fragRatio}x</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Hit Rate Gauge ---- */

function HitRateGauge({ hits, misses, rate }: { hits: number; misses: number; rate: number }) {
  const color = rate >= 95 ? '#10b981' : rate >= 80 ? '#f59e0b' : '#ef4444';
  const label = rate >= 95 ? 'Excellent' : rate >= 80 ? 'Good' : 'Low';
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Cache Hit Rate</p>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <RingGauge value={rate} color={color} size={64} />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs font-bold text-gray-300">{rate}%</span>
          </div>
        </div>
        <div className="flex-1 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-600">Hits</span>
            <span className="text-xs font-mono text-emerald-400">{fmtNum(hits)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-600">Misses</span>
            <span className="text-xs font-mono text-red-400">{fmtNum(misses)}</span>
          </div>
          <div>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
              style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}>
              {label}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Active Databases ---- */

function ActiveDatabases({ keyspaces, onFlush }: { keyspaces: RedisKeyspace[]; onFlush: (db: number) => Promise<void> }) {
  const ksMap = new Map(keyspaces.map(ks => [ks.db, ks]));
  const allDbs = Array.from({ length: 16 }, (_, i) => `db${i}`);
  const activeCount = keyspaces.length;
  const [confirmDb, setConfirmDb] = useState<string | null>(null);
  const [flushing, setFlushing] = useState<string | null>(null);

  async function handleFlush(db: string) {
    const num = parseInt(db.replace('db', ''), 10);
    setFlushing(db);
    setConfirmDb(null);
    try { await onFlush(num); } finally { setFlushing(null); }
  }

  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Database size={13} className="text-gray-600" />
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Databases</p>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
          style={{ background: activeCount > 0 ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.05)',
                   color: activeCount > 0 ? '#10b981' : '#666',
                   border: `1px solid ${activeCount > 0 ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.06)'}` }}>
          {activeCount} / 16 active
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {allDbs.map(db => {
          const ks = ksMap.get(db);
          const active = !!ks;
          const isConfirm = confirmDb === db;
          const isFlush = flushing === db;
          return (
            <div key={db} className="rounded-xl px-3 py-2.5 transition-all relative group"
              style={{
                background: active ? 'rgba(16,185,129,0.06)' : 'rgba(255,255,255,0.015)',
                border: `1px solid ${active ? 'rgba(16,185,129,0.18)' : 'rgba(255,255,255,0.04)'}`,
              }}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ background: active ? '#10b981' : 'rgba(255,255,255,0.1)',
                             boxShadow: active ? '0 0 6px rgba(16,185,129,0.4)' : 'none' }} />
                  <span className={`text-[11px] font-mono font-bold ${active ? 'text-emerald-400' : 'text-gray-700'}`}>
                    {db}
                  </span>
                </div>
                {active && !isConfirm && !isFlush && (
                  <button onClick={() => setConfirmDb(db)} title={`Flush ${db}`}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-700 hover:text-red-400 transition-all">
                    <Trash2 size={10} />
                  </button>
                )}
                {isFlush && (
                  <span className="h-2.5 w-2.5 rounded-full border border-gray-600 border-t-gray-300 animate-spin" />
                )}
              </div>
              {isConfirm ? (
                <div className="space-y-1.5">
                  <p className="text-[9px] text-red-400">Flush all keys?</p>
                  <div className="flex gap-1">
                    <button onClick={() => handleFlush(db)}
                      className="flex-1 text-[9px] font-semibold py-1 rounded-md bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors">
                      Flush
                    </button>
                    <button onClick={() => setConfirmDb(null)}
                      className="flex-1 text-[9px] font-semibold py-1 rounded-md bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : active ? (
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-gray-600">keys</span>
                    <span className="text-[11px] font-mono text-white font-semibold">{fmtNum(ks.keys)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-gray-600">expires</span>
                    <span className="text-[10px] font-mono text-gray-400">{fmtNum(ks.expires)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-gray-600">ttl</span>
                    <span className="text-[10px] font-mono text-gray-500">
                      {ks.avgTtl > 0 ? `${Math.round(ks.avgTtl / 1000)}s` : '--'}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-[9px] text-gray-800 mt-0.5">empty</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Redis Page ---- */

export default function RedisPage() {
  const [info, setInfo] = useState<RedisInfo | null>(null);
  const [stats, setStats] = useState<RedisStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');

  const fetchInfo = useCallback(async () => {
    const res = await api.get<RedisInfo>('/redis');
    if (res.success && res.data) setInfo(res.data);
    setLoading(false);
  }, []);

  const fetchStats = useCallback(async () => {
    const res = await api.get<RedisStats>('/redis/stats');
    if (res.success && res.data) setStats(res.data);
    setStatsLoading(false);
  }, []);

  useEffect(() => { fetchInfo(); fetchStats(); }, [fetchInfo, fetchStats]);

  // Auto-refresh stats every 10s
  useEffect(() => {
    if (!info?.running) return;
    const id = setInterval(fetchStats, 10000);
    return () => clearInterval(id);
  }, [fetchStats, info?.running]);

  async function install() {
    setInstalling(true); setError('');
    const res = await api.post('/redis/install');
    setInstalling(false);
    if (res.success) { await fetchInfo(); await fetchStats(); }
    else setError(res.error ?? 'Installation failed');
  }

  async function flushDb(db: number) {
    const res = await api.post(`/redis/flush/${db}`);
    if (res.success) await fetchStats();
    else setError(res.error ?? `Failed to flush db${db}`);
  }

  const rs = stats;

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Redis</h1>
          <p className="text-sm text-gray-600 mt-1">
            In-memory data store for caching and sessions
            {rs && <span className="text-gray-700"> · v{rs.version} · Up {rs.uptimeHuman}</span>}
          </p>
        </div>
        {info?.running && (
          <button onClick={() => { setStatsLoading(true); fetchStats(); }} className="btn-ghost text-xs py-1.5">
            <RefreshCw size={12} /> Refresh
          </button>
        )}
      </div>

      {loading ? (
        <div className="card h-24 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
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
                    {rs && (
                      <span className="text-[10px] font-mono text-gray-600">
                        {rs.role} · {rs.version}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mt-0.5">
                    {info?.running
                      ? `Listening on port 6379 · ${rs ? `${fmtNum(rs.totalKeys)} keys · ${rs.usedMemoryHuman}` : 'localhost only'}`
                      : info?.installed ? 'Installed but not running'
                      : 'Install Redis to enable caching'}
                  </p>
                </div>
              </div>

              {!info?.installed && (
                <button onClick={install} className="btn-primary" disabled={installing}>
                  {installing ? (
                    <span className="flex items-center gap-2">
                      <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      Installing...
                    </span>
                  ) : (
                    <><Download size={13} /> Install Redis</>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* ---- Monitoring Dashboard (only when running + stats loaded) ---- */}
          {info?.running && rs && !statsLoading && (
            <>
              {/* Top stat cards */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <MiniCard title="Ops/sec" value={fmtNum(rs.opsPerSec)} sub="Instantaneous" icon={Zap} color="#8b5cf6" />
                <MiniCard title="Clients" value={String(rs.connectedClients)} sub={`${rs.blockedClients} blocked`} icon={Users} color="#3b82f6" />
                <MiniCard title="Total Keys" value={fmtNum(rs.totalKeys)} sub={`${fmtNum(rs.expiringKeys)} expiring`} icon={Key} color="#f59e0b" />
                <MiniCard title="Commands" value={fmtNum(rs.totalCmdsProc)} sub={`${fmtNum(rs.totalConnsRecv)} connections`} icon={Activity} color="#10b981" />
                <MiniCard title="Evictions" value={fmtNum(rs.evictedKeys)} sub="Keys evicted" icon={HardDrive}
                  color={rs.evictedKeys > 0 ? '#ef4444' : '#10b981'} />
              </div>

              {/* Memory + Hit Rate */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <MemoryGauge
                  used={rs.usedMemory} peak={rs.usedMemoryPeak}
                  human={rs.usedMemoryHuman} peakHuman={rs.usedMemoryPeakHuman}
                  fragRatio={rs.memFragRatio} />
                <HitRateGauge hits={rs.keyspaceHits} misses={rs.keyspaceMisses} rate={rs.hitRate} />
              </div>

              {/* Active Databases */}
              <ActiveDatabases keyspaces={rs.keyspaces} onFlush={flushDb} />

              {/* Persistence info */}
              <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="flex items-center gap-2 mb-3">
                  <Shield size={13} className="text-gray-600" />
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Persistence</p>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <p className="text-[10px] text-gray-700 uppercase mb-1">Last RDB Save</p>
                    <p className="text-sm font-mono text-gray-300">{timeSince(rs.rdbLastSave)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-700 uppercase mb-1">Changes Since Save</p>
                    <p className="text-sm font-mono text-gray-300">{fmtNum(rs.rdbChanges)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-700 uppercase mb-1">Role</p>
                    <p className="text-sm font-mono text-gray-300 capitalize">{rs.role || 'master'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-700 uppercase mb-1">Uptime</p>
                    <p className="text-sm font-mono text-gray-300">{rs.uptimeHuman}</p>
                  </div>
                </div>
              </div>

              {/* Version/info footer */}
              <div className="flex items-center gap-3 rounded-xl px-4 py-3 text-[10px] text-gray-700"
                style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)' }}>
                <Clock size={11} className="text-gray-700" />
                <span>Redis {rs.version}</span>
                <span className="text-gray-800">|</span>
                <span>Memory: {rs.usedMemoryHuman} / Peak {rs.usedMemoryPeakHuman}</span>
                <span className="text-gray-800">|</span>
                <span>Frag: {rs.memFragRatio}x</span>
                <span className="text-gray-800">|</span>
                <span>{fmtNum(rs.totalKeys)} keys across {rs.keyspaces.length} db{rs.keyspaces.length !== 1 ? 's' : ''}</span>
              </div>
            </>
          )}

          {info?.running && statsLoading && (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="card h-20 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
              ))}
            </div>
          )}

          {/* Connection info */}
          {info?.connection && (
            <div className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <Zap size={14} className="text-violet-400" />
                Connection Details
              </h2>
              <div className="space-y-3">
                {[
                  { label: 'Host', value: info.connection.host },
                  { label: 'Port', value: String(info.connection.port) },
                  { label: 'URL', value: info.connection.url },
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
