import { useEffect, useState, useCallback } from 'react';
import { Shield, ShieldCheck, ShieldOff, Lock, Unlock, CheckCircle2 } from 'lucide-react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { api, App, Domain } from '@/lib/api';

type DomainEntry = Domain & { appName: string; port: number };

export default function SSLPage() {
  const [apps,     setApps]     = useState<App[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState<DomainEntry | null>(null);
  const [email,    setEmail]    = useState('');
  const [issuing,  setIssuing]  = useState(false);
  const [disabling, setDisabling] = useState<DomainEntry | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  const fetchApps = useCallback(async () => {
    const res = await api.get<App[]>('/apps');
    if (res.success && res.data) setApps(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  const allDomains: DomainEntry[] = apps.flatMap(app =>
    app.domains.map(d => ({ ...d, appName: app.name, port: app.port }))
  );

  async function issueSSL() {
    if (!selected) return;
    setIssuing(true); setError(''); setSuccess('');
    const res = await api.post('/ssl', { domain: selected.domain, email });
    setIssuing(false);
    if (res.success) {
      setSuccess(`SSL certificate issued for ${selected.domain}`);
      setSelected(null);
      await fetchApps();
    } else {
      setError(res.error ?? 'Failed to issue SSL certificate');
    }
  }

  async function disableSSL() {
    if (!disabling) return;
    setRemoving(true); setError(''); setSuccess('');
    const res = await api.post('/ssl/disable', { domain: disabling.domain });
    setRemoving(false);
    if (res.success) {
      setSuccess(`SSL disabled for ${disabling.domain}`);
      setDisabling(null);
      await fetchApps();
    } else {
      setError(res.error ?? 'Failed to disable SSL');
    }
  }

  const secured  = allDomains.filter((d) => d.ssl_enabled).length;
  const unsecured = allDomains.filter((d) => !d.ssl_enabled).length;

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">SSL Certificates</h1>
        <p className="text-sm text-gray-600 mt-1">
          Free TLS via Let's Encrypt · Requires valid DNS pointing to this server
        </p>
      </div>

      {/* Success banner */}
      {success && (
        <div className="mb-6 flex items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/8 px-5 py-4 animate-slide-up">
          <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />
          <p className="text-emerald-400 text-sm font-medium">{success}</p>
          <button onClick={() => setSuccess('')} className="ml-auto text-emerald-600 hover:text-emerald-400 text-xs">Dismiss</button>
        </div>
      )}

      {/* Stats row */}
      {!loading && allDomains.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { label: 'Total Domains', value: allDomains.length,  color: '#8b5cf6', icon: Shield },
            { label: 'SSL Active',    value: secured,       color: '#10b981', icon: ShieldCheck },
            { label: 'Not Secured',   value: unsecured,     color: '#f59e0b', icon: ShieldOff },
          ].map(({ label, value, color, icon: Icon }) => (
            <div key={label} className="rounded-2xl px-5 py-4 flex items-center gap-4"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: `${color}10`, border: `1px solid ${color}20` }}>
                <Icon size={16} style={{ color }} />
              </div>
              <div>
                <p className="text-xl font-bold text-white leading-none">{value}</p>
                <p className="text-[11px] text-gray-600 mt-0.5">{label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

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
            style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)' }}>
            <Shield size={28} className="text-emerald-500" />
          </div>
          <p className="text-gray-300 font-semibold mb-1.5">No domains with SSL</p>
          <p className="text-gray-600 text-sm">Add a domain to an app first, then issue an SSL certificate here</p>
        </div>
      ) : (
        <div className="space-y-3 animate-slide-up">
          {allDomains.map((d) => (
            <div key={d.id} className="card hover:border-white/[0.1] transition-all duration-200 group"
              style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {/* Shield icon */}
                  <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                    style={d.ssl_enabled
                      ? { background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }
                      : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    {d.ssl_enabled
                      ? <ShieldCheck size={18} className="text-emerald-400" />
                      : <ShieldOff size={18} className="text-gray-600" />}
                  </div>

                  <div>
                    <div className="flex items-center gap-2.5">
                      <p className="font-semibold text-white text-sm">{d.domain}</p>
                      {d.ssl_enabled
                        ? <span className="badge-green"><Lock size={9} /> Active</span>
                        : <span className="badge-gray">Not secured</span>}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">App: <span className="text-gray-500">{d.appName}</span></p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {d.ssl_enabled ? (
                    <>
                      <span className="btn-success opacity-60 cursor-default">
                        <ShieldCheck size={13} /> Secured
                      </span>
                      <button
                        onClick={() => { setDisabling(d); setError(''); setSuccess(''); }}
                        className="btn-ghost text-xs !text-red-400 hover:!bg-red-500/10"
                      >
                        <Unlock size={12} /> Disable
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => { setSelected(d); setError(''); setSuccess(''); }}
                      className="btn-primary"
                    >
                      <Lock size={13} /> Issue SSL
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Issue SSL Modal */}
      {selected && (
        <Modal title={`Issue SSL — ${selected.domain}`} onClose={() => { setSelected(null); setError(''); }}>
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/5 px-4 py-3">
              <p className="text-sm text-gray-400">
                Certbot will contact Let's Encrypt to verify ownership of{' '}
                <strong className="text-white">{selected.domain}</strong> and issue a free TLS certificate.
              </p>
            </div>

            <div>
              <label className="label">Email Address</label>
              <input
                className="input"
                type="email"
                placeholder="admin@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="text-xs text-gray-600 mt-1.5">Used by Let's Encrypt for renewal notices only</p>
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">{error}</div>
            )}

            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => { setSelected(null); setError(''); }}>Cancel</button>
              <button className="btn-primary" onClick={issueSSL} disabled={issuing || !email}>
                {issuing ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Issuing...
                  </span>
                ) : (
                  <><ShieldCheck size={13} /> Issue Certificate</>
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {/* Disable SSL Modal */}
      {disabling && (
        <Modal title={`Disable SSL — ${disabling.domain}`} onClose={() => { setDisabling(null); setError(''); }}>
          <div className="space-y-4">
            <div className="rounded-xl border border-red-500/15 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-gray-400">
                This will revert <strong className="text-white">{disabling.domain}</strong> to HTTP-only.
                The NGINX config will be rewritten without SSL. Existing certificates will remain on disk
                but won't be used.
              </p>
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">{error}</div>
            )}

            <div className="flex gap-3 justify-end">
              <button className="btn-ghost" onClick={() => { setDisabling(null); setError(''); }}>Cancel</button>
              <button className="btn-danger" onClick={disableSSL} disabled={removing}>
                {removing ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Disabling...
                  </span>
                ) : (
                  <><ShieldOff size={13} /> Disable SSL</>
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Shell>
  );
}
