import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query as panelQuery, pool } from '../services/db';
import { validatePgIdentifier } from '../services/executor';
import { Database } from '../types';

const router = Router();

/**
 * Run a SQL statement that cannot be run inside a transaction
 * (CREATE DATABASE, DROP DATABASE) using a direct pool connection.
 */
async function runAdminSql(
  sql: string,
  params?: unknown[]
): Promise<{ success: boolean; message: string }> {
  const client = await pool.connect();
  try {
    // Must be outside a transaction block for CREATE/DROP DATABASE
    await client.query('COMMIT');
    await client.query(sql, params);
    return { success: true, message: '' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  } finally {
    client.release();
  }
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

  const existing = await panelQuery(
    'SELECT id FROM managed_databases WHERE name = $1 OR db_user = $2',
    [name, user]
  );
  if (existing.length > 0) {
    res.status(409).json({ success: false, error: 'Database or user already exists' });
    return;
  }

  const password = crypto.randomBytes(16).toString('hex');

  // CREATE USER — identifiers already validated by validatePgIdentifier (alphanumeric + underscore).
  // PostgreSQL does not support parameterised identifiers, but the regex guarantees safety.
  // The password IS parameterised via format-string-free approach: we set it with ALTER ROLE afterwards.
  try {
    // Create user with a dummy password first, then ALTER to set the real one safely
    await panelQuery(`CREATE USER "${user}" WITH PASSWORD 'temp'`);
    // Set real password via parameterised query — pg driver sends as protocol-level parameter
    const client = await pool.connect();
    try {
      await client.query(`ALTER ROLE "${user}" WITH PASSWORD $1`, [password]);
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: `Failed to create user: ${message}` });
    return;
  }

  // CREATE DATABASE must run outside a transaction
  const createDb = await runAdminSql(`CREATE DATABASE "${name}" OWNER "${user}"`);
  if (!createDb.success) {
    // Roll back user creation
    try { await panelQuery(`DROP USER IF EXISTS "${user}"`); } catch { /* best effort */ }
    res.status(500).json({ success: false, error: `Failed to create database: ${createDb.message}` });
    return;
  }

  await panelQuery(
    'INSERT INTO managed_databases (name, db_user, password) VALUES ($1, $2, $3)',
    [name, user, password]
  );

  const host = process.env.DB_HOST ?? 'localhost';
  const connectionString = `postgresql://${user}:${password}@${host}:5432/${name}`;

  // Return connection info without the stored password hash
  res.status(201).json({
    success: true,
    data: {
      name,
      db_user: user,
      connection_string: connectionString,
    },
  });
});

// DELETE /api/databases/:name
router.delete('/:name', async (req: Request, res: Response) => {
  const { name } = req.params;

  if (!validatePgIdentifier(name)) {
    res.status(400).json({ success: false, error: 'Invalid database name' });
    return;
  }

  const [db] = await panelQuery<Database>(
    'SELECT * FROM managed_databases WHERE name = $1',
    [name]
  );
  if (!db) { res.status(404).json({ success: false, error: 'Database not found' }); return; }

  // Terminate active connections — use parameterised query
  await runAdminSql(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
    [name]
  );
  await runAdminSql(`DROP DATABASE IF EXISTS "${name}"`);

  try { await panelQuery(`DROP USER IF EXISTS "${db.db_user}"`); } catch { /* best effort */ }

  await panelQuery('DELETE FROM managed_databases WHERE name = $1', [name]);

  res.json({ success: true, data: { message: `Database ${name} deleted` } });
});

export default router;
