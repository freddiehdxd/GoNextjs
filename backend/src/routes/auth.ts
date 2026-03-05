import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { signToken, verifyToken } from '../middleware/auth';
import { logger } from '../services/logger';

const router = Router();

const ADMIN_USERNAME      = process.env.ADMIN_USERNAME      ?? 'admin';
const ADMIN_PASSWORD      = process.env.ADMIN_PASSWORD      ?? '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ?? '';

// Cookie config
const COOKIE_NAME = 'panel_token';
const COOKIE_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours (matches JWT expiry)
// Only set Secure flag when actually behind HTTPS (not just production mode)
// Auto-detect: PANEL_ORIGIN starts with https://, or COOKIE_SECURE=true
const USE_SECURE_COOKIE =
  process.env.COOKIE_SECURE === 'true' ||
  (process.env.PANEL_ORIGIN ?? '').startsWith('https://');

// ─── Login lockout ────────────────────────────────────────────────────────────
// In-memory tracker: IP -> { count, lockedUntil }
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts) {
    if (data.lockedUntil < now && data.count === 0) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

function getClientIp(req: Request): string {
  return (req.headers['x-real-ip'] as string) ??
         (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
         req.ip ??
         'unknown';
}

function isLocked(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  // Lock expired — reset
  if (entry.lockedUntil > 0) {
    entry.count = 0;
    entry.lockedUntil = 0;
  }
  return false;
}

function recordFailure(ip: string): void {
  const entry = loginAttempts.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    logger.warn(`Login lockout: IP ${ip} locked for 15 minutes after ${entry.count} failed attempts`);
  }
  loginAttempts.set(ip, entry);
}

function clearFailures(ip: string): void {
  loginAttempts.delete(ip);
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  const ip = getClientIp(req);

  // Check lockout
  if (isLocked(ip)) {
    const entry = loginAttempts.get(ip)!;
    const remainingMs = entry.lockedUntil - Date.now();
    const remainingMin = Math.ceil(remainingMs / 60_000);
    logger.warn(`Blocked login attempt from locked IP: ${ip}`);
    res.status(429).json({
      success: false,
      error: `Too many failed attempts. Try again in ${remainingMin} minute${remainingMin > 1 ? 's' : ''}.`,
    });
    return;
  }

  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ success: false, error: 'username and password required' });
    return;
  }

  if (username !== ADMIN_USERNAME) {
    recordFailure(ip);
    // Deliberate generic message — don't reveal whether user exists
    res.status(401).json({ success: false, error: 'Invalid credentials' });
    return;
  }

  let valid = false;
  if (ADMIN_PASSWORD_HASH) {
    valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  } else if (ADMIN_PASSWORD) {
    valid = password === ADMIN_PASSWORD;
  }

  if (!valid) {
    recordFailure(ip);
    res.status(401).json({ success: false, error: 'Invalid credentials' });
    return;
  }

  // Success — clear lockout counter
  clearFailures(ip);

  const token = signToken(username);

  // Set HttpOnly cookie — browser sends it automatically, JS cannot read it
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: USE_SECURE_COOKIE,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  logger.info(`Successful login from IP: ${ip}`);

  // Also return token in body for backward compatibility
  res.json({ success: true, data: { token } });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: USE_SECURE_COOKIE, sameSite: 'lax', path: '/' });
  res.json({ success: true, data: { message: 'Logged out' } });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', (req: Request, res: Response) => {
  // Check cookie first, then Authorization header
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = cookieToken ?? headerToken;

  if (!token) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: USE_SECURE_COOKIE, sameSite: 'lax', path: '/' });
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
    return;
  }

  res.json({ success: true, data: { username: payload.sub } });
});

export default router;
