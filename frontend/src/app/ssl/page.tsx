'use client';
import { useEffect, useState, useCallback } from 'react';
import { Shield, ShieldCheck, ShieldOff } from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { api, App } from '@/lib/api';

export default function SSLPage() {
  const [apps,     setApps]     = useState<App[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState<App | null>(null);
  const [email,    setEmail]    = useState('');
  const [issuing,  setIssuing]  = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  const fetchApps = useCallback(async () => {
    const res = await api.get<App[]>('/apps');
    if (res.success && res.data) setApps(res.data.filter((a) => a.domain));
    setLoading(false);
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  async function issueSSL() {
    if (!selected) return;
    setIssuing(true); setError(''); setSuccess('');
    const res = await api.post('/ssl', { app_name: selected.name, email });
    setIssuing(false);
    if (res.success) {
      setSuccess(`SSL issued for ${selected.domain}`);
      setSelected(null);
      await fetchApps();
    } else {
      setError(res.error ?? 'Failed to issue SSL');
    }
  }

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">SSL Certificates</h1>
        <p className="text-sm text-gray-400 mt-1">Let's Encrypt via Certbot — requires a valid domain pointing to this server</p>
      </div>

      {success && <div className="mb-4 rounded-lg bg-emerald-900/40 border border-emerald-700 px-4 py-3 text-emerald-400 text-sm">{success}</div>}

      {loading ? <p className="text-gray-500">Loading…</p> : (
        <div className="space-y-3">
          {apps.length === 0 && (
            <div className="card text-center py-12">
              <Shield size={40} className="mx-auto text-gray-700 mb-3" />
              <p className="text-gray-400">No apps with domains found. Add a domain first.</p>
            </div>
          )}
          {apps.map((app) => (
            <div key={app.id} className="card flex items-center justify-between">
              <div className="flex items-center gap-4">
                {app.ssl_enabled
                  ? <ShieldCheck size={20} className="text-emerald-400" />
                  : <ShieldOff size={20} className="text-gray-600" />}
                <div>
                  <p className="font-medium text-white">{app.domain}</p>
                  <p className="text-sm text-gray-400">{app.name}</p>
                </div>
                {app.ssl_enabled
                  ? <span className="badge-green">Active</span>
                  : <span className="badge-gray">Not enabled</span>}
              </div>
              <button
                onClick={() => { setSelected(app); setError(''); setSuccess(''); }}
                className="btn-primary"
                disabled={app.ssl_enabled}
              >
                {app.ssl_enabled ? 'Enabled' : 'Issue SSL'}
              </button>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <Modal title={`Issue SSL for ${selected.domain}`} onClose={() => setSelected(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              Certbot will contact Let's Encrypt to verify ownership of <strong className="text-white">{selected.domain}</strong> and issue a certificate.
            </p>
            <div>
              <label className="label">Email (for renewal notices)</label>
              <input className="input" type="email" placeholder="admin@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => setSelected(null)}>Cancel</button>
              <button className="btn-primary" onClick={issueSSL} disabled={issuing || !email}>
                {issuing ? 'Issuing…' : 'Issue Certificate'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Shell>
  );
}
