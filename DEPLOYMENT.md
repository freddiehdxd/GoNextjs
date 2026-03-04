# Panel — Deployment Guide

## Requirements

- Ubuntu 22.04 or 24.04 (fresh VPS recommended)
- Root / sudo access
- A domain pointing to the server's IP (for SSL)
- Ports 80 and 443 open in your firewall

---

## Quick Install

```bash
# 1. Clone the panel repo to your server
git clone https://github.com/youruser/panel.git /opt/panel

# 2. Run the setup script (as root)
cd /opt/panel
bash scripts/setup_panel.sh
```

The script installs and configures:
- Node.js LTS
- PM2 (process manager)
- NGINX
- PostgreSQL
- Redis
- The panel backend + frontend

---

## Exposing the Panel via NGINX

After installation, add the panel's own NGINX config so you can reach it at a domain:

```bash
# Copy the example config
cp /opt/panel/nginx-templates/panel.conf.example \
   /etc/nginx/sites-available/panel.example.com

# Edit and replace panel.example.com with your actual domain
nano /etc/nginx/sites-available/panel.example.com

# Enable it
ln -s /etc/nginx/sites-available/panel.example.com \
      /etc/nginx/sites-enabled/panel.example.com

# Test and reload
nginx -t && nginx -s reload
```

Then issue an SSL certificate for the panel itself:

```bash
certbot --nginx -d panel.example.com --email you@example.com --agree-tos --non-interactive
```

---

## Securing the Admin Password

The default password is `changeme`. Generate a bcrypt hash and set it in `.env`:

```bash
# Generate hash (Node.js one-liner)
node -e "const b=require('bcryptjs'); b.hash('YourNewPassword', 12).then(console.log)"

# Edit backend/.env
nano /opt/panel/backend/.env
# Set: ADMIN_PASSWORD_HASH=<the hash above>
# Remove or comment out: ADMIN_PASSWORD

# Rebuild and restart backend
cd /opt/panel/backend && npm run build
pm2 restart panel-backend
```

---

## Firewall Setup (UFW)

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'   # ports 80 + 443
ufw enable
```

The backend API (port 4000) should **not** be opened — it only listens on `127.0.0.1` and is accessed via Next.js rewrites.

---

## Deploying Your First Next.js App

1. Open the panel in your browser
2. Go to **Apps** → **New App**
3. Enter app name, Git repository URL, and branch
4. Add any environment variables your app needs
5. Click **Deploy**

The panel will:
- Clone your repo to `/var/www/apps/<name>`
- Run `npm ci && npm run build`
- Start the app with PM2 on an auto-assigned port

Then:
6. Go to **Domains** → **Add Domain** → enter your domain
7. Go to **SSL** → click **Issue SSL** for that domain

---

## Directory Structure

```
/opt/panel/
  backend/          Node.js API (Express + TypeScript)
  frontend/         Next.js admin UI
  scripts/          Bash automation scripts

/var/www/apps/
  <app-name>/       Each deployed Next.js app

/etc/nginx/
  sites-available/  NGINX configs (one per domain)
  sites-enabled/    Symlinks to active configs

/var/log/panel/     Panel + PM2 application logs
```

---

## PM2 Commands

```bash
pm2 list                    # show all processes
pm2 logs panel-backend      # backend logs
pm2 logs <app-name>         # app logs
pm2 restart <app-name>      # restart app
pm2 stop <app-name>         # stop app
pm2 delete <app-name>       # remove from PM2
```

---

## Updating the Panel

```bash
cd /opt/panel
git pull

# Backend
cd backend && npm install && npm run build
pm2 restart panel-backend

# Frontend
cd ../frontend && npm install && npm run build
pm2 restart panel-frontend
```

---

## Environment Variables Reference

### `backend/.env`

| Variable             | Description                                    |
|----------------------|------------------------------------------------|
| `PORT`               | Backend API port (default: 4000)               |
| `JWT_SECRET`         | Secret for signing JWTs — keep this private    |
| `ADMIN_USERNAME`     | Panel admin username                           |
| `ADMIN_PASSWORD`     | Plain password (dev only)                      |
| `ADMIN_PASSWORD_HASH`| bcrypt hash — use this in production           |
| `DATABASE_URL`       | PostgreSQL connection string for panel's own DB|
| `APPS_DIR`           | Where apps are stored (default: /var/www/apps) |
| `NGINX_AVAILABLE`    | NGINX sites-available path                     |
| `NGINX_ENABLED`      | NGINX sites-enabled path                       |
| `SCRIPTS_DIR`        | Path to panel scripts directory                |
| `APP_PORT_START`     | Start of port range for hosted apps            |
| `APP_PORT_END`       | End of port range for hosted apps              |
| `PANEL_ORIGIN`       | Frontend URL for CORS (e.g. https://panel.example.com) |

### `frontend/.env.local`

| Variable       | Description                                  |
|----------------|----------------------------------------------|
| `BACKEND_URL`  | Backend URL for Next.js rewrites (internal)  |
