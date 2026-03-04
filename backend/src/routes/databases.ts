import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query as panelQuery } from '../services/db';
import { runBin, validatePgIdentifier } from '../services/executor';
import { Database } from '../types';

const router = Router();

const PG_SUPERUSER = process.env.PG_SUPERUSER ?? 'postgres';

async function runPsql(sql: string): Promise<{ success: boolean; message: string }> {
  const result = await runBin('psql', [
    '-U', PG_SUPERUSER,
    '-c', sql,
  ]);
  return { success: result.code === 0, message: result.stderr || result.stdout };
}

// GET /api/databases
router.get('/', async (_req: Request, res: Response) => {
  const rows = await panelQuery<Database>(
    'SELECT id, name, db_user, created_at FROM managed_databases ORDER BY created_at DESC'
  );
  res.json({ success: true, data: rows });
});

// POST /api/databases
router.post('/', async (req: Request, res: Response) => {
  const { name, user } = req.body as { name?: string; user?: string };

  if (!name || !user) {
    res.status(400).json({ success: false, error: 'name and user required' });
    return;
  }
  if (!validatePgIdentifier(name) || !validatePgIdentifier(user)) {
    res.status(400).json({
      success: false,
      error: 'Invalid name or user. Use lowercase letters, numbers and underscores.',
    });
    return;
  }

  const existing = await panelQuery('SELECT id FROM managed_databases WHERE name = $1 OR db_user = $2', [name, user]);
  if (existing.length > 0) {
    res.status(409).json({ success: false, error: 'Database or user already exists' });
    return;
  }

  const password = crypto.randomBytes(16).toString('hex');

  const createUser = await runPsql(`CREATE USER "${user}" WITH PASSWORD '${password}'`);
  if (!createUser.success) {
    res.status(500).json({ success: false, error: createUser.message });
    return;
  }

  const createDb = await runPsql(`CREATE DATABASE "${name}" OWNER "${user}"`);
  if (!createDb.success) {
    await runPsql(`DROP USER IF EXISTS "${user}"`);
    res.status(500).json({ success: false, error: createDb.message });
    return;
  }

  const [row] = await panelQuery<Database>(
    'INSERT INTO managed_databases (name, db_user, password) VALUES ($1, $2, $3) RETURNING *',
    [name, user, password]
  );

  const host = process.env.DB_HOST ?? 'localhost';
  const connectionString = `postgresql://${user}:${password}@${host}:5432/${name}`;

  res.status(201).json({ success: true, data: { ...row, connection_string: connectionString } });
});

// DELETE /api/databases/:name
router.delete('/:name', async (req: Request, res: Response) => {
  const { name } = req.params;

  if (!validatePgIdentifier(name)) {
    res.status(400).json({ success: false, error: 'Invalid database name' });
    return;
  }

  const [db] = await panelQuery<Database>('SELECT * FROM managed_databases WHERE name = $1', [name]);
  if (!db) { res.status(404).json({ success: false, error: 'Database not found' }); return; }

  await runPsql(`DROP DATABASE IF EXISTS "${name}"`);
  await runPsql(`DROP USER IF EXISTS "${db.user}"`);
  await panelQuery('DELETE FROM managed_databases WHERE name = $1', [name]);

  res.json({ success: true, data: { message: `Database ${name} deleted` } });
});

export default router;
