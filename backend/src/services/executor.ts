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

// Buffer size limits
const MAX_STDOUT = 10 * 1024 * 1024; // 10 MB
const MAX_STDERR = 10 * 1024 * 1024; // 10 MB

// Timeout defaults (milliseconds)
const DEPLOY_TIMEOUT = 5 * 60 * 1000;   // 5 minutes for deploys
const DEFAULT_TIMEOUT = 2 * 60 * 1000;  // 2 minutes for everything else

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
  // Deploy scripts get a longer timeout
  const timeout = script === 'deploy_next_app.sh' ? DEPLOY_TIMEOUT : DEFAULT_TIMEOUT;
  return spawnSafe('/bin/bash', [scriptPath, ...args], timeout);
}

/** Run a whitelisted system binary with validated args. */
export function runBin(
  bin: AllowedBin,
  args: string[] = []
): Promise<ExecResult> {
  const fullPath = BIN_PATHS[bin];
  return spawnSafe(fullPath, args, DEFAULT_TIMEOUT);
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

function spawnSafe(bin: string, args: string[], timeout: number): Promise<ExecResult> {
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;

    // Enforce timeout
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      logger.warn(`exec timeout (${timeout}ms): ${bin} ${args.join(' ')}`);
    }, timeout);

    proc.stdout.on('data', (d) => {
      if (stdoutTruncated) return;
      stdout += d.toString();
      if (stdout.length > MAX_STDOUT) {
        stdoutTruncated = true;
        stdout = stdout.slice(0, MAX_STDOUT) + '\n... [output truncated at 10MB]';
        proc.stdout.destroy();
      }
    });

    proc.stderr.on('data', (d) => {
      if (stderrTruncated) return;
      stderr += d.toString();
      if (stderr.length > MAX_STDERR) {
        stderrTruncated = true;
        stderr = stderr.slice(0, MAX_STDERR) + '\n... [output truncated at 10MB]';
        proc.stderr.destroy();
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const result: ExecResult = {
        stdout,
        stderr: killed ? `Process timed out after ${timeout / 1000}s\n${stderr}` : stderr,
        code: killed ? 124 : (code ?? 1),
      };
      if (code !== 0) {
        logger.warn(`exec failed (${result.code}): ${bin} ${args.join(' ')}\n${stderr.slice(0, 500)}`);
      }
      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
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
