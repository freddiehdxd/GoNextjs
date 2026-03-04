'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Folder, FileText, ChevronRight, Upload, Edit3, Save, ArrowLeft } from 'lucide-react';
import Shell from '@/components/Shell';
import { api, App } from '@/lib/api';

interface FsEntry { name: string; type: 'dir' | 'file'; path: string }

export default function FilesPage() {
  const [apps,       setApps]       = useState<App[]>([]);
  const [selectedApp,setSelectedApp] = useState('');
  const [path,       setPath]        = useState('');
  const [entries,    setEntries]     = useState<FsEntry[]>([]);
  const [loading,    setLoading]     = useState(false);
  const [editing,    setEditing]     = useState<{ path: string; content: string } | null>(null);
  const [saving,     setSaving]      = useState(false);
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
    setSaving(false);
    setEditing(null);
  }

  async function uploadFiles(files: FileList) {
    const form = new FormData();
    Array.from(files).forEach((f) => form.append('files', f));
    const token = localStorage.getItem('panel_token');
    await fetch(`/api/files/${selectedApp}/upload?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    browse(selectedApp, path);
  }

  function goUp() {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    setPath(parts.join('/'));
  }

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">File Manager</h1>
      </div>

      {editing ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={() => setEditing(null)} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
            <span className="text-gray-400 text-sm font-mono">{editing.path}</span>
          </div>
          <textarea
            className="input w-full h-[60vh] font-mono text-xs resize-none"
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
          />
          <div className="flex gap-3">
            <button className="btn-primary" onClick={saveFile} disabled={saving}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save File'}
            </button>
            <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <select
              className="input w-48"
              value={selectedApp}
              onChange={(e) => { setSelectedApp(e.target.value); setPath(''); }}
            >
              <option value="">Select app…</option>
              {apps.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>

            {selectedApp && (
              <>
                <div className="flex items-center gap-1 text-sm text-gray-400">
                  <button onClick={() => setPath('')} className="hover:text-white">{selectedApp}</button>
                  {path.split('/').filter(Boolean).map((seg, i, arr) => (
                    <span key={i} className="flex items-center gap-1">
                      <ChevronRight size={12} />
                      <button
                        onClick={() => setPath(arr.slice(0, i + 1).join('/'))}
                        className="hover:text-white"
                      >{seg}</button>
                    </span>
                  ))}
                </div>

                <div className="ml-auto flex gap-2">
                  {path && (
                    <button onClick={goUp} className="btn-ghost text-xs"><ArrowLeft size={12} /> Up</button>
                  )}
                  <button onClick={() => fileInput.current?.click()} className="btn-ghost text-xs">
                    <Upload size={12} /> Upload
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => e.target.files && uploadFiles(e.target.files)}
                  />
                </div>
              </>
            )}
          </div>

          {selectedApp && (
            <div className="card p-0 overflow-hidden">
              {loading ? (
                <p className="p-6 text-gray-500 text-sm">Loading…</p>
              ) : entries.length === 0 ? (
                <p className="p-6 text-gray-500 text-sm">Empty directory</p>
              ) : (
                <div className="divide-y divide-gray-800/50">
                  {entries.map((entry) => (
                    <button
                      key={entry.path}
                      onClick={() => entry.type === 'dir' ? setPath(entry.path) : openFile(entry)}
                      className="w-full flex items-center gap-3 px-5 py-3 text-sm hover:bg-gray-800/40 transition-colors text-left"
                    >
                      {entry.type === 'dir'
                        ? <Folder size={16} className="text-brand-500 shrink-0" />
                        : <FileText size={16} className="text-gray-500 shrink-0" />}
                      <span className={entry.type === 'dir' ? 'text-white' : 'text-gray-300'}>
                        {entry.name}
                      </span>
                      {entry.type === 'file' && (
                        <Edit3 size={12} className="ml-auto text-gray-600" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}
