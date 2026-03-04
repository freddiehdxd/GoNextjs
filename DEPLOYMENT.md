# Panel — Deployment Guide

## Requirements

- Ubuntu 22.04 or 24.04 (fresh VPS, root access)
- Ports 80 and 443 open in your firewall
- A domain is **not required** — you can access the panel via the server IP

---

## Quick Install

```bash
# SSH into your VPS as root, then:
git clone https://github.com/freddiehdxd/panel.git /opt/panel
bash /opt/panel/scripts/setup_panel.sh
```

The script installs and configures everything automatically:
- Node.js LTS
- PM2 (process manager)
- NGINX (with IP-based panel access on port 80)
- PostgreSQL
- Redis
- UFW firewall (SSH + HTTP/HTTPS allowed)
- The panel backend + frontend

When it finishes it prints your server IP. Open `http://YOUR_IP` in a browser and log in.

---

## Default Login

| Field    | Value      |
|----------|------------|
| Username | `admin`    |
| Password | `changeme` |

**Change the password immediately after first login** (see below).

---

## Adding Domains to Hosted Apps

The panel runs on port 80 via IP. When you deploy apps and assign domains, the
panel writes per-domain NGINX configs that sit alongside the panel config — they
do not conflict because each config listens on a specific `server_name`.

Flow:
1. Deploy an app via **Apps → New App**
2. Go to **Domains → Add Domain** and enter the domain for that app
3. Point the domain's DNS A record at the VPS IP
4. Go to **SSL → Issue SSL** to get a Let's Encrypt certificate

NGINX configs are written to `/etc/nginx/sites-available/<domain>` and
symlinked to `/etc/nginx/sites-enabled/<domain>` automatically.

---

## Changing the Admin Password

```bash
# Generate a bcrypt hash of your new password
node -e "const b=require('bcryptjs'); b.hash('YourNewPassword', 12).then(console.log)"

# Edit the backend env file
nano /opt/panel/backend/.env
# Add:    ADMIN_PASSWORD_HASH=<paste hash here>
# Remove: ADMIN_PASSWORD=changeme

# Rebuild and restart
cd /opt/panel/backend && npm run build
pm2 restart panel-backend
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

## Directory Structure

```
/opt/panel/
  backend/          Node.js API (Express + TypeScript)
  frontend/         Next.js admin UI
  scripts/          Bash automation scripts

/var/www/apps/
  <app-name>/       Each deployed Next.js app

/etc/nginx/
  sites-available/  NGINX configs (panel + one per app domain)
  sites-enabled/    Symlinks to active configs

/var/log/panel/     Panel + PM2 application logs
```

---

## PM2 Commands

```bash
pm2 list                    # show all processes
pm2 logs panel-backend      # backend logs
pm2 logs panel-frontend     # frontend logs
pm2 logs <app-name>         # app logs
pm2 restart <app-name>      # restart app
pm2 stop <app-name>         # stop app
pm2 delete <app-name>       # remove from PM2
```

---

## Firewall

The setup script enables UFW automatically:
- SSH (port 22) — allowed
- HTTP (port 80) — allowed
- HTTPS (port 443) — allowed
- Everything else — blocked

The backend API (port 4000) is **not** exposed — it only listens on
`127.0.0.1` and is proxied internally by Next.js.

---

## Environment Variables Reference

### `/opt/panel/backend/.env`

| Variable              | Description                                     |
|-----------------------|-------------------------------------------------|
| `PORT`                | Backend API port (default: 4000)                |
| `JWT_SECRET`          | Secret for signing JWTs — keep this private     |
| `ADMIN_USERNAME`      | Panel admin username                            |
| `ADMIN_PASSWORD`      | Plain password (remove after setting hash)      |
| `ADMIN_PASSWORD_HASH` | bcrypt hash — use this in production            |
| `DATABASE_URL`        | PostgreSQL connection string for panel metadata |
| `APPS_DIR`            | Where apps are stored (default: /var/www/apps)  |
| `NGINX_AVAILABLE`     | NGINX sites-available path                      |
| `NGINX_ENABLED`       | NGINX sites-enabled path                        |
| `SCRIPTS_DIR`         | Path to panel scripts directory                 |
| `APP_PORT_START`      | Start of port range for hosted apps (3001)      |
| `APP_PORT_END`        | End of port range for hosted apps (3999)        |
| `PANEL_ORIGIN`        | Frontend URL for CORS                           |

### `/opt/panel/frontend/.env.local`

| Variable      | Description                                 |
|---------------|---------------------------------------------|
| `BACKEND_URL` | Backend URL for Next.js rewrites (internal) |
