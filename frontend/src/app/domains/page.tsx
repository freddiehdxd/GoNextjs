'use client';
import { useEffect, useState, useCallback } from 'react';
import { Globe, Plus, Trash2 } from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { api, App } from '@/lib/api';

export default function DomainsPage() {
  const [apps,    setApps]    = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [error,   setError]   = useState('');
  const [saving,  setSaving]  = useState(false);
  const [form, setForm] = useState({ app_name: '', domain: '' });

  const fetchApps = useCallback(async () => {
    const res = await api.get<App[]>('/apps');
    if (res.success && res.data) setApps(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  async function addDomain() {
    setSaving(true); setError('');
    const res = await api.post('/domains', form);
    setSaving(false);
    if (res.success) { setShowAdd(false); await fetchApps(); }
    else setError(res.error ?? 'Failed');
  }

  async function removeDomain(domain: string) {
    if (!confirm(`Remove domain ${domain}?`)) return;
    await api.delete(`/domains/${domain}`);
    await fetchApps();
  }

  const withDomains = apps.filter((a) => a.domain);

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-white">Domains</h1>
        <button onClick={() => setShowAdd(true)} className="btn-primary"><Plus size={14} /> Add Domain</button>
      </div>

      {loading ? <p className="text-gray-500">Loading…</p> : (
        <div className="space-y-3">
          {withDomains.length === 0 && (
            <div className="card text-center py-12">
              <Globe size={40} className="mx-auto text-gray-700 mb-3" />
              <p className="text-gray-400">No domains configured.</p>
            </div>
          )}
          {withDomains.map((app) => (
            <div key={app.id} className="card flex items-center justify-between">
              <div>
                <p className="font-medium text-white">{app.domain}</p>
                <p className="text-sm text-gray-400 mt-0.5">→ {app.name} (:{app.port})</p>
                <p className="text-xs mt-1">
                  {app.ssl_enabled
                    ? <span className="badge-green">SSL active</span>
                    : <span className="badge-gray">No SSL</span>}
                </p>
              </div>
              <button onClick={() => removeDomain(app.domain!)} className="text-gray-600 hover:text-red-400 transition-colors p-2">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <Modal title="Add Domain" onClose={() => { setShowAdd(false); setError(''); }}>
          <div className="space-y-4">
            <div>
              <label className="label">App</label>
              <select className="input" value={form.app_name} onChange={(e) => setForm({ ...form, app_name: e.target.value })}>
                <option value="">Select app…</option>
                {apps.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Domain</label>
              <input className="input" placeholder="app.example.com" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn-primary" onClick={addDomain} disabled={saving || !form.app_name || !form.domain}>
                {saving ? 'Saving…' : 'Add Domain'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Shell>
  );
}
