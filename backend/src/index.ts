import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { initDb } from './services/db';
import { logger } from './services/logger';
import { authMiddleware } from './middleware/auth';

import authRouter      from './routes/auth';
import appsRouter      from './routes/apps';
import domainsRouter   from './routes/domains';
import sslRouter       from './routes/ssl';
import databasesRouter from './routes/databases';
import redisRouter     from './routes/redis';
import filesRouter     from './routes/files';
import logsRouter      from './routes/logs';
import statsRouter     from './routes/stats';

const app  = express();
const PORT = parseInt(process.env.PORT ?? '4000', 10);

// ─── Security middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.PANEL_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json({ limit: '10mb' }));

// Aggressive rate-limit on auth endpoint
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));

// General API rate-limit
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

// All routes below require a valid JWT
app.use('/api', authMiddleware);

app.use('/api/apps',      appsRouter);
app.use('/api/domains',   domainsRouter);
app.use('/api/ssl',       sslRouter);
app.use('/api/databases', databasesRouter);
app.use('/api/redis',     redisRouter);
app.use('/api/files',     filesRouter);
app.use('/api/logs',      logsRouter);
app.use('/api/stats',     statsRouter);

// Health check (no auth)
app.get('/health', (_req, res) => res.json({ ok: true }));

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err.message, err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── Boot ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await initDb();
  app.listen(PORT, '127.0.0.1', () => {
    logger.info(`Panel API listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch((err) => {
  logger.error('Failed to start', err);
  process.exit(1);
});
