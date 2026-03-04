import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import { pm2Logs } from '../services/pm2';
import { validateAppName } from '../services/executor';

const router = Router();

const NGINX_ACCESS_LOG = '/var/log/nginx/access.log';
const NGINX_ERROR_LOG  = '/var/log/nginx/error.log';

async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const all     = content.split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return `(log file not found: ${filePath})`;
  }
}

// GET /api/logs/app/:name?lines=200
router.get('/app/:name', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!validateAppName(name ?? '')) {
    res.status(400).json({ success: false, error: 'Invalid app name' });
    return;
  }
  const lines = Math.min(parseInt((req.query['lines'] as string) ?? '200', 10), 1000);
  const log   = await pm2Logs(name, lines);
  res.json({ success: true, data: { log } });
});

// GET /api/logs/nginx?type=access|error&lines=200
router.get('/nginx', async (req: Request, res: Response) => {
  const type  = req.query['type'] === 'error' ? 'error' : 'access';
  const lines = Math.min(parseInt((req.query['lines'] as string) ?? '200', 10), 1000);
  const file  = type === 'error' ? NGINX_ERROR_LOG : NGINX_ACCESS_LOG;
  const log   = await tailFile(file, lines);
  res.json({ success: true, data: { log, type } });
});

export default router;
