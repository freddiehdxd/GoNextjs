import { useEffect, useState, useCallback } from 'react';
import { Globe, Plus, Trash2, ExternalLink, ShieldCheck, Shield } from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { api, App, Domain } from '@/lib/api';

type DomainEntry = Domain & { appName: string; port: number };

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
    if (res.success) { setShowAdd(false); setForm({ app_name: '', domain: '' }); await fetchApps(); }
    else setError(res.error ?? 'Failed to add domain');
  }

  async function removeDomain(domain: string) {
    if (!confirm(`Remove domain ${domain}? NGINX config will be deleted.`)) return;
    await api.delete(`/domains/${domain}`);
    await fetchApps();
  }

  const allDomains: DomainEntry[] = apps.flatMap(app =>
    app.domains.map(d => ({ ...d, appName: app.name, port: app.port }))
  );

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Domains</h1>
          <p className="text-sm text-gray-600 mt-1">
            {loading ? 'Loading...' : `${allDomains.length} domain${allDomains.length !== 1 ? 's' : ''} configured`}
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary">
          <Plus size={14} /> Add Domain
        </button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="card h-20 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
          ))}
        </div>
      ) : allDomains.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-24 text-center"
          style={{ background: 'rgba(255,255,255,0.01)' }}>
          <div className="h-16 w-16 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.15)' }}>
            <Globe size={28} className="text-cyan-500" />
          </div>
          <p className="text-gray-300 font-semibold mb-1.5">No domains configured</p>
          <p className="text-gray-600 text-sm mb-6">Add a domain to expose your apps to the internet via NGINX</p>
          <button onClick={() => setShowAdd(true)} className="btn-primary">
            <Plus size={14} /> Add Domain
          </button>
        </div>
      ) : (
        <div className="space-y-3 animate-slide-up">
          {allDomains.map((d) => (
            <div key={d.id} className="card hover:border-white/[0.1] transition-all duration-200 group"
              style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 min-w-0">
                  {/* Domain icon */}
                  <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.15)' }}>
                    <Globe size={18} className="text-cyan-500" />
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={`http${d.ssl_enabled ? 's' : ''}://${d.domain}`}
                        target="_blank" rel="noreferrer"
                        className="flex items-center gap-1.5 font-semibold text-white hover:text-cyan-300 transition-colors text-sm"
                      >
                        {d.domain}
                        <ExternalLink size={11} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                      </a>
                      {d.ssl_enabled ? (
                        <span className="badge-green">
                          <ShieldCheck size={10} /> SSL
                        </span>
                      ) : (
                        <span className="badge-gray">
                          <Shield size={10} /> No SSL
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">
                      Proxied to <span className="text-gray-500 font-medium">{d.appName}</span> on port <code className="font-mono">{d.port}</code>
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => removeDomain(d.domain)}
                  className="p-2 rounded-xl text-gray-700 hover:text-red-400 hover:bg-red-500/10 transition-all opacity-0 group-hover:opacity-100"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Domain Modal */}
      {showAdd && (
        <Modal title="Add Domain" onClose={() => { setShowAdd(false); setError(''); setForm({ app_name: '', domain: '' }); }}>
          <div className="space-y-4">
            <div>
              <label className="label">App</label>
              <select
                className="input"
                value={form.app_name}
                onChange={(e) => setForm({ ...form, app_name: e.target.value })}
              >
                <option value="">Select an app...</option>
                {apps.map((a) => <option key={a.id} value={a.name}>{a.name} (:{a.port})</option>)}
              </select>
            </div>
            <div>
              <label className="label">Domain</label>
              <input
                className="input"
                placeholder="app.example.com"
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value.trim().toLowerCase() })}
              />
              <p className="text-xs text-gray-600 mt-1.5">Ensure this domain's DNS A record points to this server's IP</p>
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">{error}</div>
            )}

            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => { setShowAdd(false); setError(''); }}>Cancel</button>
              <button
                className="btn-primary"
                onClick={addDomain}
                disabled={saving || !form.app_name || !form.domain}
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Adding...
                  </span>
                ) : 'Add Domain'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Shell>
  );
}
