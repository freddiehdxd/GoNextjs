export interface App {
  id: string;
  name: string;
  repo_url: string;
  branch: string;
  port: number;
  domain: string | null;
  ssl_enabled: boolean;
  status: 'running' | 'stopped' | 'errored' | 'unknown';
  env_vars: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface Database {
  id: string;
  name: string;
  db_user: string;
  password: string;
  created_at: string;
}

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
