'use client';
import { useEffect, useState, useCallback } from 'react';
import { Database as DbIcon, Plus, Trash2, Copy, Check } from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { api, ManagedDb } from '@/lib/api';

interface DbWithConn extends ManagedDb { connection_string?: string }

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      onClick={copy}
      className="p-1.5 rounded-lg text-gray-600 hover:text-white hover:bg-white/5 transition-all"
      title="Copy"
    >
      {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
    </button>
  );
}

export default function DatabasesPage() {
  const [dbs,     setDbs]     = useState<DbWithConn[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [error,   setError]   = useState('');
  const [saving,  setSaving]  = useState(false);
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
    if (!confirm(`Delete database "${name}"? This is irreversible.`)) return;
    await api.delete(`/databases/${name}`);
    await fetchDbs();
  }

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Databases</h1>
          <p className="text-sm text-gray-600 mt-1">
            {loading ? 'Loading…' : `${dbs.length} PostgreSQL database${dbs.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary">
          <Plus size={14} /> New Database
        </button>
      </div>

      {/* New connection string banner */}
      {newConn && (
        <div className="mb-6 card animate-slide-up" style={{ borderColor: 'rgba(16,185,129,0.25)', background: 'rgba(16,185,129,0.05)' }}>
          <div className="flex items-start gap-3 mb-3">
            <div className="h-8 w-8 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }}>
              <DbIcon size={15} className="text-emerald-400" />
            </div>
            <div>
              <p className="text-emerald-400 font-semibold text-sm">Database created successfully!</p>
              <p className="text-xs text-gray-500 mt-0.5">Save this connection string now — the password will not be shown again.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 font-mono text-xs text-gray-300">
            <span className="flex-1 break-all">{newConn}</span>
            <CopyButton text={newConn} />
          </div>
          <button onClick={() => setNewConn(null)} className="btn-ghost mt-3 text-xs">Dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="card h-24 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
          ))}
        </div>
      ) : dbs.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-24 text-center"
          style={{ background: 'rgba(255,255,255,0.01)' }}>
          <div className="h-16 w-16 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
            <DbIcon size={28} className="text-amber-500" />
          </div>
          <p className="text-gray-300 font-semibold mb-1.5">No databases yet</p>
          <p className="text-gray-600 text-sm mb-6">Create a PostgreSQL database for your application</p>
          <button onClick={() => setShowNew(true)} className="btn-primary">
            <Plus size={14} /> Create Database
          </button>
        </div>
      ) : (
        <div className="space-y-3 animate-slide-up">
          {dbs.map((db) => (
            <div key={db.id} className="card hover:border-white/[0.1] transition-all duration-200 group"
              style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4 min-w-0 flex-1">
                  {/* DB icon */}
                  <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
                    <DbIcon size={17} className="text-amber-500" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-white text-sm">{db.name}</p>
                      <span className="badge-yellow">PostgreSQL</span>
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">
                      User: <code className="text-gray-500 font-mono">{db.db_user}</code>
                    </p>

                    {/* Connection string preview */}
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                      <code className="text-xs text-gray-500 font-mono flex-1 truncate">
                        postgresql://{db.db_user}:{'•'.repeat(12)}@localhost:5432/{db.name}
                      </code>
                      <CopyButton text={`postgresql://${db.db_user}:***@localhost:5432/${db.name}`} />
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => deleteDb(db.name)}
                  className="p-2 rounded-xl text-gray-700 hover:text-red-400 hover:bg-red-500/10 transition-all opacity-0 group-hover:opacity-100 shrink-0"
                  title="Delete database"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showNew && (
        <Modal title="Create Database" onClose={() => { setShowNew(false); setError(''); }}>
          <div className="space-y-4">
            <div>
              <label className="label">Database Name</label>
              <input
                className="input"
                placeholder="myapp_production"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
              />
              <p className="text-xs text-gray-600 mt-1.5">Lowercase letters, numbers and underscores</p>
            </div>
            <div>
              <label className="label">Database User</label>
              <input
                className="input"
                placeholder="myapp_user"
                value={form.user}
                onChange={(e) => setForm({ ...form, user: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
              />
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-xs text-gray-500">
              A strong random password will be generated automatically.
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">{error}</div>
            )}

            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => { setShowNew(false); setError(''); }}>Cancel</button>
              <button
                className="btn-primary"
                onClick={createDb}
                disabled={saving || !form.name || !form.user}
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Creating…
                  </span>
                ) : (
                  <><DbIcon size={13} /> Create</>
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Shell>
  );
}
