import { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw, Play, Square, CheckCircle2, XCircle, AlertCircle,
  Globe, Database, HardDrive, Cpu, Terminal, Shield, ShieldAlert, Clock,
} from 'lucide-react';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

/* ---- Types ---- */

interface ServiceInfo {
  name: string;
  displayName: string;
  description: string;
  active: boolean;
  running: boolean;
  enabled: boolean;
  statusText: string;
  subState: string;
  mainPid: number;
  memory: string;
  uptime: string;
  icon: string;
}

/* ---- Icon Map ---- */

const iconMap: Record<string, React.ElementType> = {
  globe: Globe,
  database: Database,
  'hard-drive': HardDrive,
  cpu: Cpu,
  terminal: Terminal,
  shield: Shield,
  'shield-alert': ShieldAlert,
  clock: Clock,
};

const colorMap: Record<string, string> = {
  globe: '#06b6d4',
  database: '#ef4444',
  'hard-drive': '#f59e0b',
  cpu: '#8b5cf6',
  terminal: '#10b981',
  shield: '#3b82f6',
  'shield-alert': '#f97316',
  clock: '#ec4899',
};

/* ---- Page ---- */

export default function ServicesPage() {
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchServices = useCallback(async () => {
    const res = await api.get<ServiceInfo[]>('/services');
    if (res.success && res.data) setServices(res.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchServices(); }, [fetchServices]);

  // Auto-refresh every 15s
  useEffect(() => {
    const id = setInterval(fetchServices, 15000);
    return () => clearInterval(id);
  }, [fetchServices]);

  async function doAction(name: string, action: 'restart' | 'stop' | 'start') {
    setActionLoading(prev => ({ ...prev, [name]: action }));
    setError('');
    setSuccess('');

    const res = await api.post<ServiceInfo>(`/services/${name}/${action}`);
    setActionLoading(prev => {
      const next = { ...prev };
      delete next[name];
      return next;
    });

    if (res.success && res.data) {
      setServices(prev => prev.map(s => s.name === name ? res.data! : s));
      const svc = services.find(s => s.name === name);
      const label = svc?.displayName || name;
      setSuccess(`${label} ${action}ed successfully`);
      setTimeout(() => setSuccess(''), 3000);
    } else {
      setError(res.error ?? `Failed to ${action} ${name}`);
      setTimeout(() => setError(''), 5000);
    }
  }

  const running = services.filter(s => s.running).length;
  const stopped = services.filter(s => !s.running).length;

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Services</h1>
          <p className="text-sm text-gray-600 mt-1">
            Manage system services
            {services.length > 0 && (
              <span className="text-gray-700">
                {' '}&middot; {running} running &middot; {stopped} stopped
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchServices(); }}
          className="btn-ghost text-xs py-1.5"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Notifications */}
      {success && (
        <div className="mb-4 rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-400 flex items-center gap-2 animate-slide-up">
          <CheckCircle2 size={14} /> {success}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400 flex items-center gap-2 animate-slide-up">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card h-20 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
          ))}
        </div>
      ) : (
        <div className="space-y-3 animate-slide-up">
          {services.map(svc => {
            const Icon = iconMap[svc.icon] || Shield;
            const color = colorMap[svc.icon] || '#6b7280';
            const busy = actionLoading[svc.name];

            return (
              <div
                key={svc.name}
                className="card hover:border-white/[0.1] transition-all duration-200"
                style={{ background: 'rgba(255,255,255,0.02)' }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    {/* Icon */}
                    <div
                      className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0"
                      style={svc.running
                        ? { background: `${color}15`, border: `1px solid ${color}30` }
                        : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }
                      }
                    >
                      <Icon size={20} style={{ color: svc.running ? color : '#4b5563' }} />
                    </div>

                    {/* Info */}
                    <div>
                      <div className="flex items-center gap-2.5">
                        <p className="font-semibold text-white">{svc.displayName}</p>
                        {svc.running ? (
                          <span className="badge-green"><CheckCircle2 size={10} /> Running</span>
                        ) : svc.statusText === 'inactive' ? (
                          <span className="badge-yellow"><XCircle size={10} /> Stopped</span>
                        ) : (
                          <span className="badge-gray"><XCircle size={10} /> {svc.statusText || 'Unknown'}</span>
                        )}
                        {svc.enabled && (
                          <span className="text-[10px] font-mono text-gray-700">auto-start</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5">
                        {svc.description}
                        {svc.mainPid > 0 && <span className="text-gray-700"> &middot; PID {svc.mainPid}</span>}
                        {svc.memory && <span className="text-gray-700"> &middot; {svc.memory}</span>}
                      </p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {svc.running ? (
                      <>
                        <button
                          onClick={() => doAction(svc.name, 'restart')}
                          disabled={!!busy}
                          className="btn-ghost text-xs py-1.5 px-3"
                          title="Restart service"
                        >
                          {busy === 'restart' ? (
                            <span className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                          ) : (
                            <RefreshCw size={12} />
                          )}
                          Restart
                        </button>
                        <button
                          onClick={() => doAction(svc.name, 'stop')}
                          disabled={!!busy}
                          className="btn-ghost text-xs py-1.5 px-3 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          title="Stop service"
                        >
                          {busy === 'stop' ? (
                            <span className="h-3 w-3 rounded-full border-2 border-red-400/30 border-t-red-400 animate-spin" />
                          ) : (
                            <Square size={12} />
                          )}
                          Stop
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => doAction(svc.name, 'start')}
                        disabled={!!busy}
                        className="btn-primary text-xs py-1.5 px-4"
                        title="Start service"
                      >
                        {busy === 'start' ? (
                          <span className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        ) : (
                          <Play size={12} />
                        )}
                        Start
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Footer info */}
          <div
            className="flex items-center gap-3 rounded-xl px-4 py-3 text-[10px] text-gray-700"
            style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)' }}
          >
            <Shield size={11} className="text-gray-700" />
            <span>Services managed via systemctl</span>
            <span className="text-gray-800">|</span>
            <span>{services.length} services monitored</span>
            <span className="text-gray-800">|</span>
            <span>Auto-refreshes every 15s</span>
          </div>
        </div>
      )}
    </Shell>
  );
}
