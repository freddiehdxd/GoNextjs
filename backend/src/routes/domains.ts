import { Router, Request, Response } from 'express';
import { query } from '../services/db';
import { validateDomain } from '../services/executor';
import { writeNginxConfig, removeNginxConfig, testAndReloadNginx } from '../services/nginx';
import { App } from '../types';

const router = Router();

// POST /api/domains — attach domain to app
router.post('/', async (req: Request, res: Response) => {
  const { app_name, domain } = req.body as { app_name?: string; domain?: string };

  if (!app_name || !domain) {
    res.status(400).json({ success: false, error: 'app_name and domain required' });
    return;
  }

  if (!validateDomain(domain)) {
    res.status(400).json({ success: false, error: 'Invalid domain name' });
    return;
  }

  const [app] = await query<App>('SELECT * FROM apps WHERE name = $1', [app_name]);
  if (!app) { res.status(404).json({ success: false, error: 'App not found' }); return; }

  // Remove old domain config if present
  if (app.domain) {
    await removeNginxConfig(app.domain);
  }

  // Always write HTTP-only config when adding/changing a domain.
  // SSL must be explicitly issued afterwards via the SSL page.
  // This prevents redirect loops when no cert exists yet.
  await writeNginxConfig(domain, app.port, false);
  const reload = await testAndReloadNginx();

  if (!reload.success) {
    // Roll back — restore old config if there was one
    if (app.domain) await writeNginxConfig(app.domain, app.port, false);
    else await removeNginxConfig(domain);
    res.status(500).json({ success: false, error: reload.message });
    return;
  }

  // Reset ssl_enabled to false since the domain changed and cert needs re-issuing
  const [updated] = await query<App>(
    'UPDATE apps SET domain = $1, ssl_enabled = false, updated_at = NOW() WHERE name = $2 RETURNING *',
    [domain, app_name]
  );

  res.json({ success: true, data: updated });
});

// DELETE /api/domains/:domain — detach domain
router.delete('/:domain', async (req: Request, res: Response) => {
  const { domain } = req.params;

  await removeNginxConfig(domain);
  await testAndReloadNginx();

  await query(
    'UPDATE apps SET domain = NULL, ssl_enabled = false, updated_at = NOW() WHERE domain = $1',
    [domain]
  );

  res.json({ success: true, data: { message: `Domain ${domain} removed` } });
});

export default router;
