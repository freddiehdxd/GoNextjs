# Multi App Type Support Design

**Date:** 2026-04-04  
**Status:** Approved  
**Scope:** Support Vite, Static, Node.js, and Custom app types alongside existing Next.js support

---

## Overview

The panel currently only supports Next.js apps deployed via Git or ZIP. Users hitting `[error] No package.json found in repository root` when deploying Vite or other apps exposes the core limitation: the deploy pipeline assumes Next.js structure everywhere. This spec adds first-class support for `next`, `vite`, `static`, `node`, and `custom` app types with auto-detection and user override.

---

## Data Model

Six new fields added to the `apps` table and `App` struct:

| Field | Type | Default | Notes |
|---|---|---|---|
| `app_type` | TEXT | `next` | Enum: `next`, `vite`, `static`, `node`, `custom` |
| `build_cmd` | TEXT | `""` | Empty = use type default; full override if set |
| `start_cmd` | TEXT | `""` | Empty = use type default; ignored for `vite`/`static` |
| `root_dir` | TEXT | `"/"` | Subdir containing the app (monorepo support) |
| `output_dir` | TEXT | `"dist"` | Build output path, used by NGINX for static serving |
| `install_cmd` | TEXT | `""` | Empty = auto-detect from lockfile; override for pnpm/yarn |

**DB migration:** `ALTER TABLE apps ADD COLUMN` for each field with defaults.

---

## Auto-Detection Algorithm

Detection runs **once** — on app creation (or explicit "Re-detect" action). After that, stored `app_type` + `root_dir` are always used as-is. The deploy scripts never run detection.

### Step 1 — Explicit root_dir
If `root_dir` is set (not `/`), search only that directory. Skip to Step 4.

### Step 2 — Recursive scan
Walk up to **max 2 directory levels** from repo root. Do **not follow symlinks**.  
**Include:** all subdirectories at depth 1 and 2.  
**Hard-exclude:** `node_modules`, `.git`, `dist`, `build`, `.next`

Collect all directories containing `package.json`.

### Step 3 — Candidate scoring

| Signal | Score |
|---|---|
| Path segment matches `web`, `frontend`, `app`, `client`, `ui` | +2 |
| `package.json` has a `build` script | +1 |
| Path segment matches `api`, `server`, `backend` | −3 |
| Path is repo root | 0 (neutral) |

**Resolution:**
- **1 candidate:** use it
- **Clear winner (score gap ≥ 2):** use it; write resolved subdir back to `root_dir`
- **Tie / ambiguous:** fail with: *"Multiple app candidates found: `/web` (score 3), `/app` (score 3) — set root_dir to specify which app to deploy"*
- **0 candidates + `go.mod` exists:** `app_type = custom`, flagged as backend-only (excluded from frontend candidate scoring in monorepos)
- **0 candidates, no `go.mod`:** `app_type = static`

### Step 4 — Type detection (priority order)

1. `next.config.{js,ts,mjs}` present → `next`
2. `vite.config.{js,ts,mjs,cjs}` present → `vite`
3. `next` in `dependencies`/`devDependencies` → `next`
4. `vite` in `dependencies`/`devDependencies` → `vite`
5. Build script contains `next build` → `next` (confidence boost)
6. Build script contains `vite build` → `vite` (confidence boost)
7. `scripts.start` exists AND does not contain `vite preview` or `next start` → `node`
8. `express`, `fastify`, `koa`, or `hapi` in deps → `node`
9. Fallback → `custom`

---

## Deploy Pipeline

Both `deploy_app.sh` (renamed from `deploy_next_app.sh`) and `setup_app.sh` accept these env vars from the backend: `APP_TYPE`, `ROOT_DIR`, `OUTPUT_DIR`, `BUILD_CMD`, `START_CMD`, `INSTALL_CMD`, `APP_NAME`, `APP_ID`, `PORT`.

**Scripts never run auto-detection.** They trust the values passed in.

### Execution flow

```
1. cd to ROOT_DIR (validated, must exist)
2. Install step (skip for static)
3. Cleanup step (before build)
4. Build step
5. Post-build validation
6. Generate NGINX config
7. If process type: generate PM2 config, reload or start
8. nginx -t && nginx -s reload
```

### Install step

Detect package manager from lockfile (in priority order):

| Lockfile | Command | Prerequisite check |
|---|---|---|
| `package-lock.json` | `npm ci` | — |
| `pnpm-lock.yaml` | `pnpm install` | verify `pnpm` installed, else fail clearly |
| `yarn.lock` | `yarn install` | verify `yarn` installed, else fail clearly |
| none | `npm install` | — |

`INSTALL_CMD` overrides entirely if set.

### Cleanup step (before build)

Remove contents inside `OUTPUT_DIR`, not the directory itself:

```bash
# Guard: OUTPUT_DIR must not be empty or /
if [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = "/" ]; then
  echo "[error] Invalid OUTPUT_DIR" >&2; exit 1
fi
FULL_OUTPUT="$APP_DIR/$OUTPUT_DIR"
if [ -d "$FULL_OUTPUT" ]; then
  find "$FULL_OUTPUT" -mindepth 1 -delete
fi
```

### Build step

```
if BUILD_CMD is set    → run BUILD_CMD (full override)
else if type has default → run npm run build
else if no build script → skip (node) or fail (custom)
static                 → skip entirely
```

### Post-build validation

For `vite`/`static`/`custom` (no start_cmd):
- Verify `$APP_DIR/$OUTPUT_DIR/index.html` exists
- If not: fail with *"No index.html found in OUTPUT_DIR — not a valid static app"*

For `custom` with no `start_cmd` and no `OUTPUT_DIR` build output:
- Fail with *"custom app has no start_cmd and no output directory — set start_cmd or output_dir"*

### PM2 (process types: `next`, `node`, `custom` with `start_cmd`)

Process name = `app_${APP_ID}` to avoid collisions.

```bash
pm2 reload ecosystem.config.js --update-env || pm2 start ecosystem.config.js
```

Optional health check after start: poll `localhost:PORT` up to 10s; warn (not fail) if no response.

### NGINX config — static (`vite`, `static`, `custom` without `start_cmd`)

```nginx
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;

root /var/www/apps/APP_NAME/OUTPUT_DIR;
index index.html;

location = /index.html {
    add_header Cache-Control "no-cache";
}

location / {
    try_files $uri $uri/ /index.html;
}

location ~* \.(js|css|png|jpg|jpeg|gif|svg|woff2?)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

No port allocated for static apps.

### NGINX config — proxy (`next`, `node`, `custom` with `start_cmd`)

```nginx
location / {
    proxy_pass http://localhost:PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}
```

### NGINX reload safety

Always: `nginx -t && nginx -s reload`

---

## Backend Changes

- Add 6 new fields to `App` struct (`models.go`)
- DB migration: `ALTER TABLE apps ADD COLUMN` for each field
- App creation handler: run detection before calling deploy script, store resolved `app_type` + `root_dir`
- Deploy handler: pass all new fields as env vars to scripts
- Port allocation: skip for `static`/`vite` and `custom` without `start_cmd`
- Actions panel: filter Start/Stop/Restart for `static`/`vite` apps (no process)
- New action: `re-detect` — reruns detection and updates stored type

---

## Frontend Changes (`Apps.tsx`)

### Deploy modal additions

| Field | When shown | Notes |
|---|---|---|
| App Type dropdown | Always | `Auto-detect` / `Next.js` / `Vite` / `Node.js` / `Static` / `Custom`; default = Auto-detect |
| root_dir text input | Always | Default `/`; helper: *"Subdirectory containing your app (e.g. /web)"* |
| output_dir text input | `vite`, `static`, `custom` | Pre-filled `dist`; hint for vite: *"Must match Vite build.outDir"* |
| build_cmd / start_cmd | `custom`; "Advanced" expander for all | — |
| install_cmd | "Advanced" expander | Placeholder: `npm install` |

**Auto-detect helper text:** *"Detected on first deploy and saved. Can be changed later."*

### root_dir validation (client-side)
- Normalize: always starts with `/`, no trailing `/`
- Block obviously invalid paths (empty, contains `..`)

### App card
- Show type badge after successful deploy: e.g. `vite · /web`
- Hide Start/Stop/Restart actions for static/vite apps

---

## Out of Scope (future work)

- `BASE_PATH` support for subpath deployments (e.g. `/app`)
- Multi-app monorepo (deploy multiple apps from one repo)
- Non-Node runtimes (Python, Ruby, Go serving)
