import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Database as DbIcon, Plus, Trash2, Copy, Check, Activity,
  HardDrive, Users, Zap, AlertTriangle, Clock, ArrowDown, ArrowUp,
  BarChart3, RefreshCw, Server, Download, Upload, ExternalLink,
} from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { api, ManagedDb } from '@/lib/api';

/* ---- Types ---- */

interface PgDbStats {
  name: string; size: number; numBackends: number;
  txCommit: number; txRollback: number; cacheHit: number;
  tupFetched: number; tupInserted: number; tupUpdated: number; tupDeleted: number;
}

interface PgSlowQuery {
  pid: number; database: string; user: string;
  duration: number; state: string; query: string; waitEvent: string;
}

interface PgConnInfo {
  state: string; count: number;
}

interface PgOverview {
  version: string; uptime: string;
  maxConns: number; activeConns: number; idleConns: number; totalConns: number;
  cacheHit: number;
  txCommit: number; txRollback: number;
  tupFetched: number; tupInserted: number; tupUpdated: number; tupDeleted: number;
  conflicts: number; deadlocks: number; tempBytes: number;
  databases: PgDbStats[];
  slowQueries: PgSlowQuery[];
  connections: PgConnInfo[];
}

interface DbWithConn extends ManagedDb { connection_string?: string }

/* ---- Helpers ---- */

function bytes(b: number): string {
  if (b >= 1e12) return (b / 1e12).toFixed(1) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

function fmtNum(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
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

/* ---- Connection Pool Gauge ---- */

function ConnGauge({ active, idle, total, max }: {
  active: number; idle: number; total: number; max: number;
}) {
  const pct = max > 0 ? (total / max) * 100 : 0;
  const color = pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#10b981';
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Connections</p>
        <span className="text-[10px] font-mono text-gray-500">{total} / {max}</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <RingGauge value={pct} color={color} size={64} />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs font-bold text-gray-300">{Math.round(pct)}%</span>
          </div>
        </div>
        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-[10px] text-gray-500">Active</span>
            </div>
            <span className="text-xs font-bold text-white">{active}</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              <span className="text-[10px] text-gray-500">Idle</span>
            </div>
            <span className="text-xs font-bold text-white">{idle}</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-gray-600" />
              <span className="text-[10px] text-gray-500">Other</span>
            </div>
            <span className="text-xs font-bold text-white">{total - active - idle}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Cache Hit Gauge ---- */

function CacheHitGauge({ hit }: { hit: number }) {
  const color = hit >= 99 ? '#10b981' : hit >= 95 ? '#f59e0b' : '#ef4444';
  const label = hit >= 99 ? 'Excellent' : hit >= 95 ? 'Good' : 'Low';
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Cache Hit Ratio</p>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <RingGauge value={hit} color={color} size={64} />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs font-bold text-gray-300">{hit}%</span>
          </div>
        </div>
        <div>
          <p className="text-lg font-bold text-white">{hit}%</p>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
            style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}>
            {label}
          </span>
          <p className="text-[10px] text-gray-600 mt-1.5">Target: 99%+</p>
        </div>
      </div>
    </div>
  );
}

/* ---- Tuple Activity Bar ---- */

function TupleBar({ fetched, inserted, updated, deleted }: {
  fetched: number; inserted: number; updated: number; deleted: number;
}) {
  const total = fetched + inserted + updated + deleted || 1;
  const items = [
    { label: 'Fetched', value: fetched, color: '#3b82f6' },
    { label: 'Inserted', value: inserted, color: '#10b981' },
    { label: 'Updated', value: updated, color: '#f59e0b' },
    { label: 'Deleted', value: deleted, color: '#ef4444' },
  ];
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Tuple Operations</p>
      <div className="flex h-3 rounded-full overflow-hidden mb-3" style={{ background: 'rgba(255,255,255,0.05)' }}>
        {items.filter(i => i.value > 0).map(i => (
          <div key={i.label} className="h-full transition-all duration-700" title={`${i.label}: ${fmtNum(i.value)}`}
            style={{ width: `${(i.value / total) * 100}%`, background: i.color, minWidth: i.value > 0 ? '2px' : 0 }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {items.map(i => (
          <div key={i.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: i.color }} />
            <span className="text-[10px] text-gray-600">{i.label}</span>
            <span className="text-[10px] text-gray-400 font-mono ml-auto">{fmtNum(i.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Database Page ---- */

export default function DatabasesPage() {
  const [dbs, setDbs] = useState<DbWithConn[]>([]);
  const [pgStats, setPgStats] = useState<PgOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [newConn, setNewConn] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', user: '' });

  const fetchDbs = useCallback(async () => {
    const res = await api.get<ManagedDb[]>('/databases');
    if (res.success && res.data) setDbs(res.data);
    setLoading(false);
  }, []);

  const fetchStats = useCallback(async () => {
    const res = await api.get<PgOverview>('/databases/stats');
    if (res.success && res.data) setPgStats(res.data);
    setStatsLoading(false);
  }, []);

  useEffect(() => { fetchDbs(); fetchStats(); }, [fetchDbs, fetchStats]);

  // Auto-refresh stats every 10s
  useEffect(() => {
    const id = setInterval(fetchStats, 10000);
    return () => clearInterval(id);
  }, [fetchStats]);

  async function createDb() {
    setSaving(true); setError('');
    const res = await api.post<DbWithConn>('/databases', form);
    setSaving(false);
    if (res.success && res.data) {
      setNewConn(res.data.connection_string ?? null);
      setShowNew(false);
      setForm({ name: '', user: '' });
      await fetchDbs();
      await fetchStats();
    } else {
      setError(res.error ?? 'Failed to create database');
    }
  }

  async function deleteDb(name: string) {
    if (!confirm(`Delete database "${name}"? This is irreversible.`)) return;
    await api.delete(`/databases/${name}`);
    await fetchDbs();
    await fetchStats();
  }

  // Backup / Restore
  const [downloading, setDownloading] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreSuccess, setRestoreSuccess] = useState('');

  async function downloadBackup(name: string) {
    setDownloading(name);
    try {
      const res = await fetch(`/api/databases/${name}/backup`, { credentials: 'same-origin' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Download failed' }));
        alert(err.error || 'Download failed');
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition');
      const match = disposition?.match(/filename="(.+)"/);
      const filename = match?.[1] || `${name}_backup.sql`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      alert('Failed to download backup');
    } finally {
      setDownloading(null);
    }
  }

  async function restoreDb(name: string, file: File) {
    setRestoring(true);
    setRestoreError('');
    setRestoreSuccess('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/databases/${name}/restore`, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      const data = await res.json();
      if (data.success) {
        const msg = data.data?.message || 'Database restored successfully';
        const warnings = data.data?.warnings;
        setRestoreSuccess(warnings ? `${msg}\n\nWarnings:\n${warnings}` : msg);
        setRestoreTarget(null);
        await fetchStats();
      } else {
        setRestoreError(data.error || 'Restore failed');
      }
    } catch {
      setRestoreError('Failed to upload file');
    } finally {
      setRestoring(false);
    }
  }

  const pg = pgStats;

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Databases</h1>
          <p className="text-sm text-gray-600 mt-1">
            {loading ? 'Loading...' : `${dbs.length} managed database${dbs.length !== 1 ? 's' : ''}`}
            {pg && <span className="text-gray-700"> · PostgreSQL up {pg.uptime}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { fetchStats(); }} className="btn-ghost text-xs py-1.5" title="Refresh stats">
            <RefreshCw size={12} /> Refresh
          </button>
          <button onClick={() => setShowNew(true)} className="btn-primary">
            <Plus size={14} /> New Database
          </button>
        </div>
      </div>

      {/* New connection string banner */}
      {newConn && (
        <div className="mb-6 card animate-slide-up" style={{ borderColor: 'rgba(16,185,129,0.25)', background: 'rgba(16,185,129,0.05)' }}>
          <div className="flex items-start gap-3 mb-3">
            <div className="h-8 w-8 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }}>
              <DbIcon size={15} className="text-emerald-400" />
            </div>
            <div>
              <p className="text-emerald-400 font-semibold text-sm">Database created successfully!</p>
              <p className="text-xs text-gray-500 mt-0.5">Save this connection string now -- the password will not be shown again.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 font-mono text-xs text-gray-300">
            <span className="flex-1 break-all">{newConn}</span>
            <CopyButton text={newConn} />
          </div>
          <button onClick={() => setNewConn(null)} className="btn-ghost mt-3 text-xs">Dismiss</button>
        </div>
      )}

      {/* ---- Monitoring Dashboard ---- */}
      {pg && !statsLoading && (
        <div className="space-y-4 mb-6 animate-slide-up">
          {/* Top stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <MiniCard title="Transactions" value={fmtNum(pg.txCommit)} sub={`${fmtNum(pg.txRollback)} rollbacks`} icon={Zap} color="#8b5cf6" />
            <MiniCard title="Tuples Fetched" value={fmtNum(pg.tupFetched)} sub={`${fmtNum(pg.tupInserted)} inserted`} icon={ArrowDown} color="#3b82f6" />
            <MiniCard title="Deadlocks" value={String(pg.deadlocks)} sub={`${pg.conflicts} conflicts`} icon={AlertTriangle}
              color={pg.deadlocks > 0 ? '#ef4444' : '#10b981'} />
            <MiniCard title="Temp Bytes" value={bytes(pg.tempBytes)} sub="Disk spill from sorts" icon={HardDrive} color="#f59e0b" />
            <MiniCard title="Active Queries" value={String(pg.slowQueries.length)} sub="Running > 100ms" icon={Activity} color="#06b6d4" />
          </div>

          {/* Connection pool + Cache hit + Tuple breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <ConnGauge active={pg.activeConns} idle={pg.idleConns} total={pg.totalConns} max={pg.maxConns} />
            <CacheHitGauge hit={pg.cacheHit} />
            <TupleBar fetched={pg.tupFetched} inserted={pg.tupInserted} updated={pg.tupUpdated} deleted={pg.tupDeleted} />
          </div>

          {/* Per-database stats table */}
          {pg.databases.length > 0 && (
            <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Server size={13} className="text-gray-600" />
                <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Database Details</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      {['Database', 'Size', 'Backends', 'Tx Commit', 'Tx Rollback', 'Cache Hit', 'Fetched', 'Inserted'].map(h => (
                        <th key={h} className="text-[10px] text-gray-700 uppercase font-semibold tracking-wider text-left px-3 py-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pg.databases.map(db => (
                      <tr key={db.name} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-3 py-2">
                          <span className="text-xs text-gray-300 font-medium">{db.name}</span>
                        </td>
                        <td className="px-3 py-2 text-xs font-mono text-gray-400">{bytes(db.size)}</td>
                        <td className="px-3 py-2 text-xs font-mono text-gray-400">{db.numBackends}</td>
                        <td className="px-3 py-2 text-xs font-mono text-gray-400">{fmtNum(db.txCommit)}</td>
                        <td className="px-3 py-2 text-xs font-mono text-gray-400">{fmtNum(db.txRollback)}</td>
                        <td className="px-3 py-2">
                          <span className="text-xs font-mono" style={{ color: db.cacheHit >= 99 ? '#10b981' : db.cacheHit >= 95 ? '#f59e0b' : '#ef4444' }}>
                            {db.cacheHit}%
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs font-mono text-gray-400">{fmtNum(db.tupFetched)}</td>
                        <td className="px-3 py-2 text-xs font-mono text-gray-400">{fmtNum(db.tupInserted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Active/slow queries */}
          {pg.slowQueries.length > 0 && (
            <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Clock size={13} className="text-amber-500" />
                <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Active Queries ({pg.slowQueries.length})</p>
              </div>
              <div className="space-y-2">
                {pg.slowQueries.map(sq => (
                  <div key={sq.pid} className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] font-mono text-gray-600">PID {sq.pid}</span>
                        <span className="text-[10px] text-gray-500">{sq.database}</span>
                        <span className="text-[10px] text-gray-600">{sq.user}</span>
                      </div>
                      <span className="text-xs font-mono font-semibold"
                        style={{ color: sq.duration > 5 ? '#ef4444' : sq.duration > 1 ? '#f59e0b' : '#10b981' }}>
                        {sq.duration.toFixed(1)}s
                      </span>
                    </div>
                    <code className="text-[11px] text-gray-400 font-mono block truncate">{sq.query}</code>
                    {sq.waitEvent && (
                      <span className="text-[10px] text-amber-600 mt-1 inline-block">Wait: {sq.waitEvent}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Connection state breakdown */}
          {pg.connections.length > 0 && (
            <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Users size={13} className="text-gray-600" />
                <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Connection States</p>
              </div>
              <div className="flex flex-wrap gap-3">
                {pg.connections.map(c => {
                  const stateColor: Record<string, string> = {
                    active: '#10b981', idle: '#3b82f6', 'idle in transaction': '#f59e0b',
                    'idle in transaction (aborted)': '#ef4444', disabled: '#6b7280',
                  };
                  const col = stateColor[c.state] || '#6b7280';
                  return (
                    <div key={c.state} className="flex items-center gap-2 rounded-xl px-3 py-2"
                      style={{ background: `${col}08`, border: `1px solid ${col}20` }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: col }} />
                      <span className="text-[11px] text-gray-400">{c.state}</span>
                      <span className="text-xs font-bold text-white ml-1">{c.count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* PG Version footer */}
          <div className="flex items-center gap-3 rounded-xl px-4 py-3 text-[10px] text-gray-700"
            style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)' }}>
            <BarChart3 size={11} className="text-gray-700" />
            <span className="truncate">{pg.version?.split(',')[0] || 'PostgreSQL'}</span>
            <span className="text-gray-800">|</span>
            <span>Uptime: {pg.uptime}</span>
            <span className="text-gray-800">|</span>
            <span>Max connections: {pg.maxConns}</span>
          </div>
        </div>
      )}

      {statsLoading && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="card h-20 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
          ))}
        </div>
      )}

      {/* ---- Managed Databases List ---- */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white">Managed Databases</h2>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="card h-24 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
          ))}
        </div>
      ) : dbs.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center"
          style={{ background: 'rgba(255,255,255,0.01)' }}>
          <div className="h-14 w-14 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
            <DbIcon size={24} className="text-amber-500" />
          </div>
          <p className="text-gray-300 font-semibold mb-1">No managed databases</p>
          <p className="text-gray-600 text-sm mb-5">Create a PostgreSQL database for your application</p>
          <button onClick={() => setShowNew(true)} className="btn-primary">
            <Plus size={14} /> Create Database
          </button>
        </div>
      ) : (
        <div className="space-y-3 animate-slide-up">
          {dbs.map((db) => {
            // Find matching stats
            const dbStat = pg?.databases.find(d => d.name === db.name);
            return (
              <div key={db.id} className="card hover:border-white/[0.1] transition-all duration-200 group"
                style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4 min-w-0 flex-1">
                    <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
                      style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
                      <DbIcon size={17} className="text-amber-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link to={`/databases/${db.name}`}
                          className="font-semibold text-white text-sm hover:text-amber-400 transition-colors flex items-center gap-1.5">
                          {db.name} <ExternalLink size={11} className="text-gray-600 group-hover:text-amber-400/60" />
                        </Link>
                        <span className="badge-yellow">PostgreSQL</span>
                        {dbStat && (
                          <span className="text-[10px] text-gray-600 font-mono">{bytes(dbStat.size)}</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5">
                        User: <code className="text-gray-500 font-mono">{db.db_user}</code>
                        {dbStat && (
                          <span className="ml-3 text-gray-700">
                            {dbStat.numBackends} conn · {dbStat.cacheHit}% cache hit
                          </span>
                        )}
                      </p>
                      <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                        <code className="text-xs text-gray-500 font-mono flex-1 truncate">
                          postgresql://{db.db_user}:{'*'.repeat(12)}@localhost:5432/{db.name}
                        </code>
                        <CopyButton text={`postgresql://${db.db_user}:***@localhost:5432/${db.name}`} />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-all">
                    <button onClick={() => downloadBackup(db.name)}
                      disabled={downloading === db.name}
                      className="p-2 rounded-xl text-gray-700 hover:text-blue-400 hover:bg-blue-500/10 transition-all"
                      title="Download backup">
                      {downloading === db.name
                        ? <span className="h-3.5 w-3.5 rounded-full border-2 border-blue-400/30 border-t-blue-400 animate-spin block" />
                        : <Download size={15} />}
                    </button>
                    <button onClick={() => { setRestoreTarget(db.name); setRestoreError(''); setRestoreSuccess(''); }}
                      className="p-2 rounded-xl text-gray-700 hover:text-amber-400 hover:bg-amber-500/10 transition-all"
                      title="Restore from backup">
                      <Upload size={15} />
                    </button>
                    <button onClick={() => deleteDb(db.name)}
                      className="p-2 rounded-xl text-gray-700 hover:text-red-400 hover:bg-red-500/10 transition-all"
                      title="Delete database">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Restore Success Banner */}
      {restoreSuccess && (
        <div className="mt-4 card animate-slide-up" style={{ borderColor: 'rgba(16,185,129,0.25)', background: 'rgba(16,185,129,0.05)' }}>
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }}>
              <Upload size={15} className="text-emerald-400" />
            </div>
            <pre className="text-emerald-400 font-semibold text-sm flex-1 whitespace-pre-wrap font-sans">{restoreSuccess}</pre>
            <button onClick={() => setRestoreSuccess('')} className="btn-ghost text-xs">Dismiss</button>
          </div>
        </div>
      )}

      {/* Restore Modal */}
      {restoreTarget && (
        <Modal title={`Restore "${restoreTarget}"`} onClose={() => { setRestoreTarget(null); setRestoreError(''); }}>
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-400">
              This will execute the SQL file against the database. Existing data may be overwritten or duplicated. Consider downloading a backup first.
            </div>
            <div>
              <label className="label">SQL Dump File</label>
              <input
                type="file"
                accept=".sql,.dump,.bak,.backup"
                className="block w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border file:border-white/10 file:text-sm file:font-medium file:bg-white/5 file:text-gray-300 hover:file:bg-white/10 file:cursor-pointer file:transition-all"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && restoreTarget) {
                    restoreDb(restoreTarget, file);
                  }
                }}
                disabled={restoring}
              />
              <p className="text-xs text-gray-600 mt-1.5">Upload a .sql dump file (from pg_dump or the Download button)</p>
            </div>
            {restoring && (
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Restoring database, this may take a while...
              </div>
            )}
            {restoreError && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">
                <p className="font-semibold mb-1">Restore failed</p>
                <pre className="whitespace-pre-wrap text-xs text-red-400/80 font-mono max-h-48 overflow-auto">{restoreError}</pre>
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => { setRestoreTarget(null); setRestoreError(''); }}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Create Modal */}
      {showNew && (
        <Modal title="Create Database" onClose={() => { setShowNew(false); setError(''); }}>
          <div className="space-y-4">
            <div>
              <label className="label">Database Name</label>
              <input className="input" placeholder="myapp_production"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
              <p className="text-xs text-gray-600 mt-1.5">Lowercase letters, numbers and underscores</p>
            </div>
            <div>
              <label className="label">Database User</label>
              <input className="input" placeholder="myapp_user"
                value={form.user}
                onChange={(e) => setForm({ ...form, user: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-xs text-gray-500">
              A strong random password will be generated automatically.
            </div>
            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">{error}</div>
            )}
            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => { setShowNew(false); setError(''); }}>Cancel</button>
              <button className="btn-primary" onClick={createDb} disabled={saving || !form.name || !form.user}>
                {saving ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Creating...
                  </span>
                ) : (
                  <><DbIcon size={13} /> Create</>
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Shell>
  );
}
