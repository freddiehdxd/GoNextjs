import { Router, Request, Response } from 'express';
import { query } from '../services/db';
import { runScript, validateDomain } from '../services/executor';
import { writeNginxConfig, testAndReloadNginx } from '../services/nginx';
import { App } from '../types';

const router = Router();

// POST /api/ssl — issue Let's Encrypt certificate for app's domain
router.post('/', async (req: Request, res: Response) => {
  const { app_name, email } = req.body as { app_name?: string; email?: string };

  if (!app_name || !email) {
    res.status(400).json({ success: false, error: 'app_name and email required' });
    return;
  }

  const [app] = await query<App>('SELECT * FROM apps WHERE name = $1', [app_name]);
  if (!app) { res.status(404).json({ success: false, error: 'App not found' }); return; }
  if (!app.domain) {
    res.status(400).json({ success: false, error: 'App has no domain assigned' });
    return;
  }

  if (!validateDomain(app.domain)) {
    res.status(400).json({ success: false, error: 'Invalid domain' });
    return;
  }

  // create_ssl.sh <domain> <email>
  const result = await runScript('create_ssl.sh', [app.domain, email]);
  if (result.code !== 0) {
    res.status(500).json({ success: false, error: result.stderr || 'SSL issuance failed' });
    return;
  }

  // Rewrite NGINX config with SSL enabled
  await writeNginxConfig(app.domain, app.port, true);
  const reload = await testAndReloadNginx();

  if (!reload.success) {
    res.status(500).json({ success: false, error: reload.message });
    return;
  }

  await query(
    'UPDATE apps SET ssl_enabled = true, updated_at = NOW() WHERE name = $1',
    [app_name]
  );

  res.json({ success: true, data: { message: `SSL enabled for ${app.domain}` } });
});

export default router;
