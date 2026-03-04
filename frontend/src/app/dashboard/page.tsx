'use client';
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, RotateCcw, Square, Trash2, Server } from 'lucide-react';
import Shell from '@/components/Shell';
import StatusBadge from '@/components/StatusBadge';
import { api, App } from '@/lib/api';

export default function DashboardPage() {
  const [apps,    setApps]    = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting,  setActing]  = useState<string | null>(null);

  const fetchApps = useCallback(async () => {
    const res = await api.get<App[]>('/apps');
    if (res.success && res.data) setApps(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  async function doAction(name: string, action: string) {
    setActing(name + action);
    await api.post(`/apps/${name}/action`, { action });
    await fetchApps();
    setActing(null);
  }

  const mem = (bytes: number) =>
    bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '—';

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-400 mt-1">{apps.length} app{apps.length !== 1 ? 's' : ''} deployed</p>
        </div>
        <button onClick={() => { setLoading(true); fetchApps(); }} className="btn-ghost">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : apps.length === 0 ? (
        <div className="card flex flex-col items-center py-16 text-center">
          <Server size={48} className="text-gray-700 mb-4" />
          <p className="text-gray-400">No apps deployed yet.</p>
          <a href="/apps" className="btn-primary mt-4">Deploy your first app</a>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">App</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Domain</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Port</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">CPU</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Memory</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.id} className="border-b border-gray-800/50 bg-gray-900 hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 font-medium text-white">{app.name}</td>
                  <td className="px-4 py-3"><StatusBadge status={app.status} /></td>
                  <td className="px-4 py-3 text-gray-300">
                    {app.domain
                      ? <a href={`http${app.ssl_enabled ? 's' : ''}://${app.domain}`} target="_blank" rel="noreferrer" className="hover:text-brand-500 underline">{app.domain}</a>
                      : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300">{app.port}</td>
                  <td className="px-4 py-3 text-gray-300">{app.cpu}%</td>
                  <td className="px-4 py-3 text-gray-300">{mem(app.memory)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => doAction(app.name, 'restart')}
                        disabled={!!acting}
                        title="Restart"
                        className="btn-ghost p-1.5 text-xs"
                      >
                        <RotateCcw size={14} className={acting === app.name + 'restart' ? 'animate-spin' : ''} />
                      </button>
                      <button
                        onClick={() => doAction(app.name, app.status === 'online' ? 'stop' : 'start')}
                        disabled={!!acting}
                        title={app.status === 'online' ? 'Stop' : 'Start'}
                        className="btn-ghost p-1.5 text-xs"
                      >
                        <Square size={14} />
                      </button>
                      <button
                        onClick={() => { if (confirm(`Delete ${app.name}?`)) doAction(app.name, 'delete'); }}
                        disabled={!!acting}
                        title="Delete"
                        className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
