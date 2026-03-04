'use client';
import { useEffect, useState, useCallback } from 'react';
import { Cpu, Copy, CheckCircle, XCircle } from 'lucide-react';
import Shell from '@/components/Shell';
import { api, RedisInfo } from '@/lib/api';

export default function RedisPage() {
  const [info,       setInfo]       = useState<RedisInfo | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error,      setError]      = useState('');

  const fetchInfo = useCallback(async () => {
    const res = await api.get<RedisInfo>('/redis');
    if (res.success && res.data) setInfo(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchInfo(); }, [fetchInfo]);

  async function install() {
    setInstalling(true); setError('');
    const res = await api.post('/redis/install');
    setInstalling(false);
    if (res.success) await fetchInfo();
    else setError(res.error ?? 'Installation failed');
  }

  function copy(text: string) { navigator.clipboard.writeText(text); }

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Redis</h1>
        <p className="text-sm text-gray-400 mt-1">In-memory data store for caching and sessions</p>
      </div>

      {loading ? <p className="text-gray-500">Loading…</p> : (
        <div className="space-y-6">
          <div className="card flex items-center justify-between">
            <div className="flex items-center gap-4">
              {info?.running
                ? <CheckCircle size={28} className="text-emerald-400" />
                : <XCircle size={28} className="text-gray-600" />}
              <div>
                <p className="font-medium text-white text-lg">Redis</p>
                <p className="text-sm text-gray-400 mt-0.5">
                  {info?.running ? 'Running on port 6379' : 'Not installed / not running'}
                </p>
              </div>
            </div>
            {!info?.installed && (
              <button onClick={install} className="btn-primary" disabled={installing}>
                <Cpu size={14} /> {installing ? 'Installing…' : 'Install Redis'}
              </button>
            )}
          </div>

          {info?.connection && (
            <div className="card">
              <h2 className="text-base font-semibold text-white mb-4">Connection Info</h2>
              <div className="space-y-3">
                {[
                  { label: 'Host', value: info.connection.host },
                  { label: 'Port', value: String(info.connection.port) },
                  { label: 'URL', value: info.connection.url },
                  { label: 'Env Var', value: info.connection.env_var },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="label">{label}</p>
                    <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 mt-1">
                      <code className="text-sm text-gray-300 flex-1">{value}</code>
                      <button onClick={() => copy(value)} className="text-gray-500 hover:text-gray-200">
                        <Copy size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
      )}
    </Shell>
  );
}
