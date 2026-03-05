# ServerPanel — Deployment Guide

## Requirements

- Ubuntu 22.04 or 24.04 (fresh VPS, root access)
- Minimum 1 GB RAM (panel uses ~15 MB; rest is for your apps)
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
- Go (for building the backend)
- Node.js LTS (for building the frontend and running deployed apps)
- PM2 (process manager)
- NGINX (serves static frontend + proxies API requests)
- PostgreSQL
- Redis
- UFW firewall (SSH + HTTP/HTTPS allowed)
- The panel backend (Go binary) + frontend (static build)

When it finishes it prints your server IP. Open `http://YOUR_IP` in a browser and log in.

---

## Default Login

| Field    | Value      |
|----------|------------|
| Username | `admin`    |
| Password | `changeme` |

**Change the password immediately after first login** (see below).

---

## How It Works

The panel runs as two components:

1. **Go binary** (`panel-server`) — the API backend, managed by PM2, listening on `127.0.0.1:4000`
2. **Static frontend** — pre-built HTML/JS/CSS in `/opt/panel/frontend/dist/`, served directly by NGINX

There is no Node.js process for the frontend. NGINX handles:
- Serving the SPA (`index.html` + hashed assets)
- Proxying `/api/*` and `/health` requests to the Go backend
- SPA fallback routing (`try_files` to `index.html`)

---

## Adding Domains to Hosted Apps

The panel runs on port 80 via IP. When you deploy apps and assign domains, the
panel writes per-domain NGINX configs that sit alongside the panel config — they
do not conflict because each config listens on a specific `server_name`.

Flow:
1. Deploy an app via **Apps > New App**
2. Go to **Domains > Add Domain** and enter the domain for that app
3. Point the domain's DNS A record at the VPS IP
4. Go to **SSL > Issue SSL** to get a Let's Encrypt certificate

NGINX configs are written to `/etc/nginx/sites-available/<domain>` and
symlinked to `/etc/nginx/sites-enabled/<domain>` automatically.

---

## Changing the Admin Password

```bash
# Generate a bcrypt hash of your new password using Go:
export PATH=/usr/local/go/bin:$PATH
go run -e 'package main; import ("fmt"; "golang.org/x/crypto/bcrypt"); func main() { h, _ := bcrypt.GenerateFromPassword([]byte("YourNewPassword"), 12); fmt.Println(string(h)) }'

# Or using Node.js (if installed):
node -e "const b=require('bcryptjs'); b.hash('YourNewPassword', 12).then(console.log)"

# Or using Python:
python3 -c "import bcrypt; print(bcrypt.hashpw(b'YourNewPassword', bcrypt.gensalt(12)).decode())"

# Edit the backend env file
nano /opt/panel/backend/.env

# Set the hash (IMPORTANT: wrap in single quotes to preserve $ characters):
# ADMIN_PASSWORD_HASH='$2a$12$...'
# Remove any ADMIN_PASSWORD= line

# Restart the backend
pm2 restart panel-backend
```

**Important:** The bcrypt hash contains `$` characters. In the `.env` file,
always wrap the hash value in **single quotes** to prevent variable
interpolation by godotenv.

---

## Updating the Panel

```bash
cd /opt/panel
git pull

# Rebuild the Go backend
cd backend
export PATH=/usr/local/go/bin:$PATH
go build -o panel-server ./main.go
pm2 restart panel-backend

# Rebuild the frontend (no process restart needed — NGINX serves static files)
cd ../frontend
npm install
npm run build
```

---

## Building from Source

### Backend (Go)

```bash
cd /opt/panel/backend
export PATH=/usr/local/go/bin:$PATH
go mod tidy
go build -o panel-server ./main.go
```

This produces a single `panel-server` binary (~13 MB).

### Frontend (Vite + React)

```bash
cd /opt/panel/frontend
npm install
npm run build
```

This produces static files in `dist/` (index.html + hashed JS/CSS assets).

---

## Directory Structure

```
/opt/panel/
  backend/            Go API server
    main.go           Entry point
    internal/         Handlers, services, middleware, config
    panel-server      Compiled binary (built on VPS)
    .env              Environment config (not committed to git)
  frontend/           Vite + React SPA
    src/              Source code
    dist/             Built static files (served by NGINX)
  scripts/            Bash automation scripts

/var/www/apps/
  <app-name>/         Each deployed application

/etc/nginx/
  sites-available/    NGINX configs (panel + one per app domain)
  sites-enabled/      Symlinks to active configs

/var/log/panel/       Panel application logs
```

---

## PM2 Commands

```bash
pm2 list                    # show all processes
pm2 logs panel-backend      # Go backend logs
pm2 logs <app-name>         # deployed app logs
pm2 restart panel-backend   # restart the Go backend
pm2 restart <app-name>      # restart a deployed app
pm2 stop <app-name>         # stop an app
pm2 delete <app-name>       # remove from PM2
```

Note: There is no `panel-frontend` PM2 process. The frontend is served as
static files by NGINX.

---

## NGINX Configuration

The panel NGINX config is at `/etc/nginx/sites-enabled/panel`:

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root /opt/panel/frontend/dist;
    index index.html;

    client_max_body_size 100M;

    # API requests proxied to Go backend
    location /api/ {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        add_header Cache-Control "no-store, no-cache" always;
    }

    # Health check proxied to Go backend
    location /health {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Static assets with long-term caching
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA fallback — all other paths serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## Firewall

The setup script enables UFW automatically:
- SSH (port 22) — allowed
- HTTP (port 80) — allowed
- HTTPS (port 443) — allowed
- Everything else — blocked

The Go backend (port 4000) is **not** exposed — it only listens on
`127.0.0.1` and is proxied by NGINX.

---

## Environment Variables Reference

### `/opt/panel/backend/.env`

| Variable              | Description                                     |
|-----------------------|-------------------------------------------------|
| `PORT`                | Backend API port (default: 4000)                |
| `NODE_ENV`            | Set to `production` for strict JWT validation   |
| `JWT_SECRET`          | Secret for signing JWTs — keep this private     |
| `ADMIN_USERNAME`      | Panel admin username                            |
| `ADMIN_PASSWORD_HASH` | bcrypt hash — wrap in single quotes in .env     |
| `DATABASE_URL`        | PostgreSQL connection string for panel metadata |
| `APPS_DIR`            | Where apps are stored (default: /var/www/apps)  |
| `NGINX_AVAILABLE`     | NGINX sites-available path                      |
| `NGINX_ENABLED`       | NGINX sites-enabled path                        |
| `SCRIPTS_DIR`         | Path to panel scripts directory                 |
| `APP_PORT_START`      | Start of port range for hosted apps (3001)      |
| `APP_PORT_END`        | End of port range for hosted apps (3999)        |
| `PANEL_ORIGIN`        | Panel URL for CORS and cookie Secure flag       |

The frontend has no runtime environment variables — it is built as a static
SPA that calls `/api/*` on the same origin.

---

## Troubleshooting

### Login returns "Invalid credentials"

Check that `ADMIN_PASSWORD_HASH` in `.env` is wrapped in single quotes:
```
ADMIN_PASSWORD_HASH='$2a$12$...'
```
Without quotes, `godotenv` interprets `$2a`, `$12`, etc. as variable
references and strips them.

### Go backend won't start

Check logs: `pm2 logs panel-backend --lines 50 --nostream`

Common causes:
- Missing `.env` file at `/opt/panel/backend/.env`
- Invalid `DATABASE_URL` — verify PostgreSQL is running and credentials are correct
- Port 4000 already in use — check with `ss -tlnp | grep 4000`

### Frontend shows blank page

Verify the build exists: `ls /opt/panel/frontend/dist/index.html`

If missing, rebuild: `cd /opt/panel/frontend && npm run build`

### 502 Bad Gateway

The Go backend is not running. Check: `pm2 list` and `pm2 logs panel-backend`

Restart: `pm2 restart panel-backend`

### Health check

```bash
curl http://127.0.0.1/health
# Should return: {"ok":true,"uptime":<seconds>}
```
