const BASE = '/api';

/**
 * Auth is handled via HttpOnly cookies set by the backend.
 * The browser sends the cookie automatically with every request.
 */

export function clearToken(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('panel_token');
    document.cookie = 'panel_token=; path=/; max-age=0';
  }
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ success: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !path.startsWith('/auth/')) {
      clearToken();
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
      return { success: false, error: 'Session expired. Redirecting to login...' };
    }

    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return { success: false, error: `Request failed: ${message}` };
  }
}

export const api = {
  post:   <T>(path: string, body?: unknown) => req<T>('POST',   path, body),
  get:    <T>(path: string)                 => req<T>('GET',    path),
  put:    <T>(path: string, body?: unknown) => req<T>('PUT',    path, body),
  delete: <T>(path: string)                 => req<T>('DELETE', path),
};

export interface Domain {
  id: string; app_id: string; domain: string;
  ssl_enabled: boolean; created_at: string;
}
export interface App {
  id: string; name: string; repo_url: string; branch: string;
  port: number; domains: Domain[];
  status: string; cpu: number; memory: number;
  env_vars: Record<string, string>; created_at: string;
  webhook_secret?: string; max_memory: number; max_restarts: number;
}
export interface ManagedDb {
  id: string; name: string; db_user: string; created_at: string;
  connection_string?: string;
}
export interface RedisInfo {
  installed: boolean; running: boolean;
  connection: { host: string; port: number; url: string; env_var: string } | null;
}
