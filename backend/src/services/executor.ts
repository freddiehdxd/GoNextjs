/**
 * Safe command executor.
 * Only a fixed allowlist of scripts and system commands may be run.
 * Arbitrary shell execution is never permitted.
 */
import { spawn } from 'child_process';
import path from 'path';
import { logger } from './logger';

const SCRIPTS_DIR = process.env.SCRIPTS_DIR ?? '/opt/panel/scripts';
const APPS_DIR    = process.env.APPS_DIR    ?? '/var/www/apps';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a pre-approved bash script from SCRIPTS_DIR with validated args. */
export function runScript(
  script: AllowedScript,
  args: string[] = []
): Promise<ExecResult> {
  const scriptPath = path.join(SCRIPTS_DIR, script);
  return spawnSafe('/bin/bash', [scriptPath, ...args]);
}

/** Run a whitelisted system binary with validated args. */
export function runBin(
  bin: AllowedBin,
  args: string[] = []
): Promise<ExecResult> {
  const fullPath = BIN_PATHS[bin];
  return spawnSafe(fullPath, args);
}

// ─── Allowlists ──────────────────────────────────────────────────────────────

export type AllowedScript =
  | 'install_nginx.sh'
  | 'install_postgres.sh'
  | 'install_redis.sh'
  | 'deploy_next_app.sh'
  | 'create_ssl.sh';

export type AllowedBin =
  | 'pm2'
  | 'nginx'
  | 'certbot'
  | 'systemctl'
  | 'psql';

const BIN_PATHS: Record<AllowedBin, string> = {
  pm2:      '/usr/bin/pm2',
  nginx:    '/usr/sbin/nginx',
  certbot:  '/usr/bin/certbot',
  systemctl:'/bin/systemctl',
  psql:     '/usr/bin/psql',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function spawnSafe(bin: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    logger.debug(`exec: ${bin} ${args.join(' ')}`);

    const proc = spawn(bin, args, {
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/root',
        APPS_DIR,
      },
      shell: false, // never use shell interpolation
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      const result: ExecResult = { stdout, stderr, code: code ?? 1 };
      if (code !== 0) {
        logger.warn(`exec failed (${code}): ${bin} ${args.join(' ')}\n${stderr}`);
      }
      resolve(result);
    });

    proc.on('error', (err) => {
      logger.error(`exec error: ${err.message}`);
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
}

/** Validate that a string is a safe app name (alphanumeric + hyphens only). */
export function validateAppName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);
}

/** Validate a domain name. */
export function validateDomain(domain: string): boolean {
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
}

/** Validate a PostgreSQL identifier. */
export function validatePgIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}
