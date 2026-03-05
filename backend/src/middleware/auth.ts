import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';

// No fallback — startup validation in index.ts guarantees JWT_SECRET exists
const JWT_SECRET = process.env.JWT_SECRET!;

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing token' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

export function signToken(username: string): string {
  return jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '12h' });
}
