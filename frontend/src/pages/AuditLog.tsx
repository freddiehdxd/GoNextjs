import { useEffect, useState, useCallback } from 'react';
import { FileText, Search, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

interface AuditEntry {
  id: number;
  username: string;
  ip: string;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  body: string;
  created_at: string;
}

const METHOD_COLORS: Record<string, string> = {
  POST: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  PUT: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  DELETE: 'bg-red-500/10 text-red-400 border-red-500/20',
  PATCH: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
};

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('');
  const limit = 25;

  const fetchAudit = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (method) params.set('method', method);
    if (search) params.set('search', search);

    const res = await api.get<{ entries: AuditEntry[]; total: number }>(`/audit?${params}`);
    if (res.success && res.data) {
      setEntries(res.data.entries || []);
      setTotal(res.data.total || 0);
    }
    setLoading(false);
  }, [page, method, search]);

  useEffect(() => { fetchAudit(); }, [fetchAudit]);

  const totalPages = Math.ceil(total / limit);

  function statusColor(code: number) {
    if (code >= 200 && code < 300) return 'text-emerald-400';
    if (code >= 300 && code < 400) return 'text-blue-400';
    if (code >= 400 && code < 500) return 'text-amber-400';
    return 'text-red-400';
  }

  function timeAgo(ts: string) {
    const d = new Date(ts);
    const now = new Date();
    const diff = (now.getTime() - d.getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Audit Log</h1>
          <p className="text-sm text-gray-500 mt-1">
            {total} entries{method ? ` (${method} only)` : ''}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
          <input
            className="input pl-9"
            placeholder="Search paths or users..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter size={13} className="text-gray-600" />
          {['', 'POST', 'PUT', 'DELETE'].map((m) => (
            <button
              key={m}
              onClick={() => { setMethod(m); setPage(1); }}
              className={`px-3 py-2 rounded-xl text-xs font-medium transition-all border ${
                method === m
                  ? 'bg-violet-500/10 text-violet-400 border-violet-500/30'
                  : 'text-gray-500 border-white/8 hover:border-white/15 hover:text-gray-300'
              }`}
            >
              {m || 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="table-wrapper">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Time</th>
              <th className="th">User</th>
              <th className="th">Method</th>
              <th className="th">Path</th>
              <th className="th">Status</th>
              <th className="th">Duration</th>
              <th className="th">IP</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i} className="tr">
                  {[...Array(7)].map((_, j) => (
                    <td key={j} className="td"><div className="h-3 rounded bg-white/5 shimmer w-16" /></td>
                  ))}
                </tr>
              ))
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={7} className="td text-center py-16">
                  <FileText size={24} className="mx-auto mb-3 text-gray-700" />
                  <p className="text-gray-500 text-sm">No audit entries found</p>
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id} className="tr">
                  <td className="td text-xs text-gray-500 whitespace-nowrap" title={new Date(e.created_at).toLocaleString()}>
                    {timeAgo(e.created_at)}
                  </td>
                  <td className="td text-sm text-gray-300">{e.username}</td>
                  <td className="td">
                    <span className={`badge text-[10px] ${METHOD_COLORS[e.method] || 'badge-gray'}`}>
                      {e.method}
                    </span>
                  </td>
                  <td className="td font-mono text-xs text-gray-400 max-w-[300px] truncate">{e.path}</td>
                  <td className={`td text-sm font-medium ${statusColor(e.status_code)}`}>{e.status_code}</td>
                  <td className="td text-xs text-gray-500">{e.duration_ms}ms</td>
                  <td className="td text-xs text-gray-600 font-mono">{e.ip}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-5">
          <p className="text-xs text-gray-600">
            Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="btn-ghost p-2"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-gray-400 px-3">
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="btn-ghost p-2"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </Shell>
  );
}
