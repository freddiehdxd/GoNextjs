import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, Play, Square, RotateCcw, Zap, Trash2, Globe, ExternalLink,
  GitBranch, Server, FolderArchive, Rocket, Plus, Check, Copy,
  Activity, ScrollText, Settings2, Upload, Clock, Cpu, MemoryStick,
  ChevronDown, Pause, Eye, EyeOff, Webhook, RefreshCw,
} from 'lucide-react';
import Shell from '@/components/Shell';
import StatusBadge from '@/components/StatusBadge';
import { api, App } from '@/lib/api';

type Tab = 'overview' | 'logs' | 'configuration' | 'deployments';

function bytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

function uptime(ms: number): string {
  if (!ms) return '--';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export default function AppDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [app, setApp] = useState<App | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [acting, setActing] = useState<string | null>(null);

  const fetchApp = useCallback(async () => {
    if (!name) return;
    const res = await api.get<App>(`/apps/${name}`);
    if (res.success && res.data) {
      setApp(res.data);
    } else {
      setApp(null);
    }
    setLoading(false);
  }, [name]);

  useEffect(() => { fetchApp(); }, [fetchApp]);

  // Auto-refresh app data every 5s
  useEffect(() => {
    const iv = setInterval(fetchApp, 5000);
    return () => clearInterval(iv);
  }, [fetchApp]);

  async function doAction(action: string) {
    if (!name) return;
    setActing(action);
    await api.post(`/apps/${name}/action`, { action });
    await fetchApp();
    setActing(null);
  }

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-32">
          <span className="h-6 w-6 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
        </div>
      </Shell>
    );
  }

  if (!app) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <Server size={40} className="text-gray-700 mb-4" />
          <p className="text-gray-400 font-semibold mb-2">App not found</p>
          <Link to="/apps" className="text-violet-400 hover:text-violet-300 text-sm">Back to Apps</Link>
        </div>
      </Shell>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview',       label: 'Overview',       icon: <Activity size={14} /> },
    { id: 'logs',           label: 'Logs',           icon: <ScrollText size={14} /> },
    { id: 'configuration',  label: 'Configuration',  icon: <Settings2 size={14} /> },
    { id: 'deployments',    label: 'Deployments',    icon: <Upload size={14} /> },
  ];

  return (
    <Shell>
      {/* Header */}
      <div className="mb-6">
        <Link to="/apps" className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-400 transition-colors mb-4">
          <ArrowLeft size={12} /> Back to Apps
        </Link>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl flex items-center justify-center shrink-0 font-bold text-lg text-violet-300"
              style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.18)' }}>
              {app.name[0].toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-white">{app.name}</h1>
                <StatusBadge status={app.status} />
              </div>
              <div className="flex items-center gap-3 mt-0.5">
                <code className="text-xs text-gray-600 font-mono">:{app.port}</code>
                {app.branch && (
                  <span className="flex items-center gap-1 text-xs text-gray-600">
                    <GitBranch size={11} /> {app.branch}
                  </span>
                )}
                {app.domains.length > 0 && (
                  <a href={`http${app.domains[0].ssl_enabled ? 's' : ''}://${app.domains[0].domain}`}
                    target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors">
                    <Globe size={11} /> {app.domains[0].domain} <ExternalLink size={9} />
                  </a>
                )}
                {app.domains.length > 1 && (
                  <span className="text-[10px] text-gray-500">+{app.domains.length - 1} more</span>
                )}
              </div>
            </div>
          </div>

          {/* Quick actions */}
          <div className="flex items-center gap-1.5">
            <button onClick={() => doAction('restart')} disabled={!!acting} title="Restart"
              className="btn-secondary !px-3 !py-2">
              <RotateCcw size={13} className={acting === 'restart' ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => doAction(app.status === 'online' ? 'stop' : 'start')} disabled={!!acting}
              title={app.status === 'online' ? 'Stop' : 'Start'}
              className="btn-secondary !px-3 !py-2">
              {app.status === 'online' ? <Square size={13} /> : <Play size={13} />}
            </button>
            {app.repo_url && (
              <button onClick={() => doAction('rebuild')} disabled={!!acting} title="Rebuild"
                className="btn-primary !px-3 !py-2">
                <Zap size={13} /> Rebuild
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 border-b border-white/[0.06] mb-6">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all duration-200 -mb-px
              ${tab === t.id
                ? 'text-violet-400 border-violet-500'
                : 'text-gray-500 border-transparent hover:text-gray-300 hover:border-white/10'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="animate-fade-in">
        {tab === 'overview' && <OverviewTab app={app} />}
        {tab === 'logs' && <LogsTab appName={app.name} />}
        {tab === 'configuration' && <ConfigTab app={app} onSaved={fetchApp} />}
        {tab === 'deployments' && <DeploymentsTab app={app} onAction={doAction} acting={acting} onRefresh={fetchApp} />}
      </div>
    </Shell>
  );
}

/* ─────────────────────── Overview Tab ─────────────────────── */

function OverviewTab({ app }: { app: App }) {
  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Status" value={app.status === 'online' ? 'Running' : app.status}
          color={app.status === 'online' ? '#10b981' : '#6b7280'}
          icon={<Activity size={16} />} />
        <StatCard label="CPU" value={app.cpu >= 0 ? `${app.cpu}%` : '--'}
          color={app.cpu > 80 ? '#ef4444' : app.cpu > 50 ? '#f59e0b' : '#8b5cf6'}
          icon={<Cpu size={16} />} />
        <StatCard label="Memory" value={app.memory > 0 ? bytes(app.memory) : '--'}
          color="#3b82f6"
          icon={<MemoryStick size={16} />} />
        <StatCard label="Port" value={String(app.port)}
          color="#8b5cf6"
          icon={<Server size={16} />} />
      </div>

      {/* Info grid */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-4">Details</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
          <InfoRow label="App Name" value={app.name} mono />
          <InfoRow label="Port" value={String(app.port)} />
          <InfoRow label="Directory" value={`/var/www/apps/${app.name}`} mono />
          <InfoRow label="Repository" value={app.repo_url || 'Manual deploy'} mono={!!app.repo_url} />
          <InfoRow label="Branch" value={app.branch || '--'} />
          <InfoRow label="Domains" value={app.domains.length > 0 ? app.domains.map(d => d.domain).join(', ') : 'Not configured'} />
          <InfoRow label="SSL" value={app.domains.some(d => d.ssl_enabled) ? `${app.domains.filter(d => d.ssl_enabled).length}/${app.domains.length} enabled` : 'Disabled'} />
          <InfoRow label="Created" value={new Date(app.created_at).toLocaleDateString()} />
        </div>
      </div>

      {/* Environment variables (read-only preview) */}
      <EnvPreview appName={app.name} />
    </div>
  );
}

function StatCard({ label, value, color, icon }: { label: string; value: string; color: string; icon: React.ReactNode }) {
  return (
    <div className="card !p-4">
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color }}>{icon}</span>
        <span className="label !mb-0">{label}</span>
      </div>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`text-sm truncate ${mono ? 'font-mono text-xs text-gray-400' : 'text-gray-300'}`}>{value}</p>
    </div>
  );
}

/* ─────────────────────── Logs Tab ─────────────────────── */

function LogsTab({ appName }: { appName: string }) {
  const [logType, setLogType] = useState<'out' | 'error'>('out');
  const [lines, setLines] = useState(200);
  const [log, setLog] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const containerRef = useRef<HTMLPreElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const fetchLogs = useCallback(async () => {
    const res = await api.get<{ log: string }>(`/logs/app/${appName}/file?type=${logType}&lines=${lines}`);
    if (res.success && res.data) {
      setLog(res.data.log);
    }
    setLoading(false);
  }, [appName, logType, lines]);

  // Polling mode (when not live)
  useEffect(() => {
    if (live) return;
    setLoading(true);
    fetchLogs();
  }, [fetchLogs, live]);

  useEffect(() => {
    if (live || paused) return;
    const iv = setInterval(fetchLogs, 3000);
    return () => clearInterval(iv);
  }, [fetchLogs, paused, live]);

  // WebSocket live mode
  useEffect(() => {
    if (!live) {
      // Clean up WebSocket when switching off
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
        setWsConnected(false);
      }
      return;
    }

    // Build WS URL
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/api/logs/stream?app=${appName}&type=${logType}`;

    setLog('');
    setLoading(true);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      setLoading(false);
    };

    ws.onmessage = (event) => {
      setLog(prev => {
        const combined = prev + event.data;
        // Keep last ~5000 lines to avoid unbounded growth
        const allLines = combined.split('\n');
        if (allLines.length > 5000) {
          return allLines.slice(allLines.length - 5000).join('\n');
        }
        return combined;
      });
    };

    ws.onclose = () => {
      setWsConnected(false);
      // If still in live mode, reconnect after 2s
      if (wsRef.current === ws) {
        setTimeout(() => {
          if (wsRef.current === ws) {
            setLive(false);
          }
        }, 2000);
      }
    };

    ws.onerror = () => {
      setWsConnected(false);
    };

    return () => {
      ws.close();
      wsRef.current = null;
      setWsConnected(false);
    };
  }, [live, appName, logType]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [log, autoScroll]);

  // When switching log type in live mode, reset
  function switchLogType(type: 'out' | 'error') {
    if (type === logType) return;
    setLogType(type);
    if (live) {
      // Close and reconnect with new type
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    }
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button onClick={() => switchLogType('out')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
              ${logType === 'out' ? 'bg-violet-500/15 text-violet-400 border border-violet-500/30' : 'text-gray-500 hover:text-gray-300 border border-transparent'}`}>
            stdout
          </button>
          <button onClick={() => switchLogType('error')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
              ${logType === 'error' ? 'bg-red-500/15 text-red-400 border border-red-500/30' : 'text-gray-500 hover:text-gray-300 border border-transparent'}`}>
            stderr
          </button>
        </div>
        <div className="flex items-center gap-2">
          {!live && (
            <select value={lines} onChange={e => setLines(Number(e.target.value))}
              className="input !py-1.5 !px-2 text-xs !w-auto">
              <option value={100}>100 lines</option>
              <option value={200}>200 lines</option>
              <option value={500}>500 lines</option>
              <option value={1000}>1000 lines</option>
            </select>
          )}
          <button onClick={() => setLive(!live)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border flex items-center gap-1.5
              ${live
                ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
                : 'text-gray-500 hover:text-gray-300 border-transparent'}`}>
            {live && wsConnected && (
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
            )}
            {live ? 'Live' : 'Go Live'}
          </button>
          {!live && (
            <button onClick={() => setPaused(!paused)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border
                ${paused ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' : 'text-gray-500 hover:text-gray-300 border-transparent'}`}>
              {paused ? <><Play size={11} /> Resume</> : <><Pause size={11} /> Pause</>}
            </button>
          )}
          <button onClick={() => setAutoScroll(!autoScroll)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border
              ${autoScroll ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'text-gray-500 hover:text-gray-300 border-transparent'}`}>
            <ChevronDown size={11} /> Auto-scroll {autoScroll ? 'on' : 'off'}
          </button>
        </div>
      </div>

      {/* Terminal-style log viewer */}
      <div className="rounded-xl border border-white/[0.06] overflow-hidden"
        style={{ background: '#0a0a14' }}>
        {/* Terminal header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.06]"
          style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/60" />
          </div>
          <span className="text-[10px] text-gray-600 font-mono ml-2">
            {appName} - {logType === 'out' ? 'stdout' : 'stderr'}
            {live && wsConnected && <span className="ml-2 text-rose-400">streaming</span>}
            {live && !wsConnected && <span className="ml-2 text-amber-500">connecting...</span>}
            {!live && !paused && <span className="ml-2 text-emerald-500/60">polling</span>}
          </span>
        </div>
        {/* Log content */}
        <pre ref={containerRef}
          className="p-4 text-xs font-mono text-gray-300 overflow-auto leading-relaxed whitespace-pre-wrap break-all"
          style={{ maxHeight: '60vh', minHeight: '300px' }}>
          {loading ? (
            <span className="text-gray-600">Loading logs...</span>
          ) : log ? (
            log
          ) : (
            <span className="text-gray-600">No logs available. App may not have started yet.</span>
          )}
        </pre>
      </div>
    </div>
  );
}

/* ─────────────────────── Configuration Tab ─────────────────────── */

function ConfigTab({ app, onSaved }: { app: App; onSaved: () => void }) {
  type EnvEntry = { key: string; value: string; source?: string };
  const [entries, setEntries] = useState<EnvEntry[]>([{ key: '', value: '' }]);
  const [loadingEnv, setLoadingEnv] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [revealAll, setRevealAll] = useState(false);

  function toggleReveal(idx: number) {
    const key = `${idx}`;
    setRevealedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Load env vars from disk files (.env + .env.local), falling back to DB
  useEffect(() => {
    (async () => {
      setLoadingEnv(true);
      const res = await api.get<{ vars: Record<string, string>; entries: { key: string; value: string; source: string }[] }>(`/apps/${app.name}/env-file`);
      if (res.success && res.data && res.data.entries.length > 0) {
        setEntries(res.data.entries.map(e => ({ key: e.key, value: e.value, source: e.source })));
      } else if (Object.keys(app.env_vars).length > 0) {
        // Fallback to DB values if no files on disk
        setEntries(Object.entries(app.env_vars).map(([key, value]) => ({ key, value, source: 'database' })));
      } else {
        setEntries([{ key: '', value: '' }]);
      }
      setLoadingEnv(false);
    })();
  }, [app.name]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveEnv() {
    setSaving(true);
    const env_vars = Object.fromEntries(entries.filter(e => e.key).map(e => [e.key, e.value]));
    const res = await api.put(`/apps/${app.name}/env`, { env_vars });
    setSaving(false);
    if (res.success) {
      setSaved(true);
      // Clear source tags since we just wrote everything to .env
      setEntries(prev => prev.map(e => ({ ...e, source: '.env' })));
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    }
  }

  return (
    <div className="space-y-6">
      {/* General config */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-4">General</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">App Name</label>
            <input className="input" value={app.name} disabled />
          </div>
          <div>
            <label className="label">Port</label>
            <input className="input" value={app.port} disabled />
          </div>
          <div>
            <label className="label">Directory</label>
            <div className="flex items-center gap-2">
              <input className="input flex-1 font-mono text-xs" value={`/var/www/apps/${app.name}`} disabled />
              <CopyBtn text={`/var/www/apps/${app.name}`} />
            </div>
          </div>
          <div>
            <label className="label">Repository</label>
            <input className="input font-mono text-xs" value={app.repo_url || 'Manual deploy'} disabled />
          </div>
          <div>
            <label className="label">Domains</label>
            <div className="flex items-center gap-2">
              <input className="input flex-1" value={app.domains.length > 0 ? app.domains.map(d => d.domain).join(', ') : 'Not configured'} disabled />
              <Link to="/domains" className="btn-ghost text-xs !py-1.5">
                <Globe size={12} /> {app.domains.length > 0 ? 'Manage' : 'Add'}
              </Link>
            </div>
          </div>
          <div>
            <label className="label">SSL</label>
            <div className="flex items-center gap-2">
              <input className="input flex-1" value={
                app.domains.length === 0 ? 'No domains'
                : app.domains.every(d => d.ssl_enabled) ? 'All enabled'
                : app.domains.some(d => d.ssl_enabled) ? `${app.domains.filter(d => d.ssl_enabled).length}/${app.domains.length} enabled`
                : 'Disabled'
              } disabled />
              {app.domains.length > 0 && app.domains.some(d => !d.ssl_enabled) && (
                <Link to="/ssl" className="btn-ghost text-xs !py-1.5">Enable</Link>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Resource Limits */}
      <ResourceLimitsCard app={app} onSaved={onSaved} />

      {/* Webhook */}
      <WebhookCard app={app} onSaved={onSaved} />

      {/* Env vars */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Environment Variables</h3>
          <div className="flex items-center gap-3">
            <button onClick={() => { setRevealAll(!revealAll); setRevealedKeys(new Set()); }}
              className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
              {revealAll ? <EyeOff size={12} /> : <Eye size={12} />}
              {revealAll ? 'Hide all' : 'Reveal all'}
            </button>
            <p className="text-[10px] text-gray-600">
              from <code className="text-gray-500">.env</code> / <code className="text-gray-500">.env.local</code>
            </p>
          </div>
        </div>

        {loadingEnv ? (
          <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
            <span className="h-3 w-3 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
            Loading environment files...
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {entries.map((entry, i) => {
                const isVisible = revealAll || revealedKeys.has(`${i}`);
                return (
                  <div key={i} className="flex gap-2 items-center">
                    <input className="input w-5/12 font-mono text-xs" placeholder="KEY" value={entry.key}
                      onChange={e => { const n = [...entries]; n[i] = { ...n[i], key: e.target.value }; setEntries(n); }} />
                    <input type={isVisible ? 'text' : 'password'} className="input flex-1 font-mono text-xs" placeholder="value" value={entry.value}
                      onChange={e => { const n = [...entries]; n[i] = { ...n[i], value: e.target.value }; setEntries(n); }} />
                    <button onClick={() => toggleReveal(i)}
                      className="p-1.5 rounded-lg text-gray-600 hover:text-gray-300 transition-all shrink-0" title={isVisible ? 'Hide' : 'Reveal'}>
                      {isVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                    {entry.source && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${
                        entry.source === '.env.local'
                          ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                          : 'bg-violet-500/10 text-violet-400 border border-violet-500/20'
                      }`}>{entry.source}</span>
                    )}
                    <button onClick={() => { const n = entries.filter((_, j) => j !== i); setEntries(n.length ? n : [{ key: '', value: '' }]); }}
                      className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0">
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-3 mt-3">
              <button onClick={() => setEntries([...entries, { key: '', value: '' }])} className="btn-ghost text-xs">
                <Plus size={12} /> Add Variable
              </button>
              <button onClick={saveEnv} className={`text-xs ${saved ? 'btn-success' : 'btn-primary'}`} disabled={saving}>
                {saving ? 'Saving...' : saved ? 'Saved & Restarted' : 'Save Environment'}
              </button>
            </div>
            <p className="text-[10px] text-gray-700 mt-2">Saving writes to <code className="text-gray-600">.env</code>, updates the PM2 config, and restarts the app.</p>
          </>
        )}
      </div>

      {/* Danger zone */}
      <div className="card" style={{ borderColor: 'rgba(239,68,68,0.15)' }}>
        <h3 className="text-sm font-semibold text-red-400 mb-2">Danger Zone</h3>
        <p className="text-xs text-gray-500 mb-4">Deleting an app removes it from PM2 and the database. Files on disk are also removed.</p>
        <button onClick={() => {
          if (confirm(`Delete ${app.name}? This will remove the app, its PM2 process, and all files.`)) {
            api.post(`/apps/${app.name}/action`, { action: 'delete' }).then(() => {
              window.location.href = '/apps';
            });
          }
        }} className="btn-danger">
          <Trash2 size={13} /> Delete App
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────── Deployments Tab ─────────────────────── */

function DeploymentsTab({ app, onAction, acting, onRefresh }: {
  app: App; onAction: (action: string) => void; acting: string | null; onRefresh: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  async function uploadZip(file: File) {
    setUploading(true);
    setUploadMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/apps/${app.name}/deploy-zip`, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      const data = await res.json();
      if (data.success) {
        setUploadMsg(`Uploaded and extracted ${data.data?.files ?? ''} files`);
        onRefresh();
      } else {
        setUploadMsg(data.error || 'Upload failed');
      }
    } catch {
      setUploadMsg('Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Deploy actions */}
      {app.repo_url ? (
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-2">Git Deployment</h3>
          <p className="text-xs text-gray-500 mb-4">
            Pull latest changes from <code className="text-gray-400">{app.repo_url}</code> branch <code className="text-gray-400">{app.branch}</code>, rebuild, and restart.
          </p>
          <button onClick={() => onAction('rebuild')} disabled={!!acting} className="btn-primary">
            {acting === 'rebuild' ? (
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Rebuilding...
              </span>
            ) : (
              <><Zap size={13} /> Rebuild &amp; Deploy</>
            )}
          </button>
        </div>
      ) : (
        <>
          {/* Upload zip */}
          <div className="card">
            <h3 className="text-sm font-semibold text-white mb-2">Upload Project</h3>
            <p className="text-xs text-gray-500 mb-4">
              Upload a .zip file containing your project. Files will be extracted to <code className="text-gray-400">/var/www/apps/{app.name}</code>.
            </p>
            <label className={`btn-secondary inline-flex cursor-pointer ${uploading ? 'pointer-events-none' : ''}`}>
              {uploading ? (
                <span className="flex items-center gap-2">
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
                  Uploading...
                </span>
              ) : (
                <><FolderArchive size={13} /> Choose .zip File</>
              )}
              <input type="file" accept=".zip" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadZip(f); }} />
            </label>
            {uploadMsg && (
              <div className={`mt-3 rounded-xl px-3 py-2 text-xs flex items-center gap-2 animate-slide-up ${
                uploadMsg.includes('failed')
                  ? 'bg-red-500/8 border border-red-500/20 text-red-400'
                  : 'bg-emerald-500/8 border border-emerald-500/20 text-emerald-400'
              }`}>
                {uploadMsg.includes('failed') ? <FolderArchive size={12} /> : <Check size={12} />}
                {uploadMsg}
              </div>
            )}
          </div>

          {/* Setup / deploy */}
          <div className="card">
            <h3 className="text-sm font-semibold text-white mb-2">Install &amp; Start</h3>
            <p className="text-xs text-gray-500 mb-4">
              Run <code className="text-gray-400">npm install</code>, build the project, and start it with PM2.
              Works for Next.js and generic Node.js projects.
            </p>
            <button onClick={() => onAction('setup')} disabled={!!acting} className="btn-primary">
              {acting === 'setup' ? (
                <span className="flex items-center gap-2">
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Setting up... (this may take a few minutes)
                </span>
              ) : (
                <><Rocket size={13} /> Install, Build &amp; Start</>
              )}
            </button>
          </div>
        </>
      )}

      {/* Quick actions */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-4">Process Management</h3>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => onAction('restart')} disabled={!!acting} className="btn-secondary">
            <RotateCcw size={13} className={acting === 'restart' ? 'animate-spin' : ''} /> Restart
          </button>
          <button onClick={() => onAction(app.status === 'online' ? 'stop' : 'start')} disabled={!!acting} className="btn-secondary">
            {app.status === 'online' ? <><Square size={13} /> Stop</> : <><Play size={13} /> Start</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── Resource Limits Card ─────────────────────── */

function ResourceLimitsCard({ app, onSaved }: { app: App; onSaved: () => void }) {
  const [maxMemory, setMaxMemory] = useState(app.max_memory || 512);
  const [maxRestarts, setMaxRestarts] = useState(app.max_restarts || 10);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = maxMemory !== (app.max_memory || 512) || maxRestarts !== (app.max_restarts || 10);

  async function save() {
    setSaving(true);
    const res = await api.put(`/apps/${app.name}/settings`, {
      max_memory: maxMemory,
      max_restarts: maxRestarts,
    });
    setSaving(false);
    if (res.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    }
  }

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-white mb-4">Resource Limits</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Max Memory (MB)</label>
          <div className="flex items-center gap-3">
            <input type="number" className="input flex-1" min={64} max={16384} step={64}
              value={maxMemory} onChange={e => setMaxMemory(Number(e.target.value))} />
            <span className="text-[10px] text-gray-600 shrink-0">64 – 16,384 MB</span>
          </div>
          <p className="text-[10px] text-gray-700 mt-1">PM2 will auto-restart the app if memory exceeds this limit.</p>
        </div>
        <div>
          <label className="label">Max Restarts</label>
          <div className="flex items-center gap-3">
            <input type="number" className="input flex-1" min={0} max={100}
              value={maxRestarts} onChange={e => setMaxRestarts(Number(e.target.value))} />
            <span className="text-[10px] text-gray-600 shrink-0">0 – 100</span>
          </div>
          <p className="text-[10px] text-gray-700 mt-1">Max consecutive unstable restarts before PM2 stops the app.</p>
        </div>
      </div>
      {dirty && (
        <div className="mt-4 flex items-center gap-3">
          <button onClick={save} className={`text-xs ${saved ? 'btn-success' : 'btn-primary'}`} disabled={saving}>
            {saving ? 'Saving...' : saved ? 'Saved' : 'Save Limits'}
          </button>
          <button onClick={() => { setMaxMemory(app.max_memory || 512); setMaxRestarts(app.max_restarts || 10); }}
            className="btn-ghost text-xs">Reset</button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Webhook Card ─────────────────────── */

function WebhookCard({ app, onSaved }: { app: App; onSaved: () => void }) {
  const [secret, setSecret] = useState(app.webhook_secret || '');
  const [webhookUrl, setWebhookUrl] = useState(app.webhook_secret ? `/api/webhook/${app.name}` : '');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<'url' | 'secret' | null>(null);

  async function generate() {
    setGenerating(true);
    const res = await api.post<{ webhook_secret: string; webhook_url: string }>(`/apps/${app.name}/webhook`);
    setGenerating(false);
    if (res.success && res.data) {
      setSecret(res.data.webhook_secret);
      setWebhookUrl(res.data.webhook_url);
      onSaved();
    }
  }

  function copyToClipboard(text: string, type: 'url' | 'secret') {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 1500);
  }

  const fullUrl = secret ? `${window.location.origin}/api/webhook/${app.name}` : '';

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-white">Deploy Webhook</h3>
          <p className="text-[10px] text-gray-600 mt-0.5">Trigger deploys via HTTP POST from CI/CD or GitHub.</p>
        </div>
        <button onClick={generate} disabled={generating}
          className="btn-secondary text-xs">
          {generating ? (
            <span className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full border-2 border-violet-400/30 border-t-violet-400 animate-spin" />
              Generating...
            </span>
          ) : (
            <><RefreshCw size={12} /> {secret ? 'Regenerate' : 'Generate'}</>
          )}
        </button>
      </div>

      {secret ? (
        <div className="space-y-3">
          {/* Webhook URL */}
          <div>
            <label className="label">Webhook URL</label>
            <div className="flex items-center gap-2">
              <input className="input flex-1 font-mono text-xs" value={fullUrl} readOnly />
              <button onClick={() => copyToClipboard(fullUrl, 'url')}
                className="p-1.5 rounded-lg text-gray-600 hover:text-violet-400 hover:bg-violet-500/10 transition-all" title="Copy URL">
                {copied === 'url' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              </button>
            </div>
          </div>

          {/* Secret */}
          <div>
            <label className="label">Secret</label>
            <div className="flex items-center gap-2">
              <input className="input flex-1 font-mono text-xs" value={secret} readOnly />
              <button onClick={() => copyToClipboard(secret, 'secret')}
                className="p-1.5 rounded-lg text-gray-600 hover:text-violet-400 hover:bg-violet-500/10 transition-all" title="Copy Secret">
                {copied === 'secret' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              </button>
            </div>
          </div>

          {/* Usage hint */}
          <div className="rounded-lg px-3 py-2 text-[10px] text-gray-500 border border-white/[0.04]"
            style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="font-medium text-gray-400 mb-1">Usage:</p>
            <code className="text-[10px] text-violet-400 break-all">
              curl -X POST {fullUrl} -H "X-Webhook-Secret: {secret}"
            </code>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center">
          <Webhook size={20} className="text-gray-700 mx-auto mb-2" />
          <p className="text-xs text-gray-500">No webhook configured. Click "Generate" to create one.</p>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Shared components ─────────────────────── */

function EnvPreview({ appName }: { appName: string }) {
  const [envEntries, setEnvEntries] = useState<{ key: string; value: string; source: string }[]>([]);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    (async () => {
      const res = await api.get<{ entries: { key: string; value: string; source: string }[] }>(`/apps/${appName}/env-file`);
      if (res.success && res.data?.entries?.length) setEnvEntries(res.data.entries);
    })();
  }, [appName]);

  if (!envEntries.length) return null;
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Environment Variables</h3>
        <button onClick={() => setRevealed(!revealed)}
          className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
          {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
          {revealed ? 'Hide values' : 'Reveal values'}
        </button>
      </div>
      <div className="space-y-1.5">
        {envEntries.map(e => (
          <div key={e.key} className="flex items-center gap-2 text-xs">
            <code className="text-violet-400 font-mono">{e.key}</code>
            <span className="text-gray-700">=</span>
            <code className="text-gray-400 font-mono truncate">
              {revealed ? e.value : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
            </code>
            <span className={`text-[9px] px-1 py-0.5 rounded ml-auto shrink-0 ${
              e.source === '.env.local'
                ? 'bg-amber-500/10 text-amber-500'
                : 'bg-violet-500/10 text-violet-400'
            }`}>{e.source}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-700 mt-3">Edit in Configuration tab</p>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1.5 rounded-lg text-gray-600 hover:text-violet-400 hover:bg-violet-500/10 transition-all" title="Copy">
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
    </button>
  );
}
