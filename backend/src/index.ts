import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import { initDb, pool } from './services/db';
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

// ─── Startup validation ──────────────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me') {
  if (process.env.NODE_ENV === 'production') {
    logger.error('FATAL: JWT_SECRET is not set or is the default. Refusing to start in production.');
    process.exit(1);
  }
  logger.warn('JWT_SECRET is not set — using insecure default. DO NOT run this in production.');
}

if (!process.env.DATABASE_URL) {
  logger.error('FATAL: DATABASE_URL is not set.');
  process.exit(1);
}

// ─── Security middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(compression());
app.use(cors({ origin: process.env.PANEL_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json({ limit: '10mb' }));

// Rate limits
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

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
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err.message, { stack: err.stack });
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Unhandled rejection / exception safety net ──────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

// ─── Boot ────────────────────────────────────────────────────────────────────
let server: ReturnType<typeof app.listen>;

async function main(): Promise<void> {
  await initDb();
  server = app.listen(PORT, '127.0.0.1', () => {
    logger.info(`Panel API listening on http://127.0.0.1:${PORT}`);
  });

  // Keep-alive timeout should exceed NGINX proxy_read_timeout
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received — shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Drain database pool
  try { await pool.end(); } catch { /* already closed */ }

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error('Failed to start', err);
  process.exit(1);
});
