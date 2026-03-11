import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Settings as SettingsIcon, Download, CheckCircle2, AlertCircle,
  RefreshCw, GitCommit, Clock, Terminal, ArrowUpCircle, Loader2,
  XCircle, ChevronDown, ChevronUp, Bell, HardDrive, Send, Play,
  Shield,
} from 'lucide-react';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

/* ---- Types ---- */

interface Commit {
  hash: string;
  message: string;
}

interface UpdateInfo {
  currentVersion: string;
  currentCommit: string;
  currentDate: string;
  remoteVersion: string;
  updateAvailable: boolean;
  updating: boolean;
  runningApps: number;
  commits?: Commit[];
  commitCount?: number;
}

type UpdateStatus = 'idle' | 'checking' | 'updating' | 'success' | 'error';

/* ---- Settings Page ---- */

export default function Settings() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [showCommits, setShowCommits] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const checkForUpdates = useCallback(async () => {
    setStatus('checking');
    setError('');
    const res = await api.get<UpdateInfo>('/update/check');
    if (res.success && res.data) {
      setInfo(res.data);
      if (res.data.updating) {
        setStatus('updating');
      } else {
        setStatus('idle');
      }
    } else {
      setError(res.error || 'Failed to check for updates');
      setStatus('error');
    }
  }, []);

  // Check on mount
  useEffect(() => {
    checkForUpdates();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function applyUpdate() {
    setStatus('updating');
    setLogs([]);
    setShowLog(true);
    setError('');

    try {
      const response = await fetch('/api/update/apply', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error || `Update failed (HTTP ${response.status})`);
        setStatus('error');
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setError('Streaming not supported');
        setStatus('error');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // Keep incomplete event in buffer

        for (const event of events) {
          const lines = event.split('\n');
          let eventType = '';
          let data = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            if (line.startsWith('data: ')) data = line.slice(6);
          }

          if (!eventType || !data) continue;

          try {
            const parsed = JSON.parse(data);

            switch (eventType) {
              case 'log':
                setLogs(prev => [...prev, parsed.line]);
                break;
              case 'status':
                setLogs(prev => [...prev, parsed.message]);
                break;
              case 'complete':
                setLogs(prev => [...prev, '', parsed.message]);
                setStatus('success');
                // Re-check version after successful update
                setTimeout(() => checkForUpdates(), 3000);
                break;
              case 'error':
                setLogs(prev => [...prev, `ERROR: ${parsed.message}`]);
                setError(parsed.message);
                setStatus('error');
                break;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }

      // If we get here without a complete/error event, connection was likely
      // closed by PM2 restart — which means the update succeeded
      if (status === 'updating') {
        setLogs(prev => [...prev, '', 'Connection closed — backend is restarting...']);
        setStatus('success');
        // Wait for the new backend to come up, then re-check
        setTimeout(() => {
          checkForUpdates();
        }, 5000);
      }
    } catch (err) {
      // Connection error likely means PM2 restarted the process — that's success
      if (status === 'updating' && logs.length > 3) {
        setLogs(prev => [...prev, '', 'Backend restarted — update applied!']);
        setStatus('success');
        setTimeout(() => checkForUpdates(), 5000);
      } else {
        setError(err instanceof Error ? err.message : 'Update failed');
        setStatus('error');
      }
    }
  }

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <SettingsIcon size={22} className="text-violet-400" />
            Settings
          </h1>
          <p className="text-sm text-gray-500 mt-1">Panel configuration and updates</p>
        </div>
      </div>

      {/* Update Card */}
      <div className="glass p-6 mb-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.2)' }}>
              <ArrowUpCircle size={20} className="text-violet-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Panel Updates</h2>
              <p className="text-xs text-gray-500">Keep your panel up to date</p>
            </div>
          </div>
          <button
            onClick={checkForUpdates}
            disabled={status === 'checking' || status === 'updating'}
            className="flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-medium text-gray-400 transition-all hover:text-gray-200"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <RefreshCw size={13} className={status === 'checking' ? 'animate-spin' : ''} />
            {status === 'checking' ? 'Checking...' : 'Check for updates'}
          </button>
        </div>

        {/* Current Version */}
        {info && (
          <div className="rounded-xl p-4 mb-4"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-6">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Current Version</p>
                <p className="text-sm font-mono font-semibold text-white flex items-center gap-2">
                  <GitCommit size={14} className="text-violet-400" />
                  {info.currentVersion}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Last Commit</p>
                <p className="text-sm text-gray-300 truncate max-w-xs">{info.currentCommit}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Date</p>
                <p className="text-sm text-gray-400 flex items-center gap-1.5">
                  <Clock size={12} />
                  {info.currentDate ? new Date(info.currentDate).toLocaleDateString() : 'Unknown'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Update Available Banner */}
        {info?.updateAvailable && status !== 'success' && (
          <div className="rounded-xl p-4 mb-4"
            style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Download size={18} className="text-violet-400" />
                <div>
                  <p className="text-sm font-semibold text-white">
                    Update available
                    <span className="ml-2 text-xs font-mono text-violet-400">
                      {info.currentVersion} &rarr; {info.remoteVersion}
                    </span>
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {info.commitCount} new commit{info.commitCount !== 1 ? 's' : ''} available
                  </p>
                </div>
              </div>
              <button
                onClick={applyUpdate}
                disabled={status === 'updating'}
                className="btn-primary flex items-center gap-2"
              >
                {status === 'updating' ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <Download size={14} />
                    Update Now
                  </>
                )}
              </button>
            </div>

            {/* Safety notice */}
            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-400/80">
              <CheckCircle2 size={12} className="shrink-0" />
              <span>
                Zero-downtime update — your {info.runningApps > 0 ? `${info.runningApps} running app${info.runningApps !== 1 ? 's' : ''} will` : 'apps will'} not be affected.
                Only the panel backend will restart briefly.
              </span>
            </div>

            {/* Commit list */}
            {info.commits && info.commits.length > 0 && (
              <div className="mt-3">
                <button
                  onClick={() => setShowCommits(!showCommits)}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {showCommits ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {showCommits ? 'Hide' : 'Show'} changes
                </button>
                {showCommits && (
                  <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                    {info.commits.map((c, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="font-mono text-violet-400 shrink-0">{c.hash}</span>
                        <span className="text-gray-300">{c.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Up to date */}
        {info && !info.updateAvailable && status !== 'checking' && status !== 'success' && (
          <div className="rounded-xl p-4 mb-4 flex items-center gap-3"
            style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
            <CheckCircle2 size={18} className="text-emerald-400" />
            <p className="text-sm text-emerald-300">Your panel is up to date</p>
          </div>
        )}

        {/* Success */}
        {status === 'success' && (
          <div className="rounded-xl p-4 mb-4 flex items-center gap-3"
            style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
            <CheckCircle2 size={18} className="text-emerald-400" />
            <div>
              <p className="text-sm font-semibold text-emerald-300">Update completed successfully!</p>
              <p className="text-xs text-gray-400 mt-0.5">The panel has been updated and restarted. Your apps were not affected.</p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-xl p-4 mb-4 flex items-center gap-3"
            style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
            <XCircle size={18} className="text-red-400" />
            <div>
              <p className="text-sm font-semibold text-red-300">Update failed</p>
              <p className="text-xs text-red-400/80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Live Update Log */}
        {showLog && logs.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-400 flex items-center gap-2">
                <Terminal size={13} />
                Update Log
                {status === 'updating' && (
                  <span className="h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
                )}
              </p>
              <button
                onClick={() => setShowLog(false)}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                Hide
              </button>
            </div>
            <div
              ref={logRef}
              className="rounded-xl p-4 font-mono text-xs leading-relaxed max-h-80 overflow-y-auto"
              style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              {logs.map((line, i) => (
                <div key={i} className={`${
                  line.startsWith('[update]') || line.startsWith('===')
                    ? 'text-violet-400 font-semibold'
                    : line.startsWith('ERROR')
                    ? 'text-red-400'
                    : line.startsWith('[') && line.includes('Done')
                    ? 'text-emerald-400'
                    : 'text-gray-400'
                }`}>
                  {line || '\u00A0'}
                </div>
              ))}
              {status === 'updating' && (
                <div className="text-gray-600 animate-pulse">...</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Alerts Card */}
      <AlertsCard />

      {/* Backups Card */}
      <BackupsCard />

      {/* System Info Card */}
      <div className="glass p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.2)' }}>
            <AlertCircle size={20} className="text-blue-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">System Information</h2>
            <p className="text-xs text-gray-500">Panel deployment details</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {[
            { label: 'Panel Directory', value: '/opt/panel' },
            { label: 'Backend Port', value: '4000' },
            { label: 'Process Manager', value: 'PM2' },
            { label: 'Web Server', value: 'NGINX' },
            { label: 'Database', value: 'PostgreSQL' },
            { label: 'Cache', value: 'Redis' },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl p-3"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">{label}</p>
              <p className="text-sm font-medium text-gray-300">{value}</p>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

/* ---- Alerts Card ---- */

interface AlertSettings {
  enabled: boolean;
  webhook_url: string;
  events: string[];
  disk_threshold: number;
  memory_threshold: number;
}

function AlertsCard() {
  const [settings, setSettings] = useState<AlertSettings>({
    enabled: false, webhook_url: '', events: ['app_crash', 'disk_full', 'high_memory'],
    disk_threshold: 90, memory_threshold: 90,
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get<AlertSettings>('/alerts').then((res) => {
      if (res.success && res.data) setSettings(res.data);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await api.put('/alerts', settings);
    setSaving(false);
    setMsg(res.success ? 'Saved' : (res.error || 'Failed'));
    setTimeout(() => setMsg(''), 3000);
  }

  async function test() {
    setTesting(true);
    const res = await api.post<{ message: string }>('/alerts/test');
    setTesting(false);
    setMsg(res.success ? 'Test alert sent!' : (res.error || 'Failed'));
    setTimeout(() => setMsg(''), 3000);
  }

  function toggleEvent(e: string) {
    setSettings((s) => ({
      ...s,
      events: s.events.includes(e) ? s.events.filter((x) => x !== e) : [...s.events, e],
    }));
  }

  return (
    <div className="glass p-6 mb-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.2)' }}>
            <Bell size={20} className="text-orange-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">Alerts</h2>
            <p className="text-xs text-gray-500">Get notified when things go wrong</p>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-gray-500">{settings.enabled ? 'Enabled' : 'Disabled'}</span>
          <input type="checkbox" checked={settings.enabled}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
            className="sr-only peer" />
          <div className="relative w-9 h-5 rounded-full bg-white/10 peer-checked:bg-violet-600 transition-colors">
            <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${settings.enabled ? 'translate-x-4' : ''}`} />
          </div>
        </label>
      </div>

      <div className="space-y-4">
        <div>
          <label className="label">Webhook URL (Discord / Slack / Custom)</label>
          <input className="input" placeholder="https://discord.com/api/webhooks/..."
            value={settings.webhook_url}
            onChange={(e) => setSettings({ ...settings, webhook_url: e.target.value })} />
        </div>

        <div>
          <label className="label">Events</label>
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'app_crash', label: 'App Crash', color: 'red' },
              { id: 'disk_full', label: 'Disk Full', color: 'amber' },
              { id: 'high_memory', label: 'High Memory', color: 'orange' },
            ].map(({ id, label, color }) => (
              <button key={id} onClick={() => toggleEvent(id)}
                className={`badge cursor-pointer transition-all ${
                  settings.events.includes(id)
                    ? `bg-${color}-500/10 text-${color}-400 border-${color}-500/20`
                    : 'bg-white/5 text-gray-500 border-white/10'
                }`}>
                <Shield size={10} /> {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Disk Threshold (%)</label>
            <input className="input" type="number" min="50" max="99"
              value={settings.disk_threshold}
              onChange={(e) => setSettings({ ...settings, disk_threshold: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Memory Threshold (%)</label>
            <input className="input" type="number" min="50" max="99"
              value={settings.memory_threshold}
              onChange={(e) => setSettings({ ...settings, memory_threshold: Number(e.target.value) })} />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button onClick={save} className="btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          <button onClick={test} className="btn-secondary" disabled={testing || !settings.webhook_url}>
            <Send size={13} /> {testing ? 'Sending...' : 'Test Webhook'}
          </button>
          {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        </div>
      </div>
    </div>
  );
}

/* ---- Backups Card ---- */

interface BackupSettings {
  enabled: boolean;
  schedule: string;
  retain_days: number;
  backup_path: string;
  s3_enabled: boolean;
  s3_endpoint: string;
  s3_bucket: string;
  s3_key: string;
  s3_secret: string;
  s3_region: string;
}

interface BackupEntry {
  id: number;
  type: string;
  filename: string;
  size_bytes: number;
  duration_ms: number;
  status: string;
  error: string;
  created_at: string;
}

function BackupsCard() {
  const [settings, setSettings] = useState<BackupSettings>({
    enabled: false, schedule: 'daily', retain_days: 7, backup_path: '/var/backups/panel',
    s3_enabled: false, s3_endpoint: '', s3_bucket: '', s3_key: '', s3_secret: '', s3_region: '',
  });
  const [history, setHistory] = useState<BackupEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const [showS3, setShowS3] = useState(false);

  useEffect(() => {
    api.get<BackupSettings>('/backups/settings').then((res) => {
      if (res.success && res.data) {
        setSettings(res.data);
        setShowS3(res.data.s3_enabled);
      }
    });
    api.get<BackupEntry[]>('/backups/history').then((res) => {
      if (res.success && res.data) setHistory(res.data);
    });
  }, []);

  async function save() {
    setSaving(true);
    const res = await api.put('/backups/settings', settings);
    setSaving(false);
    setMsg(res.success ? 'Saved' : (res.error || 'Failed'));
    setTimeout(() => setMsg(''), 3000);
  }

  async function runNow() {
    setRunning(true);
    const res = await api.post<{ message: string }>('/backups/run');
    setMsg(res.success ? 'Backup started!' : (res.error || 'Failed'));
    setTimeout(() => {
      setRunning(false);
      setMsg('');
      // Refresh history
      api.get<BackupEntry[]>('/backups/history').then((r) => {
        if (r.success && r.data) setHistory(r.data);
      });
    }, 5000);
  }

  function fmtBytes(b: number) {
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  return (
    <div className="glass p-6 mb-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.2)' }}>
            <HardDrive size={20} className="text-emerald-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">Backups</h2>
            <p className="text-xs text-gray-500">Scheduled database and config backups</p>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-gray-500">{settings.enabled ? 'Enabled' : 'Disabled'}</span>
          <input type="checkbox" checked={settings.enabled}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
            className="sr-only peer" />
          <div className="relative w-9 h-5 rounded-full bg-white/10 peer-checked:bg-emerald-600 transition-colors">
            <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${settings.enabled ? 'translate-x-4' : ''}`} />
          </div>
        </label>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">Schedule</label>
            <select className="input" value={settings.schedule}
              onChange={(e) => setSettings({ ...settings, schedule: e.target.value })}>
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <label className="label">Retain (days)</label>
            <input className="input" type="number" min="1" max="365"
              value={settings.retain_days}
              onChange={(e) => setSettings({ ...settings, retain_days: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Backup Path</label>
            <input className="input font-mono text-xs" value={settings.backup_path}
              onChange={(e) => setSettings({ ...settings, backup_path: e.target.value })} />
          </div>
        </div>

        {/* S3 / R2 toggle */}
        <div>
          <button onClick={() => setShowS3(!showS3)}
            className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors">
            {showS3 ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            S3 / R2 Offsite Storage
          </button>
          {showS3 && (
            <div className="mt-3 space-y-3 rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={settings.s3_enabled}
                  onChange={(e) => setSettings({ ...settings, s3_enabled: e.target.checked })}
                  className="rounded border-white/20 bg-white/5 text-violet-500" />
                <span className="text-xs text-gray-300">Upload backups to S3/R2</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Endpoint</label>
                  <input className="input text-xs" placeholder="https://s3.amazonaws.com"
                    value={settings.s3_endpoint}
                    onChange={(e) => setSettings({ ...settings, s3_endpoint: e.target.value })} />
                </div>
                <div>
                  <label className="label">Bucket</label>
                  <input className="input text-xs" placeholder="my-backups"
                    value={settings.s3_bucket}
                    onChange={(e) => setSettings({ ...settings, s3_bucket: e.target.value })} />
                </div>
                <div>
                  <label className="label">Access Key</label>
                  <input className="input text-xs" value={settings.s3_key}
                    onChange={(e) => setSettings({ ...settings, s3_key: e.target.value })} />
                </div>
                <div>
                  <label className="label">Secret Key</label>
                  <input className="input text-xs" type="password" value={settings.s3_secret}
                    onChange={(e) => setSettings({ ...settings, s3_secret: e.target.value })} />
                </div>
                <div>
                  <label className="label">Region</label>
                  <input className="input text-xs" placeholder="auto"
                    value={settings.s3_region}
                    onChange={(e) => setSettings({ ...settings, s3_region: e.target.value })} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button onClick={save} className="btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          <button onClick={runNow} className="btn-secondary" disabled={running}>
            <Play size={13} /> {running ? 'Running...' : 'Backup Now'}
          </button>
          {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        </div>

        {/* History */}
        {history.length > 0 && (
          <div className="mt-2">
            <p className="label mb-2">Recent Backups</p>
            <div className="space-y-1.5">
              {history.slice(0, 5).map((b) => (
                <div key={b.id} className="flex items-center justify-between rounded-xl px-3 py-2 text-xs"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center gap-3">
                    <span className={`h-2 w-2 rounded-full ${b.status === 'completed' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                    <span className="font-mono text-gray-400">{b.filename}</span>
                  </div>
                  <div className="flex items-center gap-4 text-gray-600">
                    <span>{fmtBytes(b.size_bytes)}</span>
                    <span>{b.duration_ms}ms</span>
                    <span>{new Date(b.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
