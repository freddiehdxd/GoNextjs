import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { validateAppName } from '../services/executor';

const router  = Router();
const APPS_DIR = process.env.APPS_DIR ?? '/var/www/apps';

/** Resolve and validate path stays inside APPS_DIR (path traversal guard) */
function safePath(appName: string, rel = ''): string | null {
  if (!validateAppName(appName)) return null;
  const base      = path.join(APPS_DIR, appName);
  const resolved  = path.resolve(base, rel.replace(/^\/+/, ''));
  if (!resolved.startsWith(base)) return null; // traversal attempt
  return resolved;
}

// GET /api/files/:app — list directory
router.get('/:app', async (req: Request, res: Response) => {
  const rel = (req.query['path'] as string) ?? '';
  const dir = safePath(req.params['app'] ?? '', rel);
  if (!dir) { res.status(400).json({ success: false, error: 'Invalid path' }); return; }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = entries.map((e) => ({
      name:      e.name,
      type:      e.isDirectory() ? 'dir' : 'file',
      path:      path.join(rel, e.name),
    }));
    res.json({ success: true, data: items });
  } catch {
    res.status(404).json({ success: false, error: 'Path not found' });
  }
});

// GET /api/files/:app/content — read file content
router.get('/:app/content', async (req: Request, res: Response) => {
  const rel = (req.query['path'] as string) ?? '';
  const filePath = safePath(req.params['app'] ?? '', rel);
  if (!filePath) { res.status(400).json({ success: false, error: 'Invalid path' }); return; }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      res.status(400).json({ success: false, error: 'Path is a directory' });
      return;
    }
    if (stat.size > 1_000_000) { // 1 MB limit for inline editing
      res.status(413).json({ success: false, error: 'File too large to edit inline (>1MB)' });
      return;
    }
    const content = await fs.readFile(filePath, 'utf8');
    res.json({ success: true, data: { content } });
  } catch {
    res.status(404).json({ success: false, error: 'File not found' });
  }
});

// PUT /api/files/:app/content — write file content
router.put('/:app/content', async (req: Request, res: Response) => {
  const rel     = (req.query['path'] as string) ?? '';
  const filePath = safePath(req.params['app'] ?? '', rel);
  if (!filePath) { res.status(400).json({ success: false, error: 'Invalid path' }); return; }

  const { content } = req.body as { content?: string };
  if (typeof content !== 'string') {
    res.status(400).json({ success: false, error: 'content string required' });
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  res.json({ success: true, data: { message: 'File saved' } });
});

// POST /api/files/:app/upload — upload files
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const rel = (req.query['path'] as string) ?? '';
      const dir = safePath(req.params['app'] ?? '', rel);
      if (!dir) { cb(new Error('Invalid path'), ''); return; }
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

router.post('/:app/upload', upload.array('files'), (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  res.json({ success: true, data: { uploaded: files.map((f) => f.filename) } });
});

export default router;
