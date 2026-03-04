'use client';
import { useEffect, useState, useCallback } from 'react';
import { Database as DbIcon, Plus, Trash2, Copy, Eye, EyeOff } from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { api, ManagedDb } from '@/lib/api';

interface DbWithConn extends ManagedDb { connection_string?: string }

export default function DatabasesPage() {
  const [dbs,     setDbs]     = useState<DbWithConn[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [error,   setError]   = useState('');
  const [saving,  setSaving]  = useState(false);
  const [reveal,  setReveal]  = useState<string | null>(null);
  const [newConn, setNewConn] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', user: '' });

  const fetchDbs = useCallback(async () => {
    const res = await api.get<ManagedDb[]>('/databases');
    if (res.success && res.data) setDbs(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchDbs(); }, [fetchDbs]);

  async function createDb() {
    setSaving(true); setError('');
    const res = await api.post<DbWithConn>('/databases', form);
    setSaving(false);
    if (res.success && res.data) {
      setNewConn(res.data.connection_string ?? null);
      setShowNew(false);
      setForm({ name: '', user: '' });
      await fetchDbs();
    } else {
      setError(res.error ?? 'Failed to create database');
    }
  }

  async function deleteDb(name: string) {
    if (!confirm(`Delete database ${name}? This is irreversible.`)) return;
    await api.delete(`/databases/${name}`);
    await fetchDbs();
  }

  function copy(text: string) { navigator.clipboard.writeText(text); }

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-white">Databases</h1>
        <button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New Database</button>
      </div>

      {newConn && (
        <div className="mb-6 card border-emerald-700/50">
          <p className="text-emerald-400 font-medium mb-2">Database created! Save your connection string:</p>
          <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 font-mono text-xs text-gray-300">
            <span className="flex-1 break-all">{newConn}</span>
            <button onClick={() => copy(newConn)} className="text-gray-400 hover:text-white"><Copy size={14} /></button>
          </div>
          <p className="text-xs text-gray-500 mt-2">This password will not be shown again.</p>
          <button onClick={() => setNewConn(null)} className="btn-ghost mt-3 text-xs">Dismiss</button>
        </div>
      )}

      {loading ? <p className="text-gray-500">Loading…</p> : (
        <div className="space-y-3">
          {dbs.length === 0 && (
            <div className="card text-center py-12">
              <DbIcon size={40} className="mx-auto text-gray-700 mb-3" />
              <p className="text-gray-400">No databases yet.</p>
            </div>
          )}
          {dbs.map((db) => (
            <div key={db.id} className="card flex items-center justify-between">
              <div>
                <p className="font-medium text-white">{db.name}</p>
                <p className="text-sm text-gray-400 mt-0.5">User: <code className="text-gray-300">{db.db_user}</code></p>
                <div className="flex items-center gap-2 mt-2">
                  <code className="text-xs text-gray-500 font-mono">
                    postgresql://{db.db_user}:{'•'.repeat(12)}@localhost:5432/{db.name}
                  </code>
                </div>
              </div>
              <button onClick={() => deleteDb(db.name)} className="text-gray-600 hover:text-red-400 transition-colors p-2">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <Modal title="Create Database" onClose={() => { setShowNew(false); setError(''); }}>
          <div className="space-y-4">
            <div>
              <label className="label">Database Name</label>
              <input className="input" placeholder="myapp_production" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <p className="text-xs text-gray-500 mt-1">Lowercase letters, numbers, underscores</p>
            </div>
            <div>
              <label className="label">Database User</label>
              <input className="input" placeholder="myapp_user" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
            </div>
            <p className="text-xs text-gray-500">A strong password will be generated automatically.</p>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
              <button className="btn-primary" onClick={createDb} disabled={saving || !form.name || !form.user}>
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Shell>
  );
}
