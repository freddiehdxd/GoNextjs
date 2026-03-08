import { useEffect, useState, useCallback } from 'react';
import {
  Plus, RotateCcw, ExternalLink, ChevronDown, ChevronUp,
  Github, Globe, Upload, Play, Square, Trash2, Zap,
  GitBranch, Server, MoreHorizontal, FolderArchive, Check,
} from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import StatusBadge from '@/components/StatusBadge';
import { api, App } from '@/lib/api';

type DeployType = 'github' | 'git' | 'empty';
type EnvEntry = { key: string; value: string };

const DEPLOY_TYPES: { id: DeployType; label: string; desc: string; icon: React.ReactNode; color: string }[] = [
  { id: 'github', label: 'GitHub',        desc: 'Public or private GitHub repo',             icon: <Github size={20} />,  color: '#8b5cf6' },
  { id: 'git',    label: 'Git URL',        desc: 'GitLab, Gitea, or any git remote',          icon: <Globe size={20} />,   color: '#3b82f6' },
  { id: 'empty',  label: 'Empty / Manual', desc: 'Create directory, upload files yourself',   icon: <Upload size={20} />,  color: '#f59e0b' },
];

function bytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

export default function AppsPage() {
  const [apps,     setApps]     = useState<App[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [showNew,  setShowNew]  = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [acting,   setActing]   = useState<string | null>(null);
  const [error,    setError]    = useState('');

  const [deployType, setDeployType] = useState<DeployType>('github');
  const [form, setForm] = useState({ name: '', repo_url: '', branch: 'main' });
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([{ key: '', value: '' }]);

  const fetchApps = useCallback(async () => {
    const res = await api.get<App[]>('/apps');
    if (res.success && res.data) setApps(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  function resetModal() {
    setShowNew(false); setError('');
    setDeployType('github');
    setForm({ name: '', repo_url: '', branch: 'main' });
    setEnvEntries([{ key: '', value: '' }]);
  }

  function canDeploy() {
    if (!form.name) return false;
    if (deployType === 'github' || deployType === 'git') return !!form.repo_url;
    return true;
  }

  async function deployApp() {
    setActing('deploy'); setError('');
    const env_vars = Object.fromEntries(
      envEntries.filter((e) => e.key).map((e) => [e.key, e.value])
    );
    const res = await api.post<App>('/apps', {
      name:     form.name,
      repo_url: deployType === 'empty' ? '' : form.repo_url,
      branch:   form.branch,
      env_vars,
    });
    setActing(null);
    if (res.success) { resetModal(); await fetchApps(); }
    else setError(res.error ?? 'Deploy failed');
  }

  async function doAction(name: string, action: string) {
    setActing(name + action);
    await api.post(`/apps/${name}/action`, { action });
    await fetchApps();
    setActing(null);
  }

  // Project zip upload
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<{ name: string; text: string } | null>(null);
  const uploadRef = useCallback((node: HTMLInputElement | null) => {
    if (node) node.value = '';
  }, []);

  async function uploadProject(name: string, file: File) {
    setUploading(name);
    setUploadMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/apps/${name}/upload`, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      const data = await res.json();
      if (data.success) {
        setUploadMsg({ name, text: `Uploaded and extracted ${data.data?.files ?? ''} files` });
      } else {
        setUploadMsg({ name, text: data.error || 'Upload failed' });
      }
    } catch {
      setUploadMsg({ name, text: 'Upload failed' });
    } finally {
      setUploading(null);
    }
  }

  const running = apps.filter((a) => a.status === 'online').length;

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Apps</h1>
          <p className="text-sm text-gray-600 mt-1">
            {loading ? 'Loading…' : `${running} running · ${apps.length} total`}
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary">
          <Plus size={14} /> New App
        </button>
      </div>

      {/* Loading skeleton */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card h-20 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
          ))}
        </div>
      ) : apps.length === 0 ? (
        /* Empty state */
        <div className="card flex flex-col items-center justify-center py-24 text-center"
          style={{ background: 'rgba(255,255,255,0.01)' }}>
          <div className="h-16 w-16 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.15)' }}>
            <Server size={28} className="text-violet-500" />
          </div>
          <p className="text-gray-300 font-semibold mb-1.5">No apps deployed yet</p>
          <p className="text-gray-600 text-sm mb-6">Deploy your first Next.js application to get started</p>
          <button onClick={() => setShowNew(true)} className="btn-primary">
            <Zap size={14} /> Deploy First App
          </button>
        </div>
      ) : (
        /* App cards */
        <div className="space-y-3 animate-slide-up">
          {apps.map((app) => (
            <div key={app.id} className="card hover:border-white/[0.1] transition-all duration-200"
              style={{ background: 'rgba(255,255,255,0.02)' }}>
              {/* Top row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 min-w-0">
                  {/* App avatar */}
                  <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0 font-bold text-sm text-violet-300"
                    style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.18)' }}>
                    {app.name[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-white text-sm">{app.name}</span>
                      <StatusBadge status={app.status} />
                      {app.domain && (
                        <a
                          href={`http${app.ssl_enabled ? 's' : ''}://${app.domain}`}
                          target="_blank" rel="noreferrer"
                          className="hidden sm:flex items-center gap-1 text-blue-400 hover:text-blue-300 text-xs transition-colors"
                        >
                          <Globe size={11} />
                          <span className="truncate max-w-[140px]">{app.domain}</span>
                          <ExternalLink size={9} />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <code className="text-[11px] text-gray-600 font-mono">:{app.port}</code>
                      {app.branch && (
                        <span className="flex items-center gap-1 text-[11px] text-gray-600">
                          <GitBranch size={10} /> {app.branch}
                        </span>
                      )}
                      {app.memory > 0 && (
                        <span className="text-[11px] text-gray-600">{bytes(app.memory)}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => doAction(app.name, 'restart')}
                    disabled={!!acting}
                    title="Restart"
                    className="p-2 rounded-xl text-gray-600 hover:text-violet-400 hover:bg-violet-500/10 transition-all"
                  >
                    <RotateCcw size={14} className={acting === app.name + 'restart' ? 'animate-spin' : ''} />
                  </button>
                  <button
                    onClick={() => doAction(app.name, app.status === 'online' ? 'stop' : 'start')}
                    disabled={!!acting}
                    title={app.status === 'online' ? 'Stop' : 'Start'}
                    className="p-2 rounded-xl text-gray-600 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all"
                  >
                    {app.status === 'online' ? <Square size={14} /> : <Play size={14} />}
                  </button>
                  {app.repo_url ? (
                    <button
                      onClick={() => doAction(app.name, 'rebuild')}
                      disabled={!!acting}
                      title="Rebuild"
                      className="p-2 rounded-xl text-gray-600 hover:text-blue-400 hover:bg-blue-500/10 transition-all"
                    >
                      <Zap size={14} />
                    </button>
                  ) : (
                    <label
                      title="Upload project zip"
                      className={`p-2 rounded-xl text-gray-600 hover:text-amber-400 hover:bg-amber-500/10 transition-all cursor-pointer ${uploading === app.name ? 'pointer-events-none' : ''}`}
                    >
                      {uploading === app.name
                        ? <span className="h-3.5 w-3.5 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin block" />
                        : <FolderArchive size={14} />}
                      <input
                        type="file"
                        accept=".zip"
                        className="hidden"
                        ref={uploadRef}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadProject(app.name, f);
                        }}
                      />
                    </label>
                  )}
                  <button
                    onClick={() => setExpanded(expanded === app.id ? null : app.id)}
                    className="p-2 rounded-xl text-gray-600 hover:text-white hover:bg-white/5 transition-all"
                  >
                    {expanded === app.id ? <ChevronUp size={14} /> : <MoreHorizontal size={14} />}
                  </button>
                </div>
              </div>

              {/* CPU bar (only when running) */}
              {app.status === 'online' && app.cpu >= 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] text-gray-700 w-6">CPU</span>
                  <div className="flex-1 progress">
                    <div className="progress-bar" style={{
                      width: `${Math.min(app.cpu, 100)}%`,
                      background: app.cpu > 80 ? '#ef4444' : app.cpu > 50 ? '#f59e0b' : '#8b5cf6',
                    }} />
                  </div>
                  <span className="text-[10px] text-gray-600 w-8 text-right">{app.cpu}%</span>
                </div>
              )}

              {/* Upload result message */}
              {uploadMsg?.name === app.name && (
                <div className="mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs animate-slide-up"
                  style={{
                    background: uploadMsg.text.startsWith('Upload') && !uploadMsg.text.includes('failed')
                      ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
                    border: `1px solid ${uploadMsg.text.startsWith('Upload') && !uploadMsg.text.includes('failed')
                      ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
                  }}>
                  {uploadMsg.text.startsWith('Upload') && !uploadMsg.text.includes('failed')
                    ? <Check size={13} className="text-emerald-400 shrink-0" />
                    : <FolderArchive size={13} className="text-red-400 shrink-0" />}
                  <span className={uploadMsg.text.startsWith('Upload') && !uploadMsg.text.includes('failed')
                    ? 'text-emerald-400' : 'text-red-400'}>{uploadMsg.text}</span>
                  <button onClick={() => setUploadMsg(null)} className="ml-auto text-gray-600 hover:text-gray-400">x</button>
                </div>
              )}

              {/* Expanded details */}
              {expanded === app.id && (
                <div className="mt-4 pt-4 border-t border-white/[0.06] space-y-5 animate-slide-up">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {[
                      { label: 'Port',      value: String(app.port) },
                      { label: 'Branch',    value: app.branch || '—' },
                      { label: 'Directory', value: `/var/www/apps/${app.name}`, mono: true },
                      { label: 'Repo',      value: app.repo_url || 'Manual deploy', mono: !!app.repo_url },
                    ].map(({ label, value, mono }) => (
                      <div key={label}>
                        <p className="label">{label}</p>
                        <p className={`text-sm truncate ${mono ? 'font-mono text-xs text-gray-400' : 'text-gray-300'}`}>{value}</p>
                      </div>
                    ))}
                  </div>

                  <div>
                    <p className="label mb-3">Environment Variables</p>
                    <EnvEditor appName={app.name} initial={app.env_vars} onSaved={fetchApps} />
                  </div>

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => { if (confirm(`Delete ${app.name}? This removes it from PM2 but keeps files.`)) doAction(app.name, 'delete'); }}
                      className="btn-danger" disabled={!!acting}
                    >
                      <Trash2 size={13} /> Delete App
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* New App Modal */}
      {showNew && (
        <Modal title="Deploy New App" onClose={resetModal}>
          <div className="space-y-5">
            {/* Deploy type */}
            <div>
              <label className="label">Deployment Type</label>
              <div className="grid grid-cols-3 gap-2">
                {DEPLOY_TYPES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setDeployType(t.id)}
                    className={`flex flex-col items-center gap-2 rounded-xl border p-3.5 text-center transition-all duration-200
                      ${deployType === t.id
                        ? 'border-violet-500/50 text-white'
                        : 'border-white/8 text-gray-500 hover:border-white/15 hover:text-gray-300'}`}
                    style={deployType === t.id
                      ? { background: `${t.color}0e`, borderColor: `${t.color}50` }
                      : { background: 'rgba(255,255,255,0.02)' }}
                  >
                    <span style={{ color: deployType === t.id ? t.color : undefined }}>{t.icon}</span>
                    <span className="text-xs font-semibold">{t.label}</span>
                    <span className="text-[10px] text-gray-600 leading-tight">{t.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* App name */}
            <div>
              <label className="label">App Name</label>
              <input
                className="input"
                placeholder="my-app"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              />
              <p className="text-xs text-gray-600 mt-1.5">Lowercase letters, numbers and hyphens only</p>
            </div>

            {/* Repo URL */}
            {(deployType === 'github' || deployType === 'git') && (
              <>
                <div>
                  <label className="label">{deployType === 'github' ? 'GitHub Repository URL' : 'Git Repository URL'}</label>
                  <input
                    className="input"
                    placeholder={deployType === 'github' ? 'https://github.com/user/repo.git' : 'https://gitlab.com/user/repo.git'}
                    value={form.repo_url}
                    onChange={(e) => setForm({ ...form, repo_url: e.target.value })}
                  />
                  {deployType === 'github' && (
                    <p className="text-xs text-gray-600 mt-1.5">For private repos: <code className="text-gray-500">https://TOKEN@github.com/user/repo.git</code></p>
                  )}
                </div>
                <div>
                  <label className="label">Branch</label>
                  <input className="input" placeholder="main" value={form.branch}
                    onChange={(e) => setForm({ ...form, branch: e.target.value })} />
                </div>
              </>
            )}

            {/* Empty deploy info */}
            {deployType === 'empty' && (
              <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 p-4 text-sm space-y-2">
                <p className="text-amber-300 font-semibold text-xs uppercase tracking-wider mb-2">Manual Deployment</p>
                <p className="text-gray-400">An empty directory will be created at:</p>
                <code className="block text-xs text-gray-300 font-mono">/var/www/apps/{form.name || '<name>'}</code>
                <p className="text-gray-500 text-xs mt-2">
                  After creating the app, you can upload a project .zip file using the
                  <FolderArchive size={12} className="inline mx-1 text-amber-400" />
                  button on the app card, or use the File Manager.
                </p>
              </div>
            )}

            {/* Env vars */}
            <div>
              <label className="label">
                Environment Variables
                <span className="ml-2 normal-case font-normal text-gray-700">(optional)</span>
              </label>
              <div className="space-y-2">
                {envEntries.map((entry, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      className="input w-5/12 font-mono text-xs"
                      placeholder="KEY"
                      value={entry.key}
                      onChange={(e) => { const n = [...envEntries]; n[i] = { ...n[i], key: e.target.value }; setEnvEntries(n); }}
                    />
                    <input
                      className="input flex-1 font-mono text-xs"
                      placeholder="value"
                      value={entry.value}
                      onChange={(e) => { const n = [...envEntries]; n[i] = { ...n[i], value: e.target.value }; setEnvEntries(n); }}
                    />
                  </div>
                ))}
              </div>
              <button onClick={() => setEnvEntries([...envEntries, { key: '', value: '' }])} className="btn-ghost text-xs mt-2">
                <Plus size={12} /> Add variable
              </button>
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">{error}</div>
            )}

            <div className="flex gap-3 justify-end pt-1">
              <button className="btn-ghost" onClick={resetModal}>Cancel</button>
              <button
                className="btn-primary"
                onClick={deployApp}
                disabled={acting === 'deploy' || !canDeploy()}
              >
                {acting === 'deploy' ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Deploying…
                  </span>
                ) : deployType === 'empty' ? 'Create App' : (
                  <><Zap size={13} /> Deploy</>
                )}
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
  const [saved,  setSaved]  = useState(false);

  async function save() {
    setSaving(true);
    const env_vars = Object.fromEntries(entries.filter((e) => e.key).map((e) => [e.key, e.value]));
    await api.put(`/apps/${appName}/env`, { env_vars });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
        <button onClick={save} className={`text-xs ${saved ? 'btn-success' : 'btn-primary'}`} disabled={saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Env Vars'}
        </button>
      </div>
    </div>
  );
}
