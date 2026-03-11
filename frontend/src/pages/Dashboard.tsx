import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server, Globe, ShieldCheck, Database, RotateCcw,
  Square, Cpu, HardDrive, Activity,
  ArrowUpRight, Play, Zap, Clock, MemoryStick,
  Network, ArrowDown, ArrowUp, Disc,
} from 'lucide-react';
import Shell from '@/components/Shell';
import StatusBadge from '@/components/StatusBadge';
import { api, App } from '@/lib/api';

/* ---- Types ---- */

interface CPUTimes {
  user: number; nice: number; system: number; idle: number;
  iowait: number; irq: number; softirq: number; steal: number;
}

interface LoadInfo {
  one: number; five: number; fifteen: number;
  max: number; limit: number; safe: number;
}

interface NetworkIface {
  name: string; rxBytesPerSec: number; txBytesPerSec: number;
  rxTotal: number; txTotal: number; rxPackets: number; txPackets: number;
}

interface Stats {
  cpu:       { usage: number; cores: number; model: string; loadAvg: number[]; perCore: number[]; times: CPUTimes; load: LoadInfo };
  memory:    { total: number; used: number; free: number; percent: number };
  disk:      { total: number; used: number; percent: number };
  network:   { rxBytesPerSec: number; txBytesPerSec: number; rxTotal: number; txTotal: number; rxPackets: number; txPackets: number; interface: string };
  networks:  NetworkIface[];
  diskIO:    { readBytesPerSec: number; writeBytesPerSec: number; readTotal: number; writeTotal: number; device: string };
  system:    { uptime: string; hostname: string };
  apps:      { total: number; running: number; stopped: number };
  processes: ProcessInfo[];
  dbTotal:   number;
  siteTotal: number;
}

interface ProcessInfo {
  pid: number; name: string; cpu: number; memory: number;
  memPct: number; user: string; command: string;
}

interface StatsHistory {
  timestamps: number[];
  cpu: number[];
  memory: number[];
  diskRead: number[];
  diskWrite: number[];
  netRx: number[];
  netTx: number[];
}

interface LivePayload {
  current: Stats;
  history: StatsHistory;
}

/* ---- Helpers ---- */

function bytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

function speed(bps: number): string {
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
  if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' KB/s';
  return bps + ' B/s';
}

function fmtPkts(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/* ---- Ring Gauge ---- */

function RingGauge({ value, color, size = 72 }: { value: number; color: string; size?: number }) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * (1 - Math.min(value, 100) / 100);
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="5" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={circ} strokeDashoffset={dash} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.8s ease-out', filter: `drop-shadow(0 0 6px ${color}80)` }} />
    </svg>
  );
}

/* ---- Sparkline ---- */

function Sparkline({ data, color, height = 32, width = 120 }: {
  data: number[]; color: string; height?: number; width?: number;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  const areaPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`sg-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#sg-${color.replace('#','')})`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 3px ${color}60)` }} />
    </svg>
  );
}

/* ---- Stat Card ---- */

function StatCard({ title, value, sub, icon: Icon, color, ring, ringColor, sparkData, sparkColor }: {
  title: string; value: string; sub: string;
  icon: React.ElementType; color: string;
  ring?: number; ringColor?: string;
  sparkData?: number[]; sparkColor?: string;
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
              <div className="progress-bar" style={{ width: `${Math.min(ring, 100)}%`, background: ringColor }} />
            </div>
          )}
          {sparkData && sparkData.length > 1 && (
            <div className="mt-3">
              <Sparkline data={sparkData} color={sparkColor || color} height={28} width={140} />
            </div>
          )}
        </div>
        {ring !== undefined
          ? <div className="relative shrink-0">
              <RingGauge value={ring} color={ringColor ?? '#8b5cf6'} />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs font-bold text-gray-300">{Math.round(ring)}%</span>
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

/* ---- Per-Core CPU Bars ---- */

function CoreBars({ perCore }: { perCore: number[] }) {
  if (!perCore || perCore.length === 0) return null;
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest mb-3">CPU Cores</p>
      <div className="grid gap-1.5">
        {perCore.map((usage, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-[10px] text-gray-600 w-6 text-right font-mono">C{i}</span>
            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
              <div className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min(usage, 100)}%`,
                  background: usage > 80 ? '#ef4444' : usage > 50 ? '#f59e0b' : '#8b5cf6',
                  boxShadow: usage > 50 ? `0 0 8px ${usage > 80 ? '#ef4444' : '#f59e0b'}40` : 'none',
                }} />
            </div>
            <span className="text-[10px] text-gray-500 w-8 text-right font-mono">{Math.round(usage)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- I/O Card ---- */

function IOCard({ title, icon: Icon, color, inLabel, outLabel, inValue, outValue, sparkIn, sparkOut }: {
  title: string; icon: React.ElementType; color: string;
  inLabel: string; outLabel: string; inValue: string; outValue: string;
  sparkIn?: number[]; sparkOut?: number[];
}) {
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 flex items-center justify-center rounded-xl shrink-0"
          style={{ background: `${color}12`, border: `1px solid ${color}22` }}>
          <Icon size={14} style={{ color }} />
        </div>
        <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest">{title}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-1 mb-1">
            <ArrowDown size={10} className="text-emerald-500" />
            <span className="text-[10px] text-gray-600 uppercase">{inLabel}</span>
          </div>
          <p className="text-sm font-bold text-white">{inValue}</p>
          {sparkIn && sparkIn.length > 1 && (
            <div className="mt-2">
              <Sparkline data={sparkIn} color="#10b981" height={24} width={100} />
            </div>
          )}
        </div>
        <div>
          <div className="flex items-center gap-1 mb-1">
            <ArrowUp size={10} className="text-blue-400" />
            <span className="text-[10px] text-gray-600 uppercase">{outLabel}</span>
          </div>
          <p className="text-sm font-bold text-white">{outValue}</p>
          {sparkOut && sparkOut.length > 1 && (
            <div className="mt-2">
              <Sparkline data={sparkOut} color="#3b82f6" height={24} width={100} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- Top Processes ---- */

function TopProcesses({ processes }: { processes: ProcessInfo[] }) {
  if (!processes || processes.length === 0) return null;
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Top Processes</p>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_60px_70px_50px] gap-2 text-[10px] text-gray-700 uppercase font-semibold tracking-wider px-1">
          <span>Process</span>
          <span className="text-right">CPU</span>
          <span className="text-right">Memory</span>
          <span className="text-right">PID</span>
        </div>
        {processes.map((p) => (
          <div key={p.pid}
            className="grid grid-cols-[1fr_60px_70px_50px] gap-2 items-center rounded-lg px-2 py-1.5 hover:bg-white/[0.03] transition-colors">
            <div className="min-w-0">
              <p className="text-xs text-gray-300 font-medium truncate">{p.name}</p>
              <p className="text-[10px] text-gray-700 font-mono truncate">{p.user}</p>
            </div>
            <div className="text-right">
              <span className="text-xs font-mono text-gray-400">{p.cpu.toFixed(1)}%</span>
            </div>
            <div className="text-right">
              <span className="text-xs font-mono text-gray-400">{bytes(p.memory)}</span>
              <span className="text-[10px] text-gray-700 ml-1">{p.memPct.toFixed(1)}%</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] font-mono text-gray-600">{p.pid}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- CPU Times Breakdown ---- */

function CPUTimesCard({ times }: { times?: CPUTimes }) {
  if (!times) return null;
  const items = [
    { label: 'User',    value: times.user,    color: '#8b5cf6' },
    { label: 'System',  value: times.system,  color: '#3b82f6' },
    { label: 'IOWait',  value: times.iowait,  color: '#f59e0b' },
    { label: 'Steal',   value: times.steal,   color: '#ef4444' },
    { label: 'Nice',    value: times.nice,     color: '#06b6d4' },
    { label: 'IRQ',     value: times.irq,      color: '#ec4899' },
    { label: 'SoftIRQ', value: times.softirq,  color: '#a855f7' },
    { label: 'Idle',    value: times.idle,      color: '#374151' },
  ];
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest mb-3">CPU Time Breakdown</p>
      <div className="flex h-3 rounded-full overflow-hidden mb-3" style={{ background: 'rgba(255,255,255,0.05)' }}>
        {items.filter(i => i.value > 0.5).map(i => (
          <div key={i.label} className="h-full transition-all duration-700" title={`${i.label}: ${i.value}%`}
            style={{ width: `${i.value}%`, background: i.color }} />
        ))}
      </div>
      <div className="grid grid-cols-4 gap-x-3 gap-y-1.5">
        {items.map(i => (
          <div key={i.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: i.color }} />
            <span className="text-[10px] text-gray-600">{i.label}</span>
            <span className="text-[10px] text-gray-400 font-mono ml-auto">{i.value}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Load Average Gauge ---- */

function LoadGauge({ load }: { load?: LoadInfo }) {
  if (!load) return null;
  const current = load.one;
  const maxVal = load.max || 1;
  const pct = Math.min((current / maxVal) * 100, 100);
  const status = current >= load.limit ? 'critical' : current >= load.safe ? 'warning' : 'healthy';
  const statusColor = status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#10b981';

  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest">Load Average</p>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
          style={{ background: `${statusColor}15`, color: statusColor, border: `1px solid ${statusColor}30` }}>
          {status}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-2xl font-bold text-white">{load.one.toFixed(2)}</span>
        <span className="text-xs text-gray-600">{load.five.toFixed(2)}</span>
        <span className="text-xs text-gray-700">{load.fifteen.toFixed(2)}</span>
      </div>
      <div className="relative h-2.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: statusColor }} />
        {/* Threshold markers */}
        <div className="absolute top-0 h-full w-px bg-amber-500/50"
          style={{ left: `${(load.safe / maxVal) * 100}%` }} title={`Safe: ${load.safe}`} />
        <div className="absolute top-0 h-full w-px bg-red-500/50"
          style={{ left: `${(load.limit / maxVal) * 100}%` }} title={`Limit: ${load.limit}`} />
      </div>
      <div className="flex justify-between mt-1.5 text-[9px] text-gray-700">
        <span>0</span>
        <span className="text-amber-600">Safe {load.safe}</span>
        <span className="text-red-600">Limit {load.limit}</span>
        <span>Max {load.max}</span>
      </div>
    </div>
  );
}

/* ---- Network Interfaces Table ---- */

function NetworkIfacesCard({ interfaces }: { interfaces?: NetworkIface[] }) {
  if (!interfaces || interfaces.length === 0) return null;
  return (
    <div className="card p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Network Interfaces</p>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_70px_70px_60px_60px] gap-2 text-[10px] text-gray-700 uppercase font-semibold tracking-wider px-1">
          <span>Interface</span>
          <span className="text-right">RX/s</span>
          <span className="text-right">TX/s</span>
          <span className="text-right">RX Pkts</span>
          <span className="text-right">TX Pkts</span>
        </div>
        {interfaces.map(ni => (
          <div key={ni.name}
            className="grid grid-cols-[1fr_70px_70px_60px_60px] gap-2 items-center rounded-lg px-2 py-1.5 hover:bg-white/[0.03] transition-colors">
            <span className="text-xs text-gray-300 font-mono">{ni.name}</span>
            <span className="text-xs font-mono text-emerald-400 text-right">{speed(ni.rxBytesPerSec)}</span>
            <span className="text-xs font-mono text-blue-400 text-right">{speed(ni.txBytesPerSec)}</span>
            <span className="text-[10px] font-mono text-gray-500 text-right">{fmtPkts(ni.rxPackets)}</span>
            <span className="text-[10px] font-mono text-gray-500 text-right">{fmtPkts(ni.txPackets)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Dashboard Page ---- */

export default function DashboardPage() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<App[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<StatsHistory | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch apps list (not included in WebSocket payload)
  const fetchApps = useCallback(async () => {
    const res = await api.get<App[]>('/apps');
    if (res.success && res.data) setApps(res.data);
  }, []);

  // WebSocket connection
  useEffect(() => {
    let mounted = true;

    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/api/stats/ws`);

      ws.onopen = () => {
        if (mounted) setWsConnected(true);
      };

      ws.onmessage = (evt) => {
        try {
          const payload: LivePayload = JSON.parse(evt.data);
          if (mounted && payload.current) {
            setStats(payload.current);
            setHistory(payload.history);
          }
        } catch { /* ignore parse errors */ }
      };

      ws.onclose = () => {
        if (mounted) {
          setWsConnected(false);
          // Reconnect after 3 seconds
          reconnectRef.current = setTimeout(() => {
            if (mounted) connect();
          }, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      mounted = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Fallback: if WebSocket fails, poll HTTP
  useEffect(() => {
    if (wsConnected) return;
    const fetchStats = async () => {
      const res = await api.get<Stats>('/stats');
      if (res.success && res.data) setStats(res.data);
    };
    fetchStats();
    const id = setInterval(fetchStats, 5000);
    return () => clearInterval(id);
  }, [wsConnected]);

  // Fetch apps on mount and periodically
  useEffect(() => { fetchApps(); }, [fetchApps]);
  useEffect(() => {
    const id = setInterval(fetchApps, 15000);
    return () => clearInterval(id);
  }, [fetchApps]);

  async function doAction(name: string, action: string) {
    setActing(name + action);
    await api.post(`/apps/${name}/action`, { action });
    await fetchApps();
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
            {stats ? `${stats.system.hostname} · Up ${stats.system.uptime}` : 'Loading system info...'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-gray-500"
            style={{ background: wsConnected ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)',
                     border: `1px solid ${wsConnected ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)'}` }}>
            <span className={`h-1.5 w-1.5 rounded-full inline-block ${wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            <span className={`font-medium ${wsConnected ? 'text-emerald-500' : 'text-amber-500'}`}>
              {wsConnected ? 'Live 2s' : 'Polling'}
            </span>
          </span>
          <button onClick={() => navigate('/apps')} className="btn-primary">
            <Zap size={13} /> Deploy App
          </button>
        </div>
      </div>

      {/* Main stat cards */}
      {stats ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4 animate-slide-up">
          <StatCard title="CPU" icon={Cpu}
            value={`${stats.cpu.usage}%`}
            sub={`${stats.cpu.cores} cores · ${stats.cpu.loadAvg[0]} load`}
            color="#8b5cf6" ring={stats.cpu.usage} ringColor="#8b5cf6"
            sparkData={history?.cpu} sparkColor="#8b5cf6" />
          <StatCard title="Memory" icon={MemoryStick}
            value={bytes(stats.memory.used)}
            sub={`${bytes(stats.memory.free)} free of ${bytes(stats.memory.total)}`}
            color="#3b82f6" ring={stats.memory.percent} ringColor="#3b82f6"
            sparkData={history?.memory} sparkColor="#3b82f6" />
          <StatCard title="Disk" icon={HardDrive}
            value={bytes(stats.disk.used)}
            sub={`${stats.disk.percent}% of disk used`}
            color="#f59e0b" ring={stats.disk.percent} ringColor="#f59e0b" />
          <StatCard title="Apps" icon={Activity}
            value={`${running} online`}
            sub={`${stats.dbTotal || 0} DBs · ${stats.siteTotal || 0} sites · ${apps.length} apps`}
            color="#10b981" />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card h-36 shimmer" style={{ background: 'rgba(255,255,255,0.02)' }} />
          ))}
        </div>
      )}

      {/* Per-core CPU + Network I/O + Disk I/O + Top Processes */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4 animate-slide-up">
          <CoreBars perCore={stats.cpu.perCore} />
          <IOCard title="Network" icon={Network} color="#06b6d4"
            inLabel="Download" outLabel="Upload"
            inValue={speed(stats.network.rxBytesPerSec)}
            outValue={speed(stats.network.txBytesPerSec)}
            sparkIn={history?.netRx} sparkOut={history?.netTx} />
          <IOCard title="Disk I/O" icon={Disc} color="#f59e0b"
            inLabel="Read" outLabel="Write"
            inValue={speed(stats.diskIO.readBytesPerSec)}
            outValue={speed(stats.diskIO.writeBytesPerSec)}
            sparkIn={history?.diskRead} sparkOut={history?.diskWrite} />
          <TopProcesses processes={stats.processes} />
        </div>
      )}

      {/* CPU Times + Load Gauge + Network Interfaces */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6 animate-slide-up">
          <CPUTimesCard times={stats.cpu.times} />
          <LoadGauge load={stats.cpu.load} />
          <NetworkIfacesCard interfaces={stats.networks} />
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
          <button key={href} onClick={() => navigate(href)}
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
        <button onClick={() => navigate('/apps')} className="btn-ghost text-xs py-1.5">
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
          <p className="text-gray-600 text-sm mb-6">Deploy your first application to get started</p>
          <button onClick={() => navigate('/apps')} className="btn-primary">
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
                    {app.domains?.length > 0
                      ? <a href={`http${app.domains[0].ssl_enabled ? 's' : ''}://${app.domains[0].domain}`}
                          target="_blank" rel="noreferrer"
                          className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-xs transition-colors group">
                          <Globe size={11} className="shrink-0" />
                          <span className="truncate max-w-[120px]">{app.domains[0].domain}</span>
                          {app.domains.length > 1 && <span className="text-gray-500">+{app.domains.length - 1}</span>}
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
                    <span className="text-xs text-gray-500">{app.memory > 0 ? bytes(app.memory) : '---'}</span>
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
                      <button onClick={() => navigate('/logs?app=' + app.name)}
                        title="View logs"
                        className="p-1.5 rounded-lg text-gray-700 hover:text-blue-400 hover:bg-blue-500/10 transition-all">
                        <Activity size={13} />
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
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'CPU Model', value: stats.cpu.model.split('@')[0]?.trim() ?? '---', icon: Cpu },
            { label: 'Load Average', value: stats.cpu.loadAvg.map(v => v.toFixed(2)).join(' / '), icon: Activity },
            { label: 'System Uptime', value: stats.system.uptime, icon: Clock },
            { label: 'Network', value: `${stats.network.interface} · ${bytes(stats.network.rxTotal)} rx · ${fmtPkts(stats.network.rxPackets)} pkts`, icon: Network },
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
