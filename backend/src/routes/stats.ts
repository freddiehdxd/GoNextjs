import { Router, Request, Response } from 'express';
import os from 'os';
import fs from 'fs';
import { pm2List } from '../services/pm2';
import { query } from '../services/db';
import { App } from '../types';

const router = Router();

function cpuUsage(): Promise<number> {
  return new Promise((resolve) => {
    const cpus1 = os.cpus();
    setTimeout(() => {
      const cpus2 = os.cpus();
      let idle = 0, total = 0;
      cpus2.forEach((cpu, i) => {
        const prev = cpus1[i];
        const prevTotal = Object.values(prev.times).reduce((a, b) => a + b, 0);
        const currTotal = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        idle  += cpu.times.idle - prev.times.idle;
        total += currTotal - prevTotal;
      });
      resolve(Math.round((1 - idle / total) * 100));
    }, 500);
  });
}

function diskUsage(): { used: number; total: number; percent: number } {
  try {
    const stat = fs.statfsSync('/');
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

// GET /api/stats — live server stats
router.get('/', async (_req: Request, res: Response) => {
  const [cpu, procs, apps] = await Promise.all([
    cpuUsage(),
    pm2List(),
    query<App>('SELECT * FROM apps'),
  ]);

  const totalMem  = os.totalmem();
  const freeMem   = os.freemem();
  const usedMem   = totalMem - freeMem;
  const disk      = diskUsage();
  const loadAvg   = os.loadavg();

  const runningApps = procs.filter((p) => p.status === 'online').length;
  const totalApps   = apps.length;

  const appStats = procs.map((p) => ({
    name:   p.name,
    status: p.status,
    cpu:    p.cpu,
    memory: p.memory,
    uptime: p.uptime,
  }));

  res.json({
    success: true,
    data: {
      cpu: {
        usage:   cpu,
        cores:   os.cpus().length,
        model:   os.cpus()[0]?.model ?? 'Unknown',
        loadAvg: loadAvg.map((l) => Math.round(l * 100) / 100),
      },
      memory: {
        total:   totalMem,
        used:    usedMem,
        free:    freeMem,
        percent: Math.round((usedMem / totalMem) * 100),
      },
      disk: {
        total:   disk.total,
        used:    disk.used,
        percent: disk.percent,
      },
      system: {
        uptime:    formatUptime(os.uptime()),
        hostname:  os.hostname(),
        platform:  os.platform(),
        arch:      os.arch(),
      },
      apps: {
        total:   totalApps,
        running: runningApps,
        stopped: totalApps - runningApps,
        list:    appStats,
      },
    },
  });
});

export default router;
