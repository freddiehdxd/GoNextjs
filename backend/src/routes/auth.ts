import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { signToken } from '../middleware/auth';

const router = Router();

// In production, ADMIN_PASSWORD_HASH should be a bcrypt hash.
// Fall back to plain comparison in dev (with a warning).
const ADMIN_USERNAME      = process.env.ADMIN_USERNAME      ?? 'admin';
const ADMIN_PASSWORD      = process.env.ADMIN_PASSWORD      ?? 'changeme';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ?? '';

router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ success: false, error: 'username and password required' });
    return;
  }

  if (username !== ADMIN_USERNAME) {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
    return;
  }

  let valid = false;
  if (ADMIN_PASSWORD_HASH) {
    valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  } else {
    // Dev-only plain comparison
    valid = password === ADMIN_PASSWORD;
  }

  if (!valid) {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
    return;
  }

  const token = signToken(username);
  res.json({ success: true, data: { token } });
});

export default router;
