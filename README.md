# GoNextjs — Self-Hosted Deployment Control Panel

A lightweight, production-safe server control panel for deploying and managing
web applications on a single Ubuntu 22.04+ server. Built with a Go backend and
a Vite + React frontend for minimal resource usage (~15 MB RAM for the API).

## Features

| Feature         | Details                                                   |
|-----------------|-----------------------------------------------------------|
| Authentication  | JWT-based admin login with bcrypt, rate limiting, lockout |
| App Management  | Deploy via Git, build, start/stop/restart/delete with PM2 |
| Domain Mgmt     | Auto-generate NGINX reverse-proxy configs                 |
| SSL             | Let's Encrypt via Certbot, auto-renewal                   |
| Databases       | Create PostgreSQL databases + users                       |
| Redis           | Install + show connection info                            |
| File Manager    | Browse, edit, upload files in `/var/www/apps`             |
| Logs            | View PM2 and NGINX logs                                   |
| System Stats    | Live CPU, memory, disk usage with ring gauges             |

## Stack

- **Backend**: Go (Chi router, pgx, golang-jwt, bcrypt)
- **Frontend**: Vite, React, React Router, Tailwind CSS, Lucide icons
- **Infra**: NGINX (serves static frontend + reverse proxy), PM2, PostgreSQL, Redis, Certbot

## Architecture

```
Browser -> NGINX (port 80)
  |-- /               -> serves /opt/panel/frontend/dist/index.html (SPA)
  |-- /assets/*       -> serves static JS/CSS with 1-year cache
  |-- /api/*          -> proxy to Go binary on 127.0.0.1:4000
  |-- /health         -> proxy to Go binary on 127.0.0.1:4000
  '-- /* (fallback)   -> /index.html (SPA client-side routing)

Go binary (127.0.0.1:4000) — single process, ~15 MB RAM
  |-- /health                  -> health check
  |-- /api/auth/*              -> login, logout, me (no auth middleware)
  '-- /api/* (protected)       -> all other endpoints (auth + audit middleware)
```

No Node.js process is needed for the frontend — NGINX serves the pre-built
static files directly. The Go binary is the only runtime process.

## Quick Start

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full installation guide.

```bash
git clone https://github.com/freddiehdxd/panel.git /opt/panel
bash /opt/panel/scripts/setup_panel.sh
```

## Project Structure

```
panel/
├── backend/                       Go API server
│   ├── main.go                    Entry point, Chi router, middleware, routes
│   ├── go.mod                     Module dependencies
│   └── internal/
│       ├── config/config.go       Environment variable loading + validation
│       ├── models/models.go       App, Database, AuditEntry, Stats structs
│       ├── middleware/
│       │   ├── auth.go            JWT cookie/header verification, context user
│       │   ├── audit.go           POST/PUT/DELETE audit logging
│       │   └── helpers.go         writeJSON helper
│       ├── handlers/
│       │   ├── helpers.go         JSON response + request helpers
│       │   ├── auth.go            Login (lockout, bcrypt), logout, me
│       │   ├── apps.go            CRUD, deploy, PM2 actions, env vars
│       │   ├── domains.go         Add/remove domain + NGINX rollback
│       │   ├── ssl.go             Certbot + NGINX SSL config
│       │   ├── databases.go       PostgreSQL user/db CRUD
│       │   ├── redis.go           Status check + install
│       │   ├── files.go           Browse, read, write, upload
│       │   ├── logs.go            PM2 logs + NGINX tail
│       │   └── stats.go           Background /proc collector (10s goroutine)
│       └── services/
│           ├── db.go              pgx connection pool, schema init
│           ├── executor.go        Allowlisted command runner with timeouts
│           ├── pm2.go             PM2 jlist, action, logs
│           ├── nginx.go           Config builder, write, reload
│           └── port.go            Port allocator (3001-3999)
├── frontend/                      Vite + React SPA
│   ├── index.html                 SPA entry point
│   ├── package.json               Vite + React + React Router + Lucide
│   ├── vite.config.ts             Dev proxy /api -> :4000, build -> dist/
│   ├── tailwind.config.ts
│   └── src/
│       ├── main.tsx               ReactDOM + BrowserRouter
│       ├── App.tsx                Routes + ProtectedRoute (checks /api/auth/me)
│       ├── index.css              Tailwind + custom styles
│       ├── lib/api.ts             Fetch wrapper with credentials
│       ├── components/
│       │   ├── Shell.tsx          Layout wrapper
│       │   ├── Nav.tsx            Sidebar navigation
│       │   ├── Modal.tsx          Reusable modal
│       │   └── StatusBadge.tsx    Status indicator
│       └── pages/
│           ├── Login.tsx          Login form
│           ├── Dashboard.tsx      Ring gauges, stats, app table
│           ├── Apps.tsx           Deploy modal, env editor, PM2 actions
│           ├── Domains.tsx        Domain management
│           ├── SSL.tsx            Certificate issuance
│           ├── Databases.tsx      PostgreSQL CRUD
│           ├── Redis.tsx          Status + install
│           ├── Files.tsx          File browser + editor
│           ├── Logs.tsx           Log viewer with syntax coloring
│           └── NotFound.tsx       404 page
├── scripts/                       Bash automation
│   ├── setup_panel.sh             One-shot server setup
│   ├── install_nginx.sh
│   ├── install_postgres.sh
│   ├── install_redis.sh
│   ├── deploy_next_app.sh
│   └── create_ssl.sh
└── nginx-templates/
    ├── app.conf.example           Template for hosted apps
    └── panel.conf.example         Template for the panel itself
```

## API Endpoints

```
POST   /api/auth/login          Login (returns JWT + sets HttpOnly cookie)
POST   /api/auth/logout         Logout (clears cookie)
GET    /api/auth/me             Current user info

GET    /api/apps                List all apps
POST   /api/apps                Deploy a new app
GET    /api/apps/{name}         Get app details
POST   /api/apps/{name}/action  Start/stop/restart/delete an app
PUT    /api/apps/{name}/env     Update environment variables

POST   /api/domains             Add domain to an app
DELETE /api/domains/{domain}    Remove a domain

POST   /api/ssl                 Issue SSL certificate via Certbot

GET    /api/databases           List PostgreSQL databases
POST   /api/databases           Create database + user
DELETE /api/databases/{name}    Drop database + user

GET    /api/redis               Redis status + connection info
POST   /api/redis/install       Install Redis

GET    /api/files/{app}         List files in app directory
GET    /api/files/{app}/content Read file content
PUT    /api/files/{app}/content Write file content
POST   /api/files/{app}/upload  Upload files

GET    /api/logs/app/{name}     PM2 logs for an app
GET    /api/logs/nginx          NGINX access/error logs

GET    /api/stats               System stats (CPU, memory, disk, apps)
GET    /health                  Health check
```

## Security Model

- No arbitrary shell execution. The backend only runs commands from an explicit
  allowlist via `executor.go`, with argument validation to prevent injection.
- All inputs (app names, domains, PostgreSQL identifiers) are validated with
  strict regexes before being passed to any system command.
- The API backend listens only on `127.0.0.1:4000` — never exposed to the internet.
- JWT tokens expire after 2 hours.
- Login rate limiting: 10 req/15 min. General API: 300 req/60 sec.
- Login lockout: 5 failed attempts = 15-minute IP ban.
- Audit logging: all POST/PUT/DELETE requests are logged to the database.
- File manager enforces path traversal protection — all paths are resolved and
  checked to stay within `/var/www/apps/<appname>`.
- bcrypt password hashing (cost 12).

## Performance

Compared to the previous Express + Next.js stack:

| Metric           | Before (Express + Next.js) | After (Go + Vite static) |
|------------------|---------------------------|--------------------------|
| Backend RAM      | ~80 MB                    | ~15 MB                   |
| Frontend RAM     | ~120 MB (Node.js SSR)     | 0 MB (static files)      |
| Total server RAM | ~700 MB                   | ~300 MB                  |
| Binary size      | node_modules (~300 MB)    | ~13 MB single binary     |
| Cold start       | ~3 seconds                | < 100 ms                 |
