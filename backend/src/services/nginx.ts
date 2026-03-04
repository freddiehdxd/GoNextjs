import fs from 'fs/promises';
import path from 'path';
import { runBin } from './executor';
import { logger } from './logger';

const NGINX_AVAILABLE = process.env.NGINX_AVAILABLE ?? '/etc/nginx/sites-available';
const NGINX_ENABLED   = process.env.NGINX_ENABLED   ?? '/etc/nginx/sites-enabled';

export function buildNginxConfig(domain: string, port: number, ssl: boolean): string {
  if (ssl) {
    return `# Managed by Panel – do not edit manually
server {
    listen 80;
    server_name ${domain};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${domain};

    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    client_max_body_size 100M;

    location / {
        proxy_pass         http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
  }

  return `# Managed by Panel – do not edit manually
server {
    listen 80;
    server_name ${domain};

    client_max_body_size 100M;

    location / {
        proxy_pass         http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
}

export async function writeNginxConfig(domain: string, port: number, ssl: boolean): Promise<void> {
  const config     = buildNginxConfig(domain, port, ssl);
  const available  = path.join(NGINX_AVAILABLE, domain);
  const enabled    = path.join(NGINX_ENABLED, domain);

  await fs.writeFile(available, config, 'utf8');

  // Create symlink (remove old one first if present)
  try { await fs.unlink(enabled); } catch { /* ok if missing */ }
  await fs.symlink(available, enabled);

  logger.info(`NGINX config written for ${domain}`);
}

export async function removeNginxConfig(domain: string): Promise<void> {
  const available = path.join(NGINX_AVAILABLE, domain);
  const enabled   = path.join(NGINX_ENABLED, domain);
  try { await fs.unlink(enabled); }   catch { /* ok */ }
  try { await fs.unlink(available); } catch { /* ok */ }
}

export async function testAndReloadNginx(): Promise<{ success: boolean; message: string }> {
  const test = await runBin('nginx', ['-t']);
  if (test.code !== 0) {
    return { success: false, message: `NGINX config test failed:\n${test.stderr}` };
  }
  const reload = await runBin('nginx', ['-s', 'reload']);
  return {
    success: reload.code === 0,
    message: reload.code === 0 ? 'NGINX reloaded' : reload.stderr,
  };
}
