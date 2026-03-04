import { Router, Request, Response } from 'express';
import { runScript, runBin } from '../services/executor';

const router = Router();

// GET /api/redis — check Redis status
router.get('/', async (_req: Request, res: Response) => {
  const result = await runBin('systemctl', ['is-active', '--quiet', 'redis-server']);
  const running = result.code === 0;

  res.json({
    success: true,
    data: {
      installed: running,
      running,
      connection: running ? {
        host:     '127.0.0.1',
        port:     6379,
        url:      'redis://127.0.0.1:6379',
        env_var:  'REDIS_URL=redis://127.0.0.1:6379',
      } : null,
    },
  });
});

// POST /api/redis/install — install Redis via script
router.post('/install', async (_req: Request, res: Response) => {
  const result = await runScript('install_redis.sh', []);
  if (result.code !== 0) {
    res.status(500).json({ success: false, error: result.stderr || 'Install failed' });
    return;
  }
  res.json({ success: true, data: { message: 'Redis installed and started' } });
});

export default router;
