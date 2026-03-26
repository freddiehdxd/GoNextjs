import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Folder, FileText, ChevronRight, Upload, Save, ArrowLeft, Home,
  FolderOpen, Edit3, ChevronDown,
} from 'lucide-react';
import Shell from '@/components/Shell';
import { api, App } from '@/lib/api';

interface FsEntry { name: string; type: 'dir' | 'file'; path: string }

function AppDropdown({ apps, value, onChange }: {
  apps: App[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = apps.find(a => a.name === value);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  return (
    <div ref={ref} className="relative w-44">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-sm transition-colors focus:outline-none focus:border-violet-500/50"
        style={{ background: 'rgba(255,255,255,0.05)', color: selected ? '#e5e7eb' : '#6b7280' }}>
        <span className="truncate">{selected ? selected.name : 'Select app...'}</span>
        <ChevronDown size={13} className={`text-gray-500 shrink-0 ml-1 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg overflow-hidden shadow-xl"
          style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }}>
          <button type="button"
            onClick={() => { onChange(''); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm transition-colors ${!value ? 'bg-violet-600/30 text-violet-300' : 'text-gray-500 hover:bg-white/[0.06]'}`}>
            Select app...
          </button>
          {apps.map(a => (
            <button key={a.id} type="button"
              onClick={() => { onChange(a.name); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors
                ${a.name === value ? 'bg-violet-600/30 text-violet-300' : 'text-gray-300 hover:bg-white/[0.06]'}`}>
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FilesPage() {
  const [apps,        setApps]        = useState<App[]>([]);
  const [selectedApp, setSelectedApp] = useState('');
  const [path,        setPath]        = useState('');
  const [entries,     setEntries]     = useState<FsEntry[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [editing,     setEditing]     = useState<{ path: string; content: string } | null>(null);
  const [saving,      setSaving]      = useState(false);
  const [saved,       setSaved]       = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<App[]>('/apps').then((r) => { if (r.data) setApps(r.data); });
  }, []);

  const browse = useCallback(async (app: string, dir: string) => {
    if (!app) return;
    setLoading(true);
    const res = await api.get<FsEntry[]>(`/files/${app}?path=${encodeURIComponent(dir)}`);
    if (res.success && res.data) setEntries(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { if (selectedApp) browse(selectedApp, path); }, [selectedApp, path, browse]);

  async function openFile(entry: FsEntry) {
    const res = await api.get<{ content: string }>(`/files/${selectedApp}/content?path=${encodeURIComponent(entry.path)}`);
    if (res.success && res.data) setEditing({ path: entry.path, content: res.data.content });
  }

  async function saveFile() {
    if (!editing) return;
    setSaving(true);
    await api.put(`/files/${selectedApp}/content?path=${encodeURIComponent(editing.path)}`, { content: editing.content });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function uploadFiles(files: FileList) {
    const form = new FormData();
    Array.from(files).forEach((f) => form.append('files', f));
    await fetch(`/api/files/${selectedApp}/upload?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      credentials: 'same-origin', // HttpOnly cookie sent automatically
      body: form,
    });
    browse(selectedApp, path);
  }

  function goUp() {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    setPath(parts.join('/'));
  }

  const pathParts = path.split('/').filter(Boolean);

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">File Manager</h1>
        <p className="text-sm text-gray-600 mt-1">Browse and edit app files</p>
      </div>

      {/* File editor view */}
      {editing ? (
        <div className="space-y-4 animate-slide-up">
          {/* Editor toolbar */}
          <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
            <button onClick={() => setEditing(null)} className="btn-ghost text-xs py-1.5 px-3">
              <ArrowLeft size={13} /> Back
            </button>
            <ChevronRight size={13} className="text-gray-700" />
            <span className="text-gray-400 text-xs font-mono flex-1 truncate">{editing.path}</span>
            <button
              className={`text-xs ${saved ? 'btn-success' : 'btn-primary'} py-1.5`}
              onClick={saveFile}
              disabled={saving}
            >
              <Save size={13} />
              {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save'}
            </button>
          </div>

          {/* Code textarea */}
          <div className="rounded-2xl border border-white/[0.07] overflow-hidden"
            style={{ background: 'rgba(0,0,0,0.3)' }}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06]"
              style={{ background: 'rgba(255,255,255,0.02)' }}>
              <FileText size={13} className="text-gray-600" />
              <span className="text-xs text-gray-500 font-mono">{editing.path.split('/').pop()}</span>
            </div>
            <textarea
              className="w-full bg-transparent px-5 py-4 font-mono text-xs text-gray-300 focus:outline-none resize-none leading-relaxed"
              style={{ minHeight: '60vh' }}
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              spellCheck={false}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* App selector */}
            <AppDropdown
              apps={apps}
              value={selectedApp}
              onChange={(v) => { setSelectedApp(v); setPath(''); }}
            />

            {/* Breadcrumb */}
            {selectedApp && (
              <div className="flex items-center gap-1 flex-1 min-w-0 text-sm">
                <button
                  onClick={() => setPath('')}
                  className="flex items-center gap-1.5 text-gray-500 hover:text-white transition-colors rounded-lg px-2 py-1"
                >
                  <Home size={12} />
                  <span className="text-xs">{selectedApp}</span>
                </button>
                {pathParts.map((seg, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <ChevronRight size={12} className="text-gray-700" />
                    <button
                      onClick={() => setPath(pathParts.slice(0, i + 1).join('/'))}
                      className={`text-xs rounded-lg px-2 py-1 transition-colors ${
                        i === pathParts.length - 1
                          ? 'text-white font-medium'
                          : 'text-gray-500 hover:text-white'
                      }`}
                    >
                      {seg}
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Actions */}
            {selectedApp && (
              <div className="flex gap-2 ml-auto shrink-0">
                {path && (
                  <button onClick={goUp} className="btn-ghost text-xs py-1.5">
                    <ArrowLeft size={12} /> Up
                  </button>
                )}
                <button onClick={() => fileInput.current?.click()} className="btn-ghost text-xs py-1.5">
                  <Upload size={12} /> Upload
                </button>
                <input
                  ref={fileInput} type="file" multiple className="hidden"
                  onChange={(e) => e.target.files && uploadFiles(e.target.files)}
                />
              </div>
            )}
          </div>

          {/* File listing */}
          {selectedApp ? (
            <div className="rounded-2xl border border-white/[0.07] overflow-hidden"
              style={{ background: 'rgba(255,255,255,0.015)' }}>
              {/* Header */}
              <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.05]"
                style={{ background: 'rgba(255,255,255,0.02)' }}>
                <FolderOpen size={14} className="text-violet-400" />
                <span className="text-xs text-gray-500 font-mono">
                  /var/www/apps/{selectedApp}{path ? '/' + path : ''}
                </span>
              </div>

              {loading ? (
                <div className="p-6 space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="h-9 rounded-lg shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
                  ))}
                </div>
              ) : entries.length === 0 ? (
                <div className="p-10 text-center">
                  <p className="text-gray-600 text-sm">Empty directory</p>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {entries
                    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
                    .map((entry) => (
                      <button
                        key={entry.path}
                        onClick={() => entry.type === 'dir' ? setPath(entry.path) : openFile(entry)}
                        className="w-full flex items-center gap-3 px-5 py-3 text-sm hover:bg-white/[0.03] transition-colors text-left group"
                      >
                        {entry.type === 'dir'
                          ? <Folder size={15} className="text-violet-400 shrink-0" />
                          : <FileText size={15} className="text-gray-600 shrink-0" />}
                        <span className={entry.type === 'dir' ? 'text-gray-200 font-medium' : 'text-gray-400'}>
                          {entry.name}
                        </span>
                        {entry.type === 'file' && (
                          <Edit3 size={11} className="ml-auto text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                        {entry.type === 'dir' && (
                          <ChevronRight size={12} className="ml-auto text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </button>
                    ))}
                </div>
              )}
            </div>
          ) : (
            <div className="card flex flex-col items-center justify-center py-24 text-center"
              style={{ background: 'rgba(255,255,255,0.01)' }}>
              <div className="h-16 w-16 rounded-2xl flex items-center justify-center mb-5"
                style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.15)' }}>
                <FolderOpen size={28} className="text-violet-500" />
              </div>
              <p className="text-gray-300 font-semibold mb-1.5">Select an app</p>
              <p className="text-gray-600 text-sm">Choose an app from the dropdown to browse its files</p>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}
