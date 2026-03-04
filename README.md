# Panel — Self-Hosted Next.js Deployment Control Panel

A minimal, production-safe server control panel for deploying and managing
Next.js applications on a single Ubuntu 22.04+ server.

## Features

| Feature         | Details                                                   |
|-----------------|-----------------------------------------------------------|
| Authentication  | JWT-based admin login                                     |
| App Management  | Deploy via Git, build, start/stop/restart/delete with PM2 |
| Domain Mgmt     | Auto-generate NGINX reverse-proxy configs                 |
| SSL             | Let's Encrypt via Certbot, auto-renewal                   |
| Databases       | Create PostgreSQL databases + users                       |
| Redis           | Install + show connection info                            |
| File Manager    | Browse, edit, upload files in `/var/www/apps`             |
| Logs            | Stream PM2 and NGINX logs                                 |

## Stack

- **Frontend**: Next.js 14, React, Tailwind CSS
- **Backend**: Node.js, Express, TypeScript
- **Infra**: NGINX, PM2, PostgreSQL, Redis, Certbot

## Quick Start

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full installation guide.

```bash
git clone https://github.com/youruser/panel.git /opt/panel
bash /opt/panel/scripts/setup_panel.sh
```

## Project Structure

```
panel/
├── backend/                  Express API
│   └── src/
│       ├── index.ts          Entry point + middleware setup
│       ├── middleware/
│       │   └── auth.ts       JWT verification
│       ├── routes/
│       │   ├── auth.ts       POST /api/auth/login
│       │   ├── apps.ts       CRUD + actions for apps
│       │   ├── domains.ts    NGINX domain management
│       │   ├── ssl.ts        Certbot integration
│       │   ├── databases.ts  PostgreSQL management
│       │   ├── redis.ts      Redis status + install
│       │   ├── files.ts      File manager
│       │   └── logs.ts       PM2 + NGINX logs
│       ├── services/
│       │   ├── db.ts         PostgreSQL connection + schema
│       │   ├── executor.ts   Safe command allowlist
│       │   ├── logger.ts     Winston logger
│       │   ├── nginx.ts      Config generation + reload
│       │   ├── pm2.ts        PM2 integration
│       │   └── portAllocator.ts  Dynamic port assignment
│       └── types/
│           └── index.ts
├── frontend/                 Next.js admin UI
│   └── src/
│       ├── app/
│       │   ├── dashboard/    App overview table
│       │   ├── apps/         Deploy + manage apps
│       │   ├── domains/      Domain assignment
│       │   ├── ssl/          SSL certificate issuance
│       │   ├── databases/    PostgreSQL management
│       │   ├── redis/        Redis info
│       │   ├── files/        File manager
│       │   └── logs/         Log viewer
│       ├── components/       Nav, Shell, Modal, StatusBadge
│       └── lib/api.ts        Typed fetch wrapper
├── scripts/
│   ├── setup_panel.sh        One-shot server setup
│   ├── install_nginx.sh
│   ├── install_postgres.sh
│   ├── install_redis.sh
│   ├── deploy_next_app.sh
│   └── create_ssl.sh
└── nginx-templates/
    ├── app.conf.example      Template for hosted apps
    └── panel.conf.example    Template for the panel itself
```

## Security Model

- No arbitrary shell execution. The backend only runs scripts from an explicit
  allowlist via `executor.ts`, with `shell: false` to prevent injection.
- All inputs (app names, domains, PostgreSQL identifiers) are validated with
  strict regexes before being passed to any system command.
- The API backend listens only on `127.0.0.1` — never exposed to the internet.
- JWT tokens expire after 12 hours.
- Rate limiting on all API routes (20 req/15min on login, 300 req/min elsewhere).
- File manager enforces path traversal protection — all paths are resolved and
  checked to stay within `/var/www/apps/<appname>`.
