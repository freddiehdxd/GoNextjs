const BASE = '/api';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('panel_token');
}

export function setToken(t: string): void { localStorage.setItem('panel_token', t); }
export function clearToken(): void        { localStorage.removeItem('panel_token'); }

async function req<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ success: boolean; data?: T; error?: string }> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export const api = {
  post:   <T>(path: string, body?: unknown) => req<T>('POST',   path, body),
  get:    <T>(path: string)                 => req<T>('GET',    path),
  put:    <T>(path: string, body?: unknown) => req<T>('PUT',    path, body),
  delete: <T>(path: string)                 => req<T>('DELETE', path),
};

// ── Typed helpers ────────────────────────────────────────────────────────────
export interface App {
  id: string; name: string; repo_url: string; branch: string;
  port: number; domain: string | null; ssl_enabled: boolean;
  status: string; cpu: number; memory: number;
  env_vars: Record<string, string>; created_at: string;
}
export interface ManagedDb {
  id: string; name: string; db_user: string; created_at: string;
  connection_string?: string;
}
export interface RedisInfo {
  installed: boolean; running: boolean;
  connection: { host: string; port: number; url: string; env_var: string } | null;
}
