import { runBin } from './executor';
import { logger } from './logger';

export interface Pm2Process {
  name: string;
  pm_id: number;
  status: 'online' | 'stopped' | 'errored' | 'launching';
  cpu: number;
  memory: number;
  uptime: number;
}

export async function pm2List(): Promise<Pm2Process[]> {
  const result = await runBin('pm2', ['jlist']);
  if (result.code !== 0) return [];
  try {
    const raw = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    return raw.map((p) => ({
      name:   String(p['name'] ?? ''),
      pm_id:  Number(p['pm_id'] ?? 0),
      status: (p['pm2_env'] as Record<string,unknown>)?.['status'] as Pm2Process['status'] ?? 'stopped',
      cpu:    Number((p['monit'] as Record<string,unknown>)?.['cpu'] ?? 0),
      memory: Number((p['monit'] as Record<string,unknown>)?.['memory'] ?? 0),
      uptime: Number((p['pm2_env'] as Record<string,unknown>)?.['pm_uptime'] ?? 0),
    }));
  } catch (e) {
    logger.error('Failed to parse pm2 jlist', e);
    return [];
  }
}

export async function pm2Action(
  action: 'start' | 'stop' | 'restart' | 'delete',
  appName: string
): Promise<{ success: boolean; message: string }> {
  const result = await runBin('pm2', [action, appName]);
  return {
    success: result.code === 0,
    message: result.code === 0 ? result.stdout : result.stderr,
  };
}

export async function pm2Logs(appName: string, lines = 100): Promise<string> {
  const result = await runBin('pm2', ['logs', appName, '--lines', String(lines), '--nostream']);
  return result.stdout + result.stderr;
}
