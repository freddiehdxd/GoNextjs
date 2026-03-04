'use client';
import { useEffect, useState, useCallback } from 'react';
import { Plus, RotateCcw, ExternalLink, Settings2, ChevronDown, ChevronUp } from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import StatusBadge from '@/components/StatusBadge';
import { api, App } from '@/lib/api';

type EnvEntry = { key: string; value: string };

export default function AppsPage() {
  const [apps,    setApps]    = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [acting,   setActing]   = useState<string | null>(null);
  const [error,    setError]    = useState('');
  const [form, setForm] = useState({ name: '', repo_url: '', branch: 'main' });
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([{ key: '', value: '' }]);

  const fetchApps = useCallback(async () => {
    const res = await api.get<App[]>('/apps');
    if (res.success && res.data) setApps(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  async function deployApp() {
    setActing('deploy'); setError('');
    const env_vars = Object.fromEntries(
      envEntries.filter((e) => e.key).map((e) => [e.key, e.value])
    );
    const res = await api.post<App>('/apps', { ...form, env_vars });
    setActing(null);
    if (res.success) {
      setShowNew(false);
      setForm({ name: '', repo_url: '', branch: 'main' });
      setEnvEntries([{ key: '', value: '' }]);
      await fetchApps();
    } else {
      setError(res.error ?? 'Deploy failed');
    }
  }

  async function doAction(name: string, action: string) {
    setActing(name + action);
    await api.post(`/apps/${name}/action`, { action });
    await fetchApps();
    setActing(null);
  }

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-white">Apps</h1>
        <button onClick={() => setShowNew(true)} className="btn-primary">
          <Plus size={14} /> New App
        </button>
      </div>

      {loading ? <p className="text-gray-500">Loading…</p> : (
        <div className="space-y-3">
          {apps.map((app) => (
            <div key={app.id} className="card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <StatusBadge status={app.status} />
                  <span className="font-semibold text-white">{app.name}</span>
                  <span className="text-gray-500 text-xs">:{app.port}</span>
                  {app.domain && (
                    <a href={`http${app.ssl_enabled ? 's' : ''}://${app.domain}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-brand-500 text-xs hover:underline">
                      {app.domain} <ExternalLink size={10} />
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => doAction(app.name, 'restart')} className="btn-ghost" disabled={!!acting}>
                    <RotateCcw size={13} className={acting === app.name + 'restart' ? 'animate-spin' : ''} /> Restart
                  </button>
                  <button onClick={() => doAction(app.name, 'rebuild')} className="btn-ghost" disabled={!!acting}>
                    Rebuild
                  </button>
                  <button onClick={() => setExpanded(expanded === app.id ? null : app.id)} className="btn-ghost">
                    <Settings2 size={13} />
                    {expanded === app.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                </div>
              </div>

              {expanded === app.id && (
                <div className="mt-4 pt-4 border-t border-gray-800 space-y-3">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="label">Repository</p>
                      <p className="text-gray-300 font-mono text-xs">{app.repo_url}</p>
                    </div>
                    <div>
                      <p className="label">Branch</p>
                      <p className="text-gray-300">{app.branch}</p>
                    </div>
                  </div>
                  <div>
                    <p className="label mb-2">Environment Variables</p>
                    <EnvEditor appName={app.name} initial={app.env_vars} onSaved={fetchApps} />
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button onClick={() => doAction(app.name, app.status === 'online' ? 'stop' : 'start')} className="btn-ghost" disabled={!!acting}>
                      {app.status === 'online' ? 'Stop' : 'Start'}
                    </button>
                    <button onClick={() => { if (confirm(`Delete ${app.name}?`)) doAction(app.name, 'delete'); }} className="btn-danger" disabled={!!acting}>
                      Delete App
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <Modal title="Deploy New App" onClose={() => { setShowNew(false); setError(''); }}>
          <div className="space-y-4">
            <div>
              <label className="label">App Name</label>
              <input className="input" placeholder="my-app" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <p className="text-xs text-gray-500 mt-1">Lowercase, numbers and hyphens only</p>
            </div>
            <div>
              <label className="label">Git Repository URL</label>
              <input className="input" placeholder="https://github.com/user/repo.git" value={form.repo_url} onChange={(e) => setForm({ ...form, repo_url: e.target.value })} />
            </div>
            <div>
              <label className="label">Branch</label>
              <input className="input" placeholder="main" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
            </div>
            <div>
              <label className="label">Environment Variables</label>
              {envEntries.map((entry, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input className="input w-5/12" placeholder="KEY" value={entry.key}
                    onChange={(e) => { const n = [...envEntries]; n[i] = { ...n[i], key: e.target.value }; setEnvEntries(n); }} />
                  <input className="input flex-1" placeholder="value" value={entry.value}
                    onChange={(e) => { const n = [...envEntries]; n[i] = { ...n[i], value: e.target.value }; setEnvEntries(n); }} />
                </div>
              ))}
              <button onClick={() => setEnvEntries([...envEntries, { key: '', value: '' }])} className="btn-ghost text-xs">
                <Plus size={12} /> Add variable
              </button>
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex gap-3 justify-end pt-2">
              <button className="btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
              <button className="btn-primary" onClick={deployApp} disabled={acting === 'deploy' || !form.name || !form.repo_url}>
                {acting === 'deploy' ? 'Deploying…' : 'Deploy'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

function EnvEditor({ appName, initial, onSaved }: { appName: string; initial: Record<string, string>; onSaved: () => void }) {
  const [entries, setEntries] = useState<EnvEntry[]>(
    Object.entries(initial).length > 0
      ? Object.entries(initial).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }]
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const env_vars = Object.fromEntries(entries.filter((e) => e.key).map((e) => [e.key, e.value]));
    await api.put(`/apps/${appName}/env`, { env_vars });
    setSaving(false);
    onSaved();
  }

  return (
    <div className="space-y-2">
      {entries.map((entry, i) => (
        <div key={i} className="flex gap-2">
          <input className="input w-5/12 font-mono text-xs" placeholder="KEY" value={entry.key}
            onChange={(e) => { const n = [...entries]; n[i] = { ...n[i], key: e.target.value }; setEntries(n); }} />
          <input className="input flex-1 font-mono text-xs" placeholder="value" value={entry.value}
            onChange={(e) => { const n = [...entries]; n[i] = { ...n[i], value: e.target.value }; setEntries(n); }} />
        </div>
      ))}
      <div className="flex gap-2">
        <button onClick={() => setEntries([...entries, { key: '', value: '' }])} className="btn-ghost text-xs">
          <Plus size={12} /> Add
        </button>
        <button onClick={save} className="btn-primary text-xs" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
