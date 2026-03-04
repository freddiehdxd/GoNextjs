import { query } from './db';

const PORT_START = parseInt(process.env.APP_PORT_START ?? '3001', 10);
const PORT_END   = parseInt(process.env.APP_PORT_END   ?? '3999', 10);

export async function allocatePort(): Promise<number> {
  const rows = await query<{ port: number }>('SELECT port FROM apps ORDER BY port');
  const used  = new Set(rows.map((r) => r.port));

  for (let p = PORT_START; p <= PORT_END; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('No free ports available in the configured range');
}
