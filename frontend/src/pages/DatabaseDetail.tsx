import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Database as DbIcon, Copy, Check, Activity, Clock,
  Table2, Layers, Lock, AlertTriangle, HardDrive, Zap, RefreshCw,
  Server, BarChart3, Search,
} from 'lucide-react';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

/* ---- Types ---- */

interface PgSlowQuery {
  pid: number; database: string; user: string;
  duration: number; state: string; query: string; waitEvent: string;
}

interface PgConnInfo { state: string; count: number; }

interface PgTableInfo {
  schema: string; name: string; size: number; sizeHuman: string;
  totalSize: number; totalHuman: string; rowEstimate: number;
  seqScan: number; seqTupRead: number; idxScan: number; idxTupFetch: number;
  insertCount: number; updateCount: number; deleteCount: number;
  liveTup: number; deadTup: number;
  lastVacuum: string | null; lastAnalyze: string | null;
}

interface PgIndexInfo {
  schema: string; table: string; name: string;
  size: number; sizeHuman: string;
  idxScan: number; idxTupRead: number; idxTupFetch: number;
  unused: boolean;
}

interface PgStatStatement {
  query: string; calls: number;
  totalTime: number; meanTime: number; minTime: number; maxTime: number;
  rows: number; sharedBlksHit: number; sharedBlksRead: number;
}

interface PgLockInfo {
  pid: number; mode: string; lockType: string; relation: string;
  granted: boolean; waitStart: string; query: string;
}

interface DbDetail {
  name: string; owner: string; encoding: string; collation: string;
  size: number; sizeHuman: string; created_at: string;
  numBackends: number;
  txCommit: number; txRollback: number; cacheHit: number;
  blksRead: number; blksHit: number;
  tupFetched: number; tupReturned: number; tupInserted: number;
  tupUpdated: number; tupDeleted: number;
  conflicts: number; deadlocks: number; tempFiles: number; tempBytes: number;
  connectionString: string;
  tables: PgTableInfo[];
  indexes: PgIndexInfo[];
  activeQueries: PgSlowQuery[];
  connections: PgConnInfo[];
  slowQueries: PgStatStatement[];
  locks: PgLockInfo[];
}

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

function fmtMs(ms: number): string {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'min';
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
  return ms.toFixed(1) + 'ms';
}

type Tab = 'overview' | 'tables' | 'indexes' | 'queries' | 'locks';

/* ---- Components ---- */

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1.5 rounded-lg text-gray-600 hover:text-violet-400 hover:bg-violet-500/10 transition-all" title="Copy">
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
    </button>
  );
}

function StatCard({ label, value, sub, color, icon }: {
  label: string; value: string; sub?: string; color: string; icon: React.ReactNode;
}) {
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5">{label}</p>
          <p className="text-xl font-bold text-white leading-none">{value}</p>
          {sub && <p className="text-[11px] text-gray-600 mt-1">{sub}</p>}
        </div>
        <div className="h-9 w-9 flex items-center justify-center rounded-xl shrink-0"
          style={{ background: `${color}12`, border: `1px solid ${color}22` }}>
          <span style={{ color }}>{icon}</span>
        </div>
      </div>
    </div>
  );
}

/* ---- Main Page ---- */

export default function DatabaseDetail() {
  const { name } = useParams<{ name: string }>();
  const [detail, setDetail] = useState<DbDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [tableSearch, setTableSearch] = useState('');
  const [indexSearch, setIndexSearch] = useState('');
  const [querySearch, setQuerySearch] = useState('');

  const fetchDetail = useCallback(async () => {
    if (!name) return;
    const res = await api.get<DbDetail>(`/databases/${name}/detail`);
    if (res.success && res.data) setDetail(res.data);
    setLoading(false);
  }, [name]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // Auto-refresh every 10s
  useEffect(() => {
    const iv = setInterval(fetchDetail, 10000);
    return () => clearInterval(iv);
  }, [fetchDetail]);

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-32">
          <span className="h-6 w-6 rounded-full border-2 border-amber-500/30 border-t-amber-500 animate-spin" />
        </div>
      </Shell>
    );
  }

  if (!detail) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <DbIcon size={40} className="text-gray-700 mb-4" />
          <p className="text-gray-400 font-semibold mb-2">Database not found</p>
          <Link to="/databases" className="text-amber-400 hover:text-amber-300 text-sm">Back to Databases</Link>
        </div>
      </Shell>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'overview', label: 'Overview', icon: <Activity size={14} /> },
    { id: 'tables', label: 'Tables', icon: <Table2 size={14} />, count: detail.tables.length },
    { id: 'indexes', label: 'Indexes', icon: <Layers size={14} />, count: detail.indexes.length },
    { id: 'queries', label: 'Queries', icon: <Clock size={14} />, count: detail.slowQueries.length + detail.activeQueries.length },
    { id: 'locks', label: 'Locks', icon: <Lock size={14} />, count: detail.locks.length },
  ];

  const cacheColor = detail.cacheHit >= 99 ? '#10b981' : detail.cacheHit >= 95 ? '#f59e0b' : '#ef4444';

  return (
    <Shell>
      {/* Header */}
      <div className="mb-6">
        <Link to="/databases" className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-400 transition-colors mb-4">
          <ArrowLeft size={12} /> Back to Databases
        </Link>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
              <DbIcon size={20} className="text-amber-500" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-white">{detail.name}</h1>
                <span className="badge-yellow">PostgreSQL</span>
                <span className="text-xs text-gray-500 font-mono">{detail.sizeHuman}</span>
              </div>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-xs text-gray-600">Owner: <code className="text-gray-500 font-mono">{detail.owner}</code></span>
                <span className="text-xs text-gray-600">{detail.encoding}</span>
                <span className="text-xs text-gray-600">{detail.numBackends} connection{detail.numBackends !== 1 ? 's' : ''}</span>
              </div>
            </div>
          </div>
          <button onClick={fetchDetail} className="btn-ghost text-xs">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {/* Connection String */}
      <div className="card mb-6" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
          <Server size={12} className="text-gray-600 shrink-0" />
          <code className="text-xs text-gray-400 font-mono flex-1 truncate">{detail.connectionString}</code>
          <CopyBtn text={detail.connectionString} />
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 border-b border-white/[0.06] mb-6">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all duration-200 -mb-px
              ${tab === t.id
                ? 'text-amber-400 border-amber-500'
                : 'text-gray-500 border-transparent hover:text-gray-300 hover:border-white/10'}`}>
            {t.icon} {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded-full font-mono">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="animate-fade-in">
        {tab === 'overview' && <OverviewContent detail={detail} cacheColor={cacheColor} />}
        {tab === 'tables' && <TablesContent tables={detail.tables} search={tableSearch} setSearch={setTableSearch} />}
        {tab === 'indexes' && <IndexesContent indexes={detail.indexes} search={indexSearch} setSearch={setIndexSearch} />}
        {tab === 'queries' && <QueriesContent detail={detail} search={querySearch} setSearch={setQuerySearch} />}
        {tab === 'locks' && <LocksContent locks={detail.locks} />}
      </div>
    </Shell>
  );
}

/* ─────────────────────── Overview Tab ─────────────────────── */

function OverviewContent({ detail, cacheColor }: { detail: DbDetail; cacheColor: string }) {
  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Size" value={detail.sizeHuman} icon={<HardDrive size={16} />} color="#f59e0b" />
        <StatCard label="Cache Hit" value={`${detail.cacheHit}%`}
          sub={detail.cacheHit >= 99 ? 'Excellent' : detail.cacheHit >= 95 ? 'Good' : 'Needs tuning'}
          icon={<Zap size={16} />} color={cacheColor} />
        <StatCard label="Transactions" value={fmtNum(detail.txCommit)}
          sub={`${fmtNum(detail.txRollback)} rollbacks`}
          icon={<Activity size={16} />} color="#8b5cf6" />
        <StatCard label="Connections" value={String(detail.numBackends)}
          icon={<Server size={16} />} color="#3b82f6" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Deadlocks" value={String(detail.deadlocks)}
          sub={`${detail.conflicts} conflicts`}
          icon={<AlertTriangle size={16} />} color={detail.deadlocks > 0 ? '#ef4444' : '#10b981'} />
        <StatCard label="Temp Files" value={String(detail.tempFiles)}
          sub={bytes(detail.tempBytes) + ' on disk'}
          icon={<HardDrive size={16} />} color="#f59e0b" />
        <StatCard label="Tables" value={String(detail.tables.length)}
          icon={<Table2 size={16} />} color="#06b6d4" />
        <StatCard label="Indexes" value={String(detail.indexes.length)}
          sub={`${detail.indexes.filter(i => i.unused).length} unused`}
          icon={<Layers size={16} />} color="#8b5cf6" />
      </div>

      {/* Tuple operations */}
      <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Tuple Operations</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {[
            { label: 'Fetched', value: detail.tupFetched, color: '#3b82f6' },
            { label: 'Returned', value: detail.tupReturned, color: '#06b6d4' },
            { label: 'Inserted', value: detail.tupInserted, color: '#10b981' },
            { label: 'Updated', value: detail.tupUpdated, color: '#f59e0b' },
            { label: 'Deleted', value: detail.tupDeleted, color: '#ef4444' },
          ].map(i => (
            <div key={i.label} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: i.color }} />
              <div>
                <p className="text-xs font-bold text-white">{fmtNum(i.value)}</p>
                <p className="text-[10px] text-gray-600">{i.label}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Block I/O */}
      <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Block I/O</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500 mb-1">Blocks Hit (from cache)</p>
            <p className="text-lg font-bold text-white">{fmtNum(detail.blksHit)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Blocks Read (from disk)</p>
            <p className="text-lg font-bold text-white">{fmtNum(detail.blksRead)}</p>
          </div>
        </div>
      </div>

      {/* Connection states */}
      {detail.connections.length > 0 && (
        <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Connection States</p>
          <div className="flex flex-wrap gap-3">
            {detail.connections.map(c => {
              const stateColor: Record<string, string> = {
                active: '#10b981', idle: '#3b82f6', 'idle in transaction': '#f59e0b',
                'idle in transaction (aborted)': '#ef4444',
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

      {/* Database info */}
      <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Database Info</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-[10px] text-gray-700 uppercase tracking-wider mb-0.5">Encoding</p>
            <p className="text-sm text-gray-300">{detail.encoding}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-700 uppercase tracking-wider mb-0.5">Collation</p>
            <p className="text-sm text-gray-300 font-mono text-xs">{detail.collation}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-700 uppercase tracking-wider mb-0.5">Owner</p>
            <p className="text-sm text-gray-300 font-mono text-xs">{detail.owner}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-700 uppercase tracking-wider mb-0.5">Size</p>
            <p className="text-sm text-gray-300">{detail.sizeHuman}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── Tables Tab ─────────────────────── */

function TablesContent({ tables, search, setSearch }: {
  tables: PgTableInfo[]; search: string; setSearch: (s: string) => void;
}) {
  const filtered = tables.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.schema.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">{filtered.length} table{filtered.length !== 1 ? 's' : ''}</p>
        <div className="relative">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
          <input className="input !pl-8 !py-1.5 text-xs !w-56" placeholder="Filter tables..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card py-12 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <Table2 size={24} className="text-gray-700 mx-auto mb-2" />
          <p className="text-sm text-gray-500">{search ? 'No tables match your filter' : 'No tables found'}</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {['Table', 'Rows', 'Size', 'Total', 'Seq Scan', 'Idx Scan', 'Dead Tuples', 'Last Vacuum'].map(h => (
                    <th key={h} className="text-[10px] text-gray-700 uppercase font-semibold tracking-wider text-left px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={`${t.schema}.${t.name}`} className="hover:bg-white/[0.02] transition-colors border-b border-white/[0.03] last:border-0">
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-300 font-medium">{t.name}</span>
                      {t.schema !== 'public' && <span className="text-[10px] text-gray-600 ml-1.5">{t.schema}</span>}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{fmtNum(t.rowEstimate)}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{t.sizeHuman}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{t.totalHuman}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{fmtNum(t.seqScan)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-mono ${t.idxScan === 0 && t.seqScan > 100 ? 'text-amber-400' : 'text-gray-400'}`}>
                        {fmtNum(t.idxScan)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-mono ${t.deadTup > 1000 ? 'text-amber-400' : 'text-gray-400'}`}>
                        {fmtNum(t.deadTup)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{t.lastVacuum || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Indexes Tab ─────────────────────── */

function IndexesContent({ indexes, search, setSearch }: {
  indexes: PgIndexInfo[]; search: string; setSearch: (s: string) => void;
}) {
  const filtered = indexes.filter(i =>
    !search || i.name.toLowerCase().includes(search.toLowerCase()) || i.table.toLowerCase().includes(search.toLowerCase())
  );
  const unusedCount = filtered.filter(i => i.unused).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-400">{filtered.length} index{filtered.length !== 1 ? 'es' : ''}</p>
          {unusedCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
              {unusedCount} unused
            </span>
          )}
        </div>
        <div className="relative">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
          <input className="input !pl-8 !py-1.5 text-xs !w-56" placeholder="Filter indexes..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card py-12 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <Layers size={24} className="text-gray-700 mx-auto mb-2" />
          <p className="text-sm text-gray-500">{search ? 'No indexes match your filter' : 'No indexes found'}</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {['Index', 'Table', 'Size', 'Scans', 'Tuples Read', 'Tuples Fetched', 'Status'].map(h => (
                    <th key={h} className="text-[10px] text-gray-700 uppercase font-semibold tracking-wider text-left px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(idx => (
                  <tr key={`${idx.schema}.${idx.name}`}
                    className={`hover:bg-white/[0.02] transition-colors border-b border-white/[0.03] last:border-0
                      ${idx.unused ? 'bg-amber-500/[0.02]' : ''}`}>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-300 font-medium font-mono">{idx.name}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{idx.table}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{idx.sizeHuman}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{fmtNum(idx.idxScan)}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{fmtNum(idx.idxTupRead)}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{fmtNum(idx.idxTupFetch)}</td>
                    <td className="px-4 py-3">
                      {idx.unused ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">Unused</span>
                      ) : (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Active</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Queries Tab ─────────────────────── */

function QueriesContent({ detail, search, setSearch }: {
  detail: DbDetail; search: string; setSearch: (s: string) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Active queries */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Activity size={13} className="text-emerald-500" />
          <p className="text-sm font-semibold text-white">Active Queries</p>
          <span className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded-full font-mono text-gray-400">
            {detail.activeQueries.length}
          </span>
        </div>
        {detail.activeQueries.length === 0 ? (
          <div className="card py-8 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-xs text-gray-500">No active queries running</p>
          </div>
        ) : (
          <div className="space-y-2">
            {detail.activeQueries.map(sq => (
              <div key={sq.pid} className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-mono text-gray-600">PID {sq.pid}</span>
                    <span className="text-[10px] text-gray-500">{sq.user}</span>
                    {sq.waitEvent && (
                      <span className="text-[10px] text-amber-500">Wait: {sq.waitEvent}</span>
                    )}
                  </div>
                  <span className="text-xs font-mono font-semibold"
                    style={{ color: sq.duration > 5 ? '#ef4444' : sq.duration > 1 ? '#f59e0b' : '#10b981' }}>
                    {sq.duration.toFixed(1)}s
                  </span>
                </div>
                <code className="text-[11px] text-gray-400 font-mono block whitespace-pre-wrap break-all">{sq.query}</code>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Slow queries (from pg_stat_statements) */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Clock size={13} className="text-amber-500" />
            <p className="text-sm font-semibold text-white">Slowest Queries</p>
            <span className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded-full font-mono text-gray-400">
              {detail.slowQueries.length}
            </span>
            <span className="text-[10px] text-gray-600">(from pg_stat_statements, sorted by mean time)</span>
          </div>
          <div className="relative">
            <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
            <input className="input !pl-8 !py-1.5 text-xs !w-56" placeholder="Filter queries..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {detail.slowQueries.length === 0 ? (
          <div className="card py-8 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <BarChart3 size={24} className="text-gray-700 mx-auto mb-2" />
            <p className="text-xs text-gray-500">No query statistics available</p>
            <p className="text-[10px] text-gray-700 mt-1">Enable pg_stat_statements extension for query performance tracking</p>
          </div>
        ) : (
          <div className="card p-0 overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    {['Query', 'Calls', 'Mean', 'Max', 'Total', 'Rows/call', 'Hit%'].map(h => (
                      <th key={h} className="text-[10px] text-gray-700 uppercase font-semibold tracking-wider text-left px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.slowQueries
                    .filter(s => !search || s.query.toLowerCase().includes(search.toLowerCase()))
                    .map((s, i) => {
                      const hitPct = s.sharedBlksHit + s.sharedBlksRead > 0
                        ? ((s.sharedBlksHit / (s.sharedBlksHit + s.sharedBlksRead)) * 100)
                        : 100;
                      return (
                        <tr key={i} className="hover:bg-white/[0.02] transition-colors border-b border-white/[0.03] last:border-0 align-top">
                          <td className="px-4 py-3 max-w-xs">
                            <code className="text-[11px] text-gray-400 font-mono block truncate" title={s.query}>
                              {s.query}
                            </code>
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-gray-400">{fmtNum(s.calls)}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs font-mono font-semibold ${s.meanTime > 1000 ? 'text-red-400' : s.meanTime > 100 ? 'text-amber-400' : 'text-gray-400'}`}>
                              {fmtMs(s.meanTime)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-gray-500">{fmtMs(s.maxTime)}</td>
                          <td className="px-4 py-3 text-xs font-mono text-gray-500">{fmtMs(s.totalTime)}</td>
                          <td className="px-4 py-3 text-xs font-mono text-gray-400">{s.calls > 0 ? fmtNum(Math.round(s.rows / s.calls)) : '0'}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs font-mono ${hitPct >= 99 ? 'text-emerald-400' : hitPct >= 90 ? 'text-amber-400' : 'text-red-400'}`}>
                              {hitPct.toFixed(0)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── Locks Tab ─────────────────────── */

function LocksContent({ locks }: { locks: PgLockInfo[] }) {
  const waiting = locks.filter(l => !l.granted);
  const granted = locks.filter(l => l.granted);

  return (
    <div className="space-y-4">
      {waiting.length > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-4 py-3 flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-400" />
          <span className="text-sm text-amber-400">{waiting.length} lock{waiting.length !== 1 ? 's' : ''} waiting to be granted</span>
        </div>
      )}

      {locks.length === 0 ? (
        <div className="card py-12 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <Lock size={24} className="text-gray-700 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No active locks</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {['PID', 'Type', 'Mode', 'Relation', 'Granted', 'Query'].map(h => (
                    <th key={h} className="text-[10px] text-gray-700 uppercase font-semibold tracking-wider text-left px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {locks.map((lk, i) => (
                  <tr key={i} className={`hover:bg-white/[0.02] transition-colors border-b border-white/[0.03] last:border-0
                    ${!lk.granted ? 'bg-amber-500/[0.02]' : ''}`}>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{lk.pid}</td>
                    <td className="px-4 py-3 text-xs text-gray-400">{lk.lockType}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        lk.mode.includes('Exclusive')
                          ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                          : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                      }`}>{lk.mode.replace('Lock', '')}</span>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-400">{lk.relation || '--'}</td>
                    <td className="px-4 py-3">
                      {lk.granted ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Yes</span>
                      ) : (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">Waiting</span>
                      )}
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <code className="text-[11px] text-gray-500 font-mono truncate block">{lk.query || '--'}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
