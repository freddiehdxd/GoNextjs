'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Server, Globe, ShieldCheck, Database, RotateCcw,
  Square, Cpu, HardDrive, Activity,
  ArrowUpRight, Play, Zap, Clock, TrendingUp, MemoryStick,
} from 'lucide-react';
import Shell from '@/components/Shell';
import StatusBadge from '@/components/StatusBadge';
import { api, App } from '@/lib/api';

interface Stats {
  cpu:    { usage: number; cores: number; model: string; loadAvg: number[] };
  memory: { total: number; used: number; free: number; percent: number };
  disk:   { total: number; used: number; percent: number };
  system: { uptime: string; hostname: string };
  apps:   { total: number; running: number; stopped: number };
}

function bytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

function RingGauge({ value, color, size = 72 }: { value: number; color: string; size?: number }) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * (1 - value / 100);
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="5" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={circ} strokeDashoffset={dash} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 1s ease-out', filter: `drop-shadow(0 0 6px ${color}80)` }} />
    </svg>
  );
}

function StatCard({ title, value, sub, icon: Icon, color, ring, ringColor }: {
  title: string; value: string; sub: string;
  icon: React.ElementType; color: string; ring?: number; ringColor?: string;
}) {
  return (
    <div className="card relative overflow-hidden group hover:border-white/[0.12] transition-all duration-300 cursor-default"
      style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{ background: `radial-gradient(ellipse at top right, ${color}0a, transparent 70%)` }} />
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0 pr-3">
          <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest mb-3">{title}</p>
          <p className="text-2xl font-bold text-white leading-none mb-2">{value}</p>
          <p className="text-xs text-gray-600 truncate">{sub}</p>
          {ring !== undefined && (
            <div className="mt-4 progress">
              <div className="progress-bar" style={{ width: `${ring}%`, background: ringColor }} />
            </div>
          )}
        </div>
        {ring !== undefined
          ? <div className="relative shrink-0">
              <RingGauge value={ring} color={ringColor ?? '#8b5cf6'} />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs font-bold text-gray-300">{ring}%</span>
              </div>
            </div>
          : <div className="flex h-11 w-11 items-center justify-center rounded-2xl shrink-0"
              style={{ background: `${color}12`, border: `1px solid ${color}22` }}>
              <Icon size={20} style={{ color }} />
            </div>
        }
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [apps,   setApps]   = useState<App[]>([]);
  const [stats,  setStats]  = useState<Stats | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [appsRes, statsRes] = await Promise.all([
      api.get<App[]>('/apps'),
      api.get<Stats>('/stats'),
    ]);
    if (appsRes.success && appsRes.data) setApps(appsRes.data);
    if (statsRes.success && statsRes.data) setStats(statsRes.data);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => {
    const id = setInterval(fetchAll, 15000);
    return () => clearInterval(id);
  }, [fetchAll]);

  async function doAction(name: string, action: string) {
    setActing(name + action);
    await api.post(`/apps/${name}/action`, { action });
    await fetchAll();
    setActing(null);
  }

  const running = apps.filter((a) => a.status === 'online').length;

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-600 mt-1">
            {stats ? `${stats.system.hostname} · Up ${stats.system.uptime}` : 'Loading system info…'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-gray-500"
            style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
            <span className="text-emerald-500 font-medium">Live</span>
          </span>
          <button onClick={() => router.push('/apps')} className="btn-primary">
            <Zap size={13} /> Deploy App
          </button>
        </div>
      </div>

      {/* Server stat cards */}
      {stats ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6 animate-slide-up">
          <StatCard title="CPU" icon={Cpu}
            value={`${stats.cpu.usage}%`}
            sub={`${stats.cpu.cores} cores · ${stats.cpu.loadAvg[0]} load`}
            color="#8b5cf6" ring={stats.cpu.usage} ringColor="#8b5cf6" />
          <StatCard title="Memory" icon={MemoryStick}
            value={bytes(stats.memory.used)}
            sub={`${bytes(stats.memory.free)} free of ${bytes(stats.memory.total)}`}
            color="#3b82f6" ring={stats.memory.percent} ringColor="#3b82f6" />
          <StatCard title="Disk" icon={HardDrive}
            value={bytes(stats.disk.used)}
            sub={`${stats.disk.percent}% of disk used`}
            color="#f59e0b" ring={stats.disk.percent} ringColor="#f59e0b" />
          <StatCard title="Apps" icon={Activity}
            value={`${running} online`}
            sub={`${apps.length - running} stopped · ${apps.length} total`}
            color="#10b981" />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card h-32 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
          ))}
        </div>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Deploy App',   icon: Server,     href: '/apps',      color: '#8b5cf6' },
          { label: 'Add Domain',   icon: Globe,      href: '/domains',   color: '#06b6d4' },
          { label: 'Issue SSL',    icon: ShieldCheck, href: '/ssl',      color: '#10b981' },
          { label: 'New Database', icon: Database,   href: '/databases', color: '#f59e0b' },
        ].map(({ label, icon: Icon, href, color }) => (
          <button key={href} onClick={() => router.push(href)}
            className="flex items-center gap-3 rounded-2xl px-4 py-3.5 text-sm font-medium text-gray-400 hover:text-white transition-all duration-200 text-left group active:scale-[0.98]"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="h-8 w-8 flex items-center justify-center rounded-xl shrink-0 transition-transform duration-200 group-hover:scale-110"
              style={{ background: `${color}12`, border: `1px solid ${color}20` }}>
              <Icon size={15} style={{ color }} />
            </div>
            <span className="flex-1 truncate text-xs font-semibold">{label}</span>
            <ArrowUpRight size={12} className="text-gray-700 group-hover:text-gray-400 transition-colors shrink-0" />
          </button>
        ))}
      </div>

      {/* Apps table */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Deployed Apps</h2>
        <button onClick={() => router.push('/apps')} className="btn-ghost text-xs py-1.5">
          Manage <ArrowUpRight size={11} />
        </button>
      </div>

      {apps.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-20 text-center"
          style={{ background: 'rgba(255,255,255,0.01)' }}>
          <div className="h-16 w-16 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.15)' }}>
            <Server size={28} className="text-violet-500" />
          </div>
          <p className="text-gray-300 font-semibold mb-1">No apps deployed</p>
          <p className="text-gray-600 text-sm mb-6">Deploy your first Next.js application to get started</p>
          <button onClick={() => router.push('/apps')} className="btn-primary">
            <Zap size={14} /> Deploy First App
          </button>
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="w-full">
            <thead>
              <tr>
                {['Application', 'Status', 'Domain', 'Port', 'CPU', 'Memory', 'Actions'].map((h) => (
                  <th key={h} className="th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.id} className="tr">
                  <td className="td">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-xl flex items-center justify-center shrink-0 font-bold text-xs text-violet-300"
                        style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.15)' }}>
                        {app.name[0].toUpperCase()}
                      </div>
                      <div>
                        <p className="font-semibold text-gray-100 text-sm">{app.name}</p>
                        <p className="text-[11px] text-gray-600 font-mono">{app.branch}</p>
                      </div>
                    </div>
                  </td>
                  <td className="td"><StatusBadge status={app.status} /></td>
                  <td className="td">
                    {app.domain
                      ? <a href={`http${app.ssl_enabled ? 's' : ''}://${app.domain}`}
                          target="_blank" rel="noreferrer"
                          className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-xs transition-colors group">
                          <Globe size={11} className="shrink-0" />
                          <span className="truncate max-w-[120px]">{app.domain}</span>
                          <ArrowUpRight size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                        </a>
                      : <span className="text-gray-700 text-xs">No domain</span>}
                  </td>
                  <td className="td">
                    <code className="text-xs text-gray-500 font-mono bg-white/[0.03] border border-white/[0.05] rounded-lg px-2 py-1">
                      :{app.port}
                    </code>
                  </td>
                  <td className="td">
                    <div className="flex items-center gap-2 min-w-[70px]">
                      <div className="flex-1 progress">
                        <div className="progress-bar" style={{
                          width: `${Math.min(app.cpu, 100)}%`,
                          background: app.cpu > 80 ? '#ef4444' : app.cpu > 50 ? '#f59e0b' : '#8b5cf6'
                        }} />
                      </div>
                      <span className="text-xs text-gray-600 w-8 text-right">{app.cpu}%</span>
                    </div>
                  </td>
                  <td className="td">
                    <span className="text-xs text-gray-500">{app.memory > 0 ? bytes(app.memory) : '—'}</span>
                  </td>
                  <td className="td">
                    <div className="flex items-center gap-1">
                      <button onClick={() => doAction(app.name, 'restart')}
                        disabled={!!acting} title="Restart"
                        className="p-1.5 rounded-lg text-gray-700 hover:text-violet-400 hover:bg-violet-500/10 transition-all">
                        <RotateCcw size={13} className={acting === app.name + 'restart' ? 'animate-spin' : ''} />
                      </button>
                      <button onClick={() => doAction(app.name, app.status === 'online' ? 'stop' : 'start')}
                        disabled={!!acting} title={app.status === 'online' ? 'Stop' : 'Start'}
                        className="p-1.5 rounded-lg text-gray-700 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all">
                        {app.status === 'online' ? <Square size={13} /> : <Play size={13} />}
                      </button>
                      <button onClick={() => router.push('/logs?app=' + app.name)}
                        title="View logs"
                        className="p-1.5 rounded-lg text-gray-700 hover:text-blue-400 hover:bg-blue-500/10 transition-all">
                        <TrendingUp size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* System footer info */}
      {stats && (
        <div className="mt-5 grid grid-cols-3 gap-3">
          {[
            { label: 'CPU Model', value: stats.cpu.model.split('@')[0]?.trim() ?? '—', icon: Cpu },
            { label: 'Load Average', value: stats.cpu.loadAvg.map(String).join(' · '), icon: Activity },
            { label: 'System Uptime', value: stats.system.uptime, icon: Clock },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="flex items-center gap-3 rounded-xl px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <Icon size={13} className="text-gray-700 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] text-gray-700 uppercase tracking-wider">{label}</p>
                <p className="text-xs text-gray-400 font-medium truncate">{value}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
