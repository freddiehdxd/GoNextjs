import { Router, Request, Response } from 'express';
import os from 'os';
import fs from 'fs';
import { pm2List } from '../services/pm2';
import { query } from '../services/db';
import { App } from '../types';

const router = Router();

// ── Background stats cache ──────────────────────────────────────────────────
// Instead of computing stats per-request (1s CPU sample + subprocess + DB query),
// a background collector runs every 10s and the API returns cached data instantly.

interface CachedStats {
  cpu:    { usage: number; cores: number; model: string; loadAvg: number[] };
  memory: { total: number; used: number; free: number; percent: number };
  disk:   { total: number; used: number; percent: number };
  system: { uptime: string; hostname: string; platform: string; arch: string };
  apps:   { total: number; running: number; stopped: number; list: unknown[] };
}

let cachedStats: CachedStats | null = null;

// Previous /proc/stat snapshot for CPU delta
let prevCpuIdle  = 0;
let prevCpuTotal = 0;
let cpuPercent   = 0;

/**
 * Read /proc/stat to get CPU ticks — essentially free (virtual filesystem).
 * Returns { idle, total } tick counts.
 */
function readProcStat(): { idle: number; total: number } {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0]; // "cpu  user nice sys idle ..."
    const parts = line.replace(/^cpu\s+/, '').split(/\s+/).map(Number);
    // parts: user, nice, system, idle, iowait, irq, softirq, steal
    const idle  = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    // Fallback for non-Linux (shouldn't happen on VPS)
    const cpus = os.cpus();
    let idle = 0, total = 0;
    cpus.forEach((c) => {
      idle  += c.times.idle;
      total += Object.values(c.times).reduce((a, b) => a + b, 0);
    });
    return { idle, total };
  }
}

/**
 * Read /proc/meminfo for accurate memory data — no computation.
 */
function readMemInfo(): { total: number; used: number; free: number; percent: number } {
  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key: string): number => {
      const match = content.match(new RegExp(`${key}:\\s+(\\d+)`));
      return match ? parseInt(match[1], 10) * 1024 : 0; // kB → bytes
    };
    const total     = get('MemTotal');
    const available = get('MemAvailable');
    const used      = total - available;
    return { total, used, free: available, percent: Math.round((used / total) * 100) };
  } catch {
    const total = os.totalmem();
    const free  = os.freemem();
    const used  = total - free;
    return { total, used, free, percent: Math.round((used / total) * 100) };
  }
}

function diskUsage(): { used: number; total: number; percent: number } {
  try {
    const stat  = fs.statfsSync('/');
    const total = stat.blocks * stat.bsize;
    const free  = stat.bfree  * stat.bsize;
    const used  = total - free;
    return { used, total, percent: Math.round((used / total) * 100) };
  } catch {
    return { used: 0, total: 0, percent: 0 };
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Background collector — runs every 10s.
 * Reads /proc virtual files (instant) and refreshes PM2 + DB data.
 */
async function collectStats(): Promise<void> {
  try {
    // CPU: delta from previous /proc/stat reading
    const curr = readProcStat();
    if (prevCpuTotal > 0) {
      const idleDelta  = curr.idle  - prevCpuIdle;
      const totalDelta = curr.total - prevCpuTotal;
      cpuPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
    }
    prevCpuIdle  = curr.idle;
    prevCpuTotal = curr.total;

    // Memory from /proc/meminfo
    const memory = readMemInfo();

    // Disk
    const disk = diskUsage();

    // PM2 + DB (these are the only "real" work — one subprocess + one query)
    const [procs, apps] = await Promise.all([
      pm2List(),
      query<App>('SELECT * FROM apps'),
    ]);

    const runningApps = procs.filter((p) => p.status === 'online').length;

    cachedStats = {
      cpu: {
        usage:   cpuPercent,
        cores:   os.cpus().length,
        model:   os.cpus()[0]?.model ?? 'Unknown',
        loadAvg: os.loadavg().map((l) => Math.round(l * 100) / 100),
      },
      memory,
      disk: { total: disk.total, used: disk.used, percent: disk.percent },
      system: {
        uptime:   formatUptime(os.uptime()),
        hostname: os.hostname(),
        platform: os.platform(),
        arch:     os.arch(),
      },
      apps: {
        total:   apps.length,
        running: runningApps,
        stopped: apps.length - runningApps,
        list: procs.map((p) => ({
          name:   p.name,
          status: p.status,
          cpu:    p.cpu,
          memory: p.memory,
          uptime: p.uptime,
        })),
      },
    };
  } catch {
    // Keep serving last cached data on error
  }
}

// Start background collector
collectStats();                       // first run immediately
setInterval(collectStats, 10_000);    // then every 10 seconds

// ── Route ───────────────────────────────────────────────────────────────────
// GET /api/stats — returns cached stats instantly (zero computation per request)
router.get('/', (_req: Request, res: Response) => {
  if (!cachedStats) {
    res.json({ success: true, data: null });
    return;
  }
  res.json({ success: true, data: cachedStats });
});

export default router;
