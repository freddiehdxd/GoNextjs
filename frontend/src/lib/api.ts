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
  app_type: string; build_cmd: string; start_cmd: string;
  root_dir: string; output_dir: string; install_cmd: string;
}
export interface ManagedDb {
  id: string; name: string; db_user: string; created_at: string;
  connection_string?: string;
}
export interface RedisInfo {
  installed: boolean; running: boolean;
  connection: { host: string; port: number; url: string; env_var: string } | null;
}

export interface CronJob {
  id: string;
  app_id: string | null;
  name: string;
  schedule: string;
  command: string | null;
  action: string | null;
  enabled: boolean;
  max_runtime: number;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
}

export interface CronRun {
  id: number;
  job_id: string;
  started_at: string;
  finished_at: string | null;
  timeout_at: string | null;
  status: 'running' | 'success' | 'error' | 'timeout' | 'missed';
  exit_code: number | null;
  output: string;
}

export interface DetectedType { app_type: string; root_dir: string; error: string }
export interface UnmanagedDir {
  name: string; path: string; size_bytes: number; modified_at: string;
  valid_name: boolean; detected: DetectedType; detected_port: number;
  git: { repo_url: string; branch: string } | null;
  pm2: { status: string; port: number } | null;
  has_env: boolean; has_ecosystem: boolean; domains: string[];
}
export interface OrphanedApp { name: string; port: number; domains: string[]; pm2_status: string }
export interface ScanResult { apps_dir: string; unmanaged: UnmanagedDir[]; orphaned: OrphanedApp[] }
