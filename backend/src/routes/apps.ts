import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { query } from '../services/db';
import { runScript, validateAppName } from '../services/executor';
import { pm2Action, pm2List } from '../services/pm2';
import { allocatePort } from '../services/portAllocator';
import { App } from '../types';

const router = Router();
const APPS_DIR = process.env.APPS_DIR ?? '/var/www/apps';

// GET /api/apps
router.get('/', async (_req: Request, res: Response) => {
  const apps  = await query<App>('SELECT * FROM apps ORDER BY created_at DESC');
  const procs = await pm2List();
  const procMap = new Map(procs.map((p) => [p.name, p]));

  const enriched = apps.map((app) => ({
    ...app,
    status: procMap.get(app.name)?.status ?? 'stopped',
    cpu:    procMap.get(app.name)?.cpu    ?? 0,
    memory: procMap.get(app.name)?.memory ?? 0,
  }));

  res.json({ success: true, data: enriched });
});

// POST /api/apps — deploy a new app
router.post('/', async (req: Request, res: Response) => {
  const {
    name,
    repo_url = '',
    branch   = 'main',
    env_vars = {},
  } = req.body as {
    name?:     string;
    repo_url?: string;
    branch?:   string;
    env_vars?: Record<string, string>;
  };

  if (!name) {
    res.status(400).json({ success: false, error: 'App name is required' });
    return;
  }

  if (!validateAppName(name)) {
    res.status(400).json({
      success: false,
      error: 'Invalid app name. Use lowercase letters, numbers and hyphens only.',
    });
    return;
  }

  const existing = await query<App>('SELECT id FROM apps WHERE name = $1', [name]);
  if (existing.length > 0) {
    res.status(409).json({ success: false, error: 'App name already exists' });
    return;
  }

  const port = await allocatePort();

  if (repo_url) {
    // Git-based deploy
    const result = await runScript('deploy_next_app.sh', [name, repo_url, branch, String(port)]);
    if (result.code !== 0) {
      res.status(500).json({ success: false, error: result.stderr || 'Deploy script failed' });
      return;
    }
  } else {
    // Empty / manual deploy — just create the directory
    const appDir = path.join(APPS_DIR, name);
    await fs.mkdir(appDir, { recursive: true });
  }

  const [app] = await query<App>(
    `INSERT INTO apps (name, repo_url, branch, port, env_vars)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, repo_url, branch, port, JSON.stringify(env_vars)]
  );

  res.status(201).json({ success: true, data: app });
});

// GET /api/apps/:name
router.get('/:name', async (req: Request, res: Response) => {
  const [app] = await query<App>('SELECT * FROM apps WHERE name = $1', [req.params['name']]);
  if (!app) { res.status(404).json({ success: false, error: 'App not found' }); return; }
  res.json({ success: true, data: app });
});

// POST /api/apps/:name/action
router.post('/:name/action', async (req: Request, res: Response) => {
  const { action } = req.body as { action?: string };
  const { name }   = req.params;

  const [app] = await query<App>('SELECT * FROM apps WHERE name = $1', [name]);
  if (!app) { res.status(404).json({ success: false, error: 'App not found' }); return; }

  if (action === 'rebuild') {
    if (!app.repo_url) {
      res.status(400).json({ success: false, error: 'Cannot rebuild — app has no git repository' });
      return;
    }
    const result = await runScript('deploy_next_app.sh', [
      app.name, app.repo_url, app.branch, String(app.port),
    ]);
    if (result.code !== 0) {
      res.status(500).json({ success: false, error: result.stderr });
      return;
    }
    res.json({ success: true, data: { message: 'Rebuild complete' } });
    return;
  }

  const allowed = ['start', 'stop', 'restart', 'delete'] as const;
  if (!allowed.includes(action as typeof allowed[number])) {
    res.status(400).json({ success: false, error: 'Invalid action' });
    return;
  }

  const pm2Result = await pm2Action(action as typeof allowed[number], name);

  if (action === 'delete') {
    await query('DELETE FROM apps WHERE name = $1', [name]);
  }

  res.json({ success: pm2Result.success, data: { message: pm2Result.message } });
});

// PUT /api/apps/:name/env
router.put('/:name/env', async (req: Request, res: Response) => {
  const { env_vars } = req.body as { env_vars?: Record<string, string> };
  const { name }     = req.params;

  if (!env_vars || typeof env_vars !== 'object') {
    res.status(400).json({ success: false, error: 'env_vars object required' });
    return;
  }

  const [app] = await query<App>(
    'UPDATE apps SET env_vars = $1, updated_at = NOW() WHERE name = $2 RETURNING *',
    [JSON.stringify(env_vars), name]
  );

  if (!app) { res.status(404).json({ success: false, error: 'App not found' }); return; }
  res.json({ success: true, data: app });
});

export default router;
