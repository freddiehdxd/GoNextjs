import { useCallback, useEffect, useState } from 'react';
import { FolderSearch, GitBranch, Globe, Download, Trash2, AlertTriangle } from 'lucide-react';
import Modal from '@/components/Modal';
import StatusBadge from '@/components/StatusBadge';
import { api, App, ScanResult, UnmanagedDir, OrphanedApp } from '@/lib/api';

const APP_TYPE_OPTIONS = [
  { value: '',       label: 'Auto-detect' },
  { value: 'next',   label: 'Next.js' },
  { value: 'vite',   label: 'Vite / SPA' },
  { value: 'node',   label: 'Node.js' },
  { value: 'static', label: 'Static HTML' },
  { value: 'custom', label: 'Custom' },
];

function fmtSize(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const Spinner = () => <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" />;

type Props = { onClose: () => void; onChanged: () => void };

export default function ScanModal({ onClose, onChanged }: Props) {
  const [scan, setScan]       = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [warning, setWarning] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const res = await api.get<ScanResult>('/apps/scan');
    if (res.success && res.data) setScan(res.data);
    else setError(res.error ?? 'Scan failed');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function changed(warn?: string) {
    if (warn) setWarning(warn);
    onChanged();
    load();
  }

  const empty = !!scan && scan.unmanaged.length === 0 && scan.orphaned.length === 0;

  return (
    <Modal title="Scan directory" description={scan ? scan.apps_dir : ''} onClose={onClose} size="lg">
      <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-1">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center"><Spinner /> Scanning…</div>
        )}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
        )}
        {warning && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{warning}</span>
            <button onClick={() => setWarning('')} className="text-amber-500 hover:text-amber-300" aria-label="Dismiss">×</button>
          </div>
        )}
        {!loading && empty && (
          <div className="flex flex-col items-center py-10 text-center">
            <FolderSearch size={28} className="text-violet-500 mb-3" />
            <p className="text-gray-300 text-sm font-semibold">Everything in {scan?.apps_dir} is managed.</p>
          </div>
        )}

        {scan && scan.unmanaged.length > 0 && (
          <section>
            <p className="label mb-3">Unmanaged directories ({scan.unmanaged.length})</p>
            <div className="space-y-3">
              {scan.unmanaged.map((d) => (
                <UnmanagedRow key={d.name} dir={d} onChanged={changed} />
              ))}
            </div>
          </section>
        )}

        {scan && scan.orphaned.length > 0 && (
          <section>
            <p className="label mb-3">Orphaned records ({scan.orphaned.length})</p>
            <p className="text-xs text-gray-600 mb-3">These apps exist in the database but their directory is gone.</p>
            <div className="space-y-3">
              {scan.orphaned.map((o) => (
                <OrphanRow key={o.name} app={o} onChanged={() => changed()} />
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

// ── Unmanaged directory row ────────────────────────────────────────────────

function UnmanagedRow({ dir, onChanged }: { dir: UnmanagedDir; onChanged: (warn?: string) => void }) {
  const [mode, setMode] = useState<'idle' | 'import' | 'delete'>('idle');
  const requiresRoot = !!dir.detected.error;

  return (
    <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm font-mono">{dir.name}</span>
            {dir.detected.app_type && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded text-gray-400"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {dir.detected.app_type}{dir.detected.root_dir && dir.detected.root_dir !== '/' ? ` · ${dir.detected.root_dir}` : ''}
              </span>
            )}
            {dir.pm2 && <StatusBadge status={dir.pm2.status} />}
            {dir.pm2 && dir.pm2.port > 0 && <code className="text-[11px] text-gray-500 font-mono">:{dir.pm2.port}</code>}
            {!dir.pm2 && dir.detected_port > 0 && (
              <code className="text-[11px] text-gray-600 font-mono">port {dir.detected_port} (from disk)</code>
            )}
          </div>
          {dir.detected.error && (
            <p className="text-xs text-amber-400 mt-1">{dir.detected.error}</p>
          )}
          <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-600 flex-wrap">
            <span>{fmtSize(dir.size_bytes)}</span>
            {dir.modified_at && <span>modified {fmtDate(dir.modified_at)}</span>}
            {dir.git && dir.git.repo_url && (
              <span className="flex items-center gap-1 truncate max-w-[260px]" title={dir.git.repo_url}>
                <GitBranch size={10} /> {dir.git.repo_url}{dir.git.branch ? ` @ ${dir.git.branch}` : ''}
              </span>
            )}
            {dir.domains.map((dom) => (
              <span key={dom} className="flex items-center gap-1 text-blue-400"><Globe size={10} /> {dom}</span>
            ))}
            {dir.has_env && <span className="font-mono">.env</span>}
            {dir.has_ecosystem && <span className="font-mono">ecosystem.config.js</span>}
          </div>
          {!dir.valid_name && (
            <p className="text-xs text-amber-400 mt-1.5">Rename the folder to lowercase letters, numbers and hyphens to import it.</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {dir.valid_name && (
            <button onClick={() => setMode(mode === 'import' ? 'idle' : 'import')} className="btn-primary text-xs">
              <Download size={12} /> Import
            </button>
          )}
          <button onClick={() => setMode(mode === 'delete' ? 'idle' : 'delete')}
            className="p-2 rounded-xl text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all" title="Delete directory" aria-label="Delete directory">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {mode === 'import' && (
        <ImportForm dir={dir} requiresRoot={requiresRoot}
          onDone={(warn) => { setMode('idle'); onChanged(warn); }} onCancel={() => setMode('idle')} />
      )}
      {mode === 'delete' && (
        <TypedConfirm
          label={`Type ${dir.name} to delete this directory and any PM2 process with that name.`}
          expected={dir.name}
          buttonLabel="Delete directory"
          onConfirm={async () => {
            const res = await api.delete(`/apps/scan/${dir.name}`);
            if (!res.success) return res.error ?? 'Delete failed';
            setMode('idle'); onChanged(); return '';
          }}
          onCancel={() => setMode('idle')}
        />
      )}
    </div>
  );
}

// ── Import form (inline) ───────────────────────────────────────────────────

function ImportForm({ dir, requiresRoot, onDone, onCancel }:
  { dir: UnmanagedDir; requiresRoot: boolean; onDone: (warn?: string) => void; onCancel: () => void }) {
  const [appType, setAppType]     = useState(dir.detected.app_type);
  const [rootDir, setRootDir]     = useState(dir.detected.root_dir || '/');
  const [outputDir, setOutputDir] = useState('dist');
  const [port, setPort]           = useState(dir.pm2?.port || dir.detected_port || 0);
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState('');

  const canSubmit = !busy && (!requiresRoot || (rootDir && rootDir !== '/'));

  async function submit() {
    setBusy(true); setErr('');
    const res = await api.post<App & { warning?: string }>('/apps/import', {
      name: dir.name,
      app_type: appType,
      root_dir: rootDir || '/',
      output_dir: outputDir || 'dist',
      port: port || 0,
    });
    setBusy(false);
    if (res.success) onDone(res.data?.warning);
    else setErr(res.error ?? 'Import failed');
  }

  return (
    <div className="mt-4 pt-4 border-t border-white/[0.06] space-y-3 animate-slide-up">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">App Type</label>
          <select className="input" value={appType} onChange={(e) => setAppType(e.target.value)}>
            {APP_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Port <span className="normal-case font-normal text-gray-700">(blank = next free)</span></label>
          <input className="input font-mono text-xs" type="number" min={0} value={port || ''}
            onChange={(e) => setPort(parseInt(e.target.value, 10) || 0)} />
        </div>
        <div>
          <label className="label">Root Directory{requiresRoot && <span className="text-amber-400 ml-1">required</span>}</label>
          <input className="input font-mono text-xs" placeholder="/" value={rootDir}
            onChange={(e) => { let v = e.target.value; if (v && !v.startsWith('/')) v = '/' + v; setRootDir(v); }} />
        </div>
        <div>
          <label className="label">Output Directory</label>
          <input className="input font-mono text-xs" placeholder="dist" value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)} />
        </div>
      </div>
      <p className="text-[11px] text-gray-600">
        Will record: {dir.git?.repo_url ? <code className="text-gray-500">{dir.git.repo_url}</code> : 'no git repository'}
        {' · '}{dir.has_env ? 'env vars from .env' : 'no .env'}
        {' · '}nothing is rebuilt or restarted.
      </p>
      {err && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost text-xs" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-primary text-xs" onClick={submit} disabled={!canSubmit}>
          {busy ? <span className="flex items-center gap-2"><Spinner /> Importing…</span> : 'Import app'}
        </button>
      </div>
    </div>
  );
}

// ── Orphaned record row ────────────────────────────────────────────────────

function OrphanRow({ app, onChanged }: { app: OrphanedApp; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm font-mono">{app.name}</span>
            <code className="text-[11px] text-gray-500 font-mono">:{app.port}</code>
            {app.pm2_status && <StatusBadge status={app.pm2_status} />}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-600 flex-wrap">
            <span>directory missing</span>
            {app.domains.map((dom) => (
              <span key={dom} className="flex items-center gap-1 text-blue-400"><Globe size={10} /> {dom}</span>
            ))}
          </div>
        </div>
        <button onClick={() => setConfirming(!confirming)} className="btn-danger text-xs shrink-0">
          <Trash2 size={12} /> Remove record
        </button>
      </div>
      {confirming && (
        <TypedConfirm
          label={`Type ${app.name} to remove this record, its PM2 entry and its NGINX configs.`}
          expected={app.name}
          buttonLabel="Remove record"
          onConfirm={async () => {
            const res = await api.post(`/apps/${app.name}/action`, { action: 'delete' });
            if (!res.success) return res.error ?? 'Remove failed';
            setConfirming(false); onChanged(); return '';
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// ── Typed-name confirmation block ──────────────────────────────────────────

function TypedConfirm({ label, expected, buttonLabel, onConfirm, onCancel }:
  { label: string; expected: string; buttonLabel: string; onConfirm: () => Promise<string>; onCancel: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');

  async function go() {
    setBusy(true); setErr('');
    const e = await onConfirm();
    setBusy(false);
    if (e) setErr(e);
  }

  return (
    <div className="mt-4 pt-4 border-t border-white/[0.06] space-y-2 animate-slide-up">
      <p className="text-xs text-red-400">{label}</p>
      <div className="flex gap-2">
        <input className="input font-mono text-xs flex-1" placeholder={expected} value={typed}
          onChange={(e) => setTyped(e.target.value)} autoFocus />
        <button className="btn-ghost text-xs" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-danger text-xs" onClick={go} disabled={busy || typed !== expected}>
          {busy ? <Spinner /> : buttonLabel}
        </button>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
