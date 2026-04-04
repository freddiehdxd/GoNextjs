# Multi App Type Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support Vite, Static, Node.js, and Custom app types alongside Next.js, with auto-detection and NGINX static serving for non-process apps.

**Architecture:** Six new fields are added to the `apps` table (`app_type`, `build_cmd`, `start_cmd`, `root_dir`, `output_dir`, `install_cmd`). A new `deploy_app.sh` replaces `deploy_next_app.sh` and handles all types. Both deploy scripts write a `.panel_meta` JSON file after detection; the backend reads it and persists the resolved type to the DB. The domains/SSL handlers choose between proxy and static NGINX config based on the stored `app_type`.

**Tech Stack:** Go 1.21, PostgreSQL, Bash, React/TypeScript, Vite, NGINX, PM2

---

## File Map

| File | Change |
|---|---|
| `backend/internal/models/models.go` | Add 6 fields to `App` struct |
| `backend/internal/services/db.go` | Add migration 5 |
| `backend/internal/services/detect.go` | New — Go-based app type detection |
| `backend/internal/services/executor.go` | Add `RunScriptEnv`, update `allowedScripts` |
| `backend/internal/services/nginx.go` | Add `BuildStaticConfig`, `WriteStaticConfig` |
| `backend/internal/handlers/apps.go` | Update SQL queries, `Create`/`Action` handlers |
| `backend/internal/handlers/domains.go` | Pass `appsDir`, choose NGINX config by type |
| `backend/internal/handlers/ssl.go` | Same as domains |
| `backend/main.go` | Pass `cfg.AppsDir` to domains/SSL handlers |
| `scripts/deploy_app.sh` | New — universal deploy script |
| `scripts/setup_app.sh` | Update for multi-type support |
| `frontend/src/lib/api.ts` | Add 6 fields to `App` interface |
| `frontend/src/pages/Apps.tsx` | Deploy modal, app card badge, action filtering |

---

## Task 1: Add model fields and DB migration

**Files:**
- Modify: `backend/internal/models/models.go:14-32`
- Modify: `backend/internal/services/db.go:55-207`

- [ ] **Step 1: Add 6 fields to App struct**

In `backend/internal/models/models.go`, find the `App` struct and add after `MaxRestarts`:

```go
// App represents a deployed application
type App struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	RepoURL       string            `json:"repo_url"`
	Branch        string            `json:"branch"`
	Port          int               `json:"port"`
	Domains       []Domain          `json:"domains"`
	EnvVars       map[string]string `json:"env_vars"`
	WebhookSecret string            `json:"webhook_secret,omitempty"`
	MaxMemory     int               `json:"max_memory"`
	MaxRestarts   int               `json:"max_restarts"`
	AppType       string            `json:"app_type"`
	BuildCmd      string            `json:"build_cmd"`
	StartCmd      string            `json:"start_cmd"`
	RootDir       string            `json:"root_dir"`
	OutputDir     string            `json:"output_dir"`
	InstallCmd    string            `json:"install_cmd"`
	CreatedAt     time.Time         `json:"created_at"`
	UpdatedAt     time.Time         `json:"updated_at"`
	// Enriched fields from PM2 (not stored in DB)
	Status string  `json:"status,omitempty"`
	CPU    float64 `json:"cpu,omitempty"`
	Memory int64   `json:"memory,omitempty"`
}
```

- [ ] **Step 2: Add migration 5**

In `backend/internal/services/db.go`, append to the `migrations` slice after migration 4 (after the closing `},` of the cron_jobs migration):

```go
{
    version:     5,
    description: "Add app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd to apps",
    sql: `
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS app_type    TEXT NOT NULL DEFAULT 'next';
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS build_cmd   TEXT NOT NULL DEFAULT '';
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS start_cmd   TEXT NOT NULL DEFAULT '';
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS root_dir    TEXT NOT NULL DEFAULT '/';
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS output_dir  TEXT NOT NULL DEFAULT 'dist';
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS install_cmd TEXT NOT NULL DEFAULT '';
    `,
},
```

- [ ] **Step 3: Commit**

```bash
git add backend/internal/models/models.go backend/internal/services/db.go
git commit -m "feat(apps): add app_type, root_dir, output_dir and cmd fields to model and DB"
```

---

## Task 2: Create detect.go service

**Files:**
- Create: `backend/internal/services/detect.go`

- [ ] **Step 1: Create detect.go**

```go
package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PanelMeta is written by deploy scripts and read by the backend to persist detection results.
type PanelMeta struct {
	AppType string `json:"app_type"`
	RootDir string `json:"root_dir"`
}

// ReadPanelMeta reads .panel_meta from the app directory.
// Returns a zero-value PanelMeta and no error if the file doesn't exist.
func ReadPanelMeta(appDir string) (PanelMeta, error) {
	data, err := os.ReadFile(filepath.Join(appDir, ".panel_meta"))
	if os.IsNotExist(err) {
		return PanelMeta{}, nil
	}
	if err != nil {
		return PanelMeta{}, err
	}
	var m PanelMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return PanelMeta{}, err
	}
	return m, nil
}

// DetectAppType scans dir for the app type and effective root directory.
// rootDirHint: if non-empty and not "/", skip scanning and detect only from that subdir.
func DetectAppType(repoDir, rootDirHint string) (PanelMeta, error) {
	if rootDirHint != "" && rootDirHint != "/" {
		workDir := filepath.Join(repoDir, filepath.FromSlash(strings.TrimPrefix(rootDirHint, "/")))
		t, ok := detectFromDir(workDir)
		if !ok {
			return PanelMeta{}, fmt.Errorf("no package.json or config files found in %s", rootDirHint)
		}
		return PanelMeta{AppType: t, RootDir: rootDirHint}, nil
	}

	// Try repo root first
	if t, ok := detectFromDir(repoDir); ok {
		return PanelMeta{AppType: t, RootDir: "/"}, nil
	}

	// Scan up to depth 2, excluding noise dirs
	excluded := map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, ".next": true}
	type candidate struct {
		relPath string
		score   int
		appType string
	}
	var candidates []candidate

	entries1, _ := os.ReadDir(repoDir)
	for _, e1 := range entries1 {
		if !e1.IsDir() || (e1.Type()&os.ModeSymlink != 0) || excluded[e1.Name()] {
			continue
		}
		dir1 := filepath.Join(repoDir, e1.Name())
		if t, ok := detectFromDir(dir1); ok {
			candidates = append(candidates, candidate{
				relPath: "/" + e1.Name(),
				score:   scoreDir(e1.Name(), dir1),
				appType: t,
			})
		}
		// Depth 2
		entries2, _ := os.ReadDir(dir1)
		for _, e2 := range entries2 {
			if !e2.IsDir() || (e2.Type()&os.ModeSymlink != 0) || excluded[e2.Name()] {
				continue
			}
			dir2 := filepath.Join(dir1, e2.Name())
			if t, ok := detectFromDir(dir2); ok {
				candidates = append(candidates, candidate{
					relPath: "/" + e1.Name() + "/" + e2.Name(),
					score:   scoreDir(e2.Name(), dir2),
					appType: t,
				})
			}
		}
	}

	if len(candidates) == 0 {
		// Check for Go project
		if _, err := os.Stat(filepath.Join(repoDir, "go.mod")); err == nil {
			return PanelMeta{AppType: "custom", RootDir: "/"}, nil
		}
		return PanelMeta{AppType: "static", RootDir: "/"}, nil
	}

	if len(candidates) == 1 {
		return PanelMeta{AppType: candidates[0].appType, RootDir: candidates[0].relPath}, nil
	}

	// Find best candidate
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.score > best.score {
			best = c
		}
	}
	// Check for clear winner (gap >= 2 vs all others)
	for _, c := range candidates {
		if c.relPath != best.relPath && best.score-c.score < 2 {
			paths := make([]string, len(candidates))
			for i, cc := range candidates {
				paths[i] = fmt.Sprintf("%s (score %d)", cc.relPath, cc.score)
			}
			return PanelMeta{}, fmt.Errorf(
				"Multiple app candidates found: %s — set root_dir to specify which app to deploy",
				strings.Join(paths, ", "),
			)
		}
	}
	return PanelMeta{AppType: best.appType, RootDir: best.relPath}, nil
}

// detectFromDir returns (appType, true) if dir looks like a JS/TS app, ("", false) otherwise.
func detectFromDir(dir string) (string, bool) {
	// Config file detection — highest priority
	for _, f := range []string{"next.config.js", "next.config.ts", "next.config.mjs"} {
		if fileExists(filepath.Join(dir, f)) {
			return "next", true
		}
	}
	for _, f := range []string{"vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"} {
		if fileExists(filepath.Join(dir, f)) {
			return "vite", true
		}
	}

	pkgPath := filepath.Join(dir, "package.json")
	if !fileExists(pkgPath) {
		return "", false
	}

	data, err := os.ReadFile(pkgPath)
	if err != nil {
		return "node", true // has package.json but can't read — assume node
	}

	var pkg struct {
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
		Scripts         struct {
			Start string `json:"start"`
			Build string `json:"build"`
		} `json:"scripts"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return "node", true
	}

	allDeps := make(map[string]string)
	for k, v := range pkg.Dependencies {
		allDeps[k] = v
	}
	for k, v := range pkg.DevDependencies {
		allDeps[k] = v
	}

	if _, ok := allDeps["next"]; ok {
		return "next", true
	}
	if _, ok := allDeps["vite"]; ok {
		return "vite", true
	}

	// Build script signals
	if strings.Contains(pkg.Scripts.Build, "next build") {
		return "next", true
	}
	if strings.Contains(pkg.Scripts.Build, "vite build") {
		return "vite", true
	}

	// Node: has a start script that isn't a frontend server
	if pkg.Scripts.Start != "" &&
		!strings.Contains(pkg.Scripts.Start, "vite preview") &&
		!strings.Contains(pkg.Scripts.Start, "next start") {
		return "node", true
	}

	for _, backend := range []string{"express", "fastify", "koa", "hapi"} {
		if _, ok := allDeps[backend]; ok {
			return "node", true
		}
	}

	return "custom", true
}

// scoreDir scores a candidate directory for frontend relevance.
func scoreDir(name, dir string) int {
	score := 0
	for _, n := range []string{"web", "frontend", "app", "client", "ui"} {
		if strings.EqualFold(name, n) {
			score += 2
			break
		}
	}
	for _, n := range []string{"api", "server", "backend"} {
		if strings.EqualFold(name, n) {
			score -= 3
			break
		}
	}
	// Has build script
	pkgPath := filepath.Join(dir, "package.json")
	if data, err := os.ReadFile(pkgPath); err == nil {
		var pkg struct {
			Scripts map[string]string `json:"scripts"`
		}
		if json.Unmarshal(data, &pkg) == nil && pkg.Scripts["build"] != "" {
			score++
		}
	}
	return score
}

// fileExists returns true if path exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// IsStaticType returns true for app types that are served as static files (no PM2 process).
func IsStaticType(appType, startCmd string) bool {
	if appType == "static" || appType == "vite" {
		return true
	}
	if appType == "custom" && startCmd == "" {
		return true
	}
	return false
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/internal/services/detect.go
git commit -m "feat(apps): add Go app type detection service"
```

---

## Task 3: Update executor — add RunScriptEnv and register deploy_app.sh

**Files:**
- Modify: `backend/internal/services/executor.go:24-31` (allowedScripts)
- Modify: `backend/internal/services/executor.go:70-84` (RunScript timeout)
- Modify: `backend/internal/services/executor.go` (add RunScriptEnv)

- [ ] **Step 1: Update allowedScripts and timeout condition**

Replace the `allowedScripts` map and the timeout logic in `RunScript`:

```go
// Allowed shell scripts
var allowedScripts = map[string]bool{
	"install_nginx.sh":    true,
	"install_postgres.sh": true,
	"install_redis.sh":    true,
	"deploy_next_app.sh":  true,
	"deploy_app.sh":       true,
	"setup_app.sh":        true,
	"create_ssl.sh":       true,
}
```

In `RunScript`, update the timeout condition:

```go
timeout := defaultTimeout
if script == "deploy_next_app.sh" || script == "deploy_app.sh" || script == "setup_app.sh" {
    timeout = deployTimeout
}
```

- [ ] **Step 2: Add RunScriptEnv method**

Add this method after `RunScript`:

```go
// RunScriptEnv runs an allowed shell script with extra environment variables and arguments.
// extraEnv keys must not contain spaces or shell metacharacters.
func (e *Executor) RunScriptEnv(script string, extraEnv map[string]string, args ...string) (*models.ExecResult, error) {
	if !allowedScripts[script] {
		return nil, fmt.Errorf("script not allowed: %s", script)
	}

	scriptPath := e.scriptsDir + "/" + script
	allArgs := append([]string{scriptPath}, args...)

	timeout := defaultTimeout
	if script == "deploy_next_app.sh" || script == "deploy_app.sh" || script == "setup_app.sh" {
		timeout = deployTimeout
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "/bin/bash", allArgs...)

	// Base environment
	env := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"APPS_DIR=" + e.appsDir,
	}
	for k, v := range extraEnv {
		env = append(env, k+"="+v)
	}
	cmd.Env = env

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, max: maxOutputSize}
	cmd.Stderr = &limitedWriter{buf: &stderr, max: maxOutputSize}

	err := cmd.Run()
	result := &models.ExecResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
		Code:   0,
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			result.Code = timeoutCode
			result.Stderr = result.Stderr + "\n... command timed out"
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			result.Code = exitErr.ExitCode()
		} else {
			result.Code = 1
			result.Stderr = err.Error()
		}
	}
	return result, nil
}
```

- [ ] **Step 3: Commit**

```bash
git add backend/internal/services/executor.go
git commit -m "feat(executor): add RunScriptEnv and register deploy_app.sh"
```

---

## Task 4: Add static NGINX support to nginx.go

**Files:**
- Modify: `backend/internal/services/nginx.go`

- [ ] **Step 1: Add BuildStaticConfig and WriteStaticConfig methods**

Add these methods after the existing `BuildConfig` method (after line 83):

```go
// BuildStaticConfig generates an NGINX server block that serves static files from docRoot.
func (n *Nginx) BuildStaticConfig(domain, docRoot string, ssl bool) string {
	if ssl {
		return fmt.Sprintf(`# Managed by Panel -- do not edit manually
server {
    listen 80;
    server_name %s;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name %s;

    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size 100M;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    root %s;
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
}
`, domain, domain, domain, domain, docRoot)
	}

	return fmt.Sprintf(`# Managed by Panel -- do not edit manually
server {
    listen 80;
    server_name %s;

    client_max_body_size 100M;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    root %s;
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
}
`, domain, docRoot)
}

// WriteStaticConfig writes a static-file NGINX config and creates the symlink.
func (n *Nginx) WriteStaticConfig(domain, docRoot string, ssl bool) error {
	config := n.BuildStaticConfig(domain, docRoot, ssl)

	availPath := filepath.Join(n.availDir, domain)
	enabledPath := filepath.Join(n.enabledDir, domain)

	if err := os.WriteFile(availPath, []byte(config), 0644); err != nil {
		return fmt.Errorf("write nginx static config: %w", err)
	}

	os.Remove(enabledPath)

	if err := os.Symlink(availPath, enabledPath); err != nil {
		return fmt.Errorf("create nginx symlink: %w", err)
	}

	return nil
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/internal/services/nginx.go
git commit -m "feat(nginx): add static file serving config for Vite/static apps"
```

---

## Task 5: Write deploy_app.sh

**Files:**
- Create: `scripts/deploy_app.sh`

- [ ] **Step 1: Create deploy_app.sh**

```bash
#!/usr/bin/env bash
# deploy_app.sh — Clone/pull and deploy any app type (next, vite, static, node, custom)
# Usage: deploy_app.sh <app_name> <repo_url> <branch> <port> [pm2_mode] [max_memory]
# Env vars (all optional): APP_TYPE, ROOT_DIR, OUTPUT_DIR, BUILD_CMD, START_CMD, INSTALL_CMD
set -euo pipefail

APP_NAME="${1:?app_name is required}"
REPO_URL="${2:?repo_url is required}"
BRANCH="${3:-main}"
PORT="${4:?port is required}"
PM2_MODE="${5:-restart}"
MAX_MEMORY="${6:-512}"
APPS_DIR="${APPS_DIR:-/var/www/apps}"

# New fields from env (empty = auto-detect or default)
APP_TYPE="${APP_TYPE:-}"
ROOT_DIR="${ROOT_DIR:-/}"
OUTPUT_DIR="${OUTPUT_DIR:-dist}"
BUILD_CMD="${BUILD_CMD:-}"
START_CMD="${START_CMD:-}"
INSTALL_CMD="${INSTALL_CMD:-}"

# ── Validation ─────────────────────────────────────────────────────────────
if ! [[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "[error] Invalid app name: ${APP_NAME}" >&2; exit 1
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "[error] Invalid port: ${PORT}" >&2; exit 1
fi

if ! [[ "$REPO_URL" =~ ^https?:// ]] && ! [[ "$REPO_URL" =~ ^git@ ]]; then
  echo "[error] Invalid repo URL: must start with https:// or git@" >&2; exit 1
fi

if ! [[ "$BRANCH" =~ ^[a-zA-Z0-9._/-]+$ ]]; then
  echo "[error] Invalid branch name: ${BRANCH}" >&2; exit 1
fi

APP_DIR="${APPS_DIR}/${APP_NAME}"

echo "[panel] Deploying ${APP_NAME} from ${REPO_URL} (${BRANCH}) on port ${PORT}"

# ── Clone or pull ──────────────────────────────────────────────────────────
if [ -d "${APP_DIR}/.git" ]; then
  echo "[panel] Pulling latest changes..."
  ENV_BAK=""
  if [ -f "${APP_DIR}/.env" ]; then
    ENV_BAK="$(mktemp)"
    cp "${APP_DIR}/.env" "${ENV_BAK}"
  fi
  git -C "${APP_DIR}" fetch origin
  git -C "${APP_DIR}" checkout "${BRANCH}"
  git -C "${APP_DIR}" reset --hard "origin/${BRANCH}"
  if [ -n "${ENV_BAK}" ]; then
    cp "${ENV_BAK}" "${APP_DIR}/.env"
    rm -f "${ENV_BAK}"
  fi
else
  echo "[panel] Cloning repository..."
  mkdir -p "${APPS_DIR}"
  ENV_BAK=""
  if [ -f "${APP_DIR}/.env" ]; then
    ENV_BAK="$(mktemp)"
    cp "${APP_DIR}/.env" "${ENV_BAK}"
  fi
  rm -rf "${APP_DIR}"
  git clone --branch "${BRANCH}" --depth 1 -- "${REPO_URL}" "${APP_DIR}"
  if [ -n "${ENV_BAK}" ]; then
    cp "${ENV_BAK}" "${APP_DIR}/.env"
    rm -f "${ENV_BAK}"
  fi
fi

# ── Resolve working directory ──────────────────────────────────────────────
# ROOT_DIR is "/" (use APP_DIR) or "/subpath" (use APP_DIR/subpath)
WORK_DIR="${APP_DIR}${ROOT_DIR%/}"
[ -z "$WORK_DIR" ] && WORK_DIR="$APP_DIR"
cd "${WORK_DIR}"

# ── Auto-detect app type if not provided ──────────────────────────────────
detect_type() {
  for f in next.config.js next.config.ts next.config.mjs; do
    [ -f "$f" ] && echo "next" && return
  done
  for f in vite.config.js vite.config.ts vite.config.mjs vite.config.cjs; do
    [ -f "$f" ] && echo "vite" && return
  done
  if [ ! -f "package.json" ]; then
    [ -f "${APP_DIR}/go.mod" ] && echo "custom" || echo "static"
    return
  fi
  if node -e "const p=require('./package.json');const d={...p.dependencies,...p.devDependencies};process.exit(d.next?0:1)" 2>/dev/null; then
    echo "next"; return
  fi
  if node -e "const p=require('./package.json');const d={...p.dependencies,...p.devDependencies};process.exit(d.vite?0:1)" 2>/dev/null; then
    echo "vite"; return
  fi
  HAS_START=$(node -e "const p=require('./package.json');process.stdout.write(p.scripts&&p.scripts.start?'yes':'no')" 2>/dev/null || echo "no")
  START_VAL=$(node -e "const p=require('./package.json');process.stdout.write((p.scripts&&p.scripts.start)||'')" 2>/dev/null || echo "")
  if [ "$HAS_START" = "yes" ] && \
     [[ "$START_VAL" != *"vite preview"* ]] && \
     [[ "$START_VAL" != *"next start"* ]]; then
    echo "node"; return
  fi
  if node -e "const p=require('./package.json');const d={...p.dependencies,...p.devDependencies};process.exit((d.express||d.fastify||d.koa||d.hapi)?0:1)" 2>/dev/null; then
    echo "node"; return
  fi
  echo "custom"
}

if [ -z "$APP_TYPE" ]; then
  echo "[panel] Auto-detecting app type..."
  APP_TYPE=$(detect_type)
  echo "[panel] Detected app type: ${APP_TYPE}"
fi

# Detect effective ROOT_DIR if still at default
RESOLVED_ROOT="${ROOT_DIR}"

# Write .panel_meta for backend to read
cat > "${APP_DIR}/.panel_meta" <<EOF
{"app_type":"${APP_TYPE}","root_dir":"${RESOLVED_ROOT}"}
EOF

# ── Install dependencies ───────────────────────────────────────────────────
if [ "$APP_TYPE" != "static" ]; then
  if [ -n "$INSTALL_CMD" ]; then
    echo "[panel] Running custom install: ${INSTALL_CMD}"
    eval "$INSTALL_CMD"
  elif [ -f "pnpm-lock.yaml" ]; then
    if ! command -v pnpm &>/dev/null; then
      echo "[error] pnpm-lock.yaml found but pnpm is not installed. Run: npm install -g pnpm" >&2; exit 1
    fi
    pnpm install
  elif [ -f "yarn.lock" ]; then
    if ! command -v yarn &>/dev/null; then
      echo "[error] yarn.lock found but yarn is not installed. Run: npm install -g yarn" >&2; exit 1
    fi
    yarn install
  elif [ -f "package-lock.json" ]; then
    npm ci
  else
    npm install
  fi
fi

# ── Cleanup previous build output ─────────────────────────────────────────
if [ "$APP_TYPE" = "vite" ] || [ "$APP_TYPE" = "static" ] || { [ "$APP_TYPE" = "custom" ] && [ -z "$START_CMD" ]; }; then
  FULL_OUTPUT="${WORK_DIR}/${OUTPUT_DIR}"
  if [ -n "$OUTPUT_DIR" ] && [ "$OUTPUT_DIR" != "/" ] && [ -d "$FULL_OUTPUT" ]; then
    find "$FULL_OUTPUT" -mindepth 1 -delete 2>/dev/null || true
  fi
fi

# ── Build ──────────────────────────────────────────────────────────────────
run_build() {
  if [ -n "$BUILD_CMD" ]; then
    echo "[panel] Running custom build: ${BUILD_CMD}"
    NODE_ENV=production eval "$BUILD_CMD"
  elif [ "$APP_TYPE" = "static" ]; then
    echo "[panel] Static app — no build step."
    return
  else
    HAS_BUILD=$(node -e "const p=require('./package.json');process.stdout.write(p.scripts&&p.scripts.build?'yes':'no')" 2>/dev/null || echo "no")
    if [ "$HAS_BUILD" = "yes" ]; then
      echo "[panel] Building..."
      NODE_ENV=production npm run build
    elif [ "$APP_TYPE" = "custom" ]; then
      echo "[error] custom app has no build script and BUILD_CMD is not set" >&2; exit 1
    else
      echo "[panel] No build script found — skipping build."
    fi
  fi
}
run_build

# ── Post-build validation for static types ────────────────────────────────
IS_STATIC=false
if [ "$APP_TYPE" = "vite" ] || [ "$APP_TYPE" = "static" ]; then
  IS_STATIC=true
fi
if [ "$APP_TYPE" = "custom" ] && [ -z "$START_CMD" ]; then
  IS_STATIC=true
fi

if [ "$IS_STATIC" = "true" ]; then
  INDEX_PATH="${WORK_DIR}/${OUTPUT_DIR}/index.html"
  if [ ! -f "$INDEX_PATH" ]; then
    echo "[error] No index.html found in ${OUTPUT_DIR} — not a valid static app" >&2; exit 1
  fi
  echo "[panel] Static app verified at ${WORK_DIR}/${OUTPUT_DIR}"
  # Reload NGINX to pick up any freshly linked config
  nginx -t && nginx -s reload 2>/dev/null || true
  echo "[panel] ${APP_NAME} deployed as static app."
  exit 0
fi

# ── Process app: ensure scripts exist ─────────────────────────────────────
HAS_START=$(node -e "const p=require('./package.json');process.stdout.write(p.scripts&&p.scripts.start?'yes':'no')" 2>/dev/null || echo "no")

if [ -n "$START_CMD" ]; then
  echo "[panel] Using custom start command: ${START_CMD}"
elif [ "$HAS_START" = "no" ]; then
  if [ "$APP_TYPE" = "next" ]; then
    echo "[panel] Adding 'next start' script..."
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.start = 'next start -p \${PORT:-${PORT}}';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
    "
  else
    echo "[panel] No start script — adding default 'node index.js'..."
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.start = 'node index.js';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
    "
  fi
fi

# ── Log directory ──────────────────────────────────────────────────────────
mkdir -p /var/log/panel

# ── PM2 ecosystem file ─────────────────────────────────────────────────────
ENV_BLOCK="      NODE_ENV: 'production',
      PORT:     '${PORT}',"

if [ -f "${APP_DIR}/.env" ]; then
  EXTRA_ENV=$(node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('${APP_DIR}/.env', 'utf8').split('\n');
    lines.forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 0) return;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('\"') && val.endsWith('\"')) || (val.startsWith(\"'\") && val.endsWith(\"'\"))) {
        val = val.slice(1, -1);
      }
      if (key === 'NODE_ENV' || key === 'PORT') return;
      val = val.replace(/'/g, \"\\\\\\'\" );
      console.log(\"      '\" + key + \"': '\" + val + \"',\");
    });
  " 2>/dev/null)
  if [ -n "$EXTRA_ENV" ]; then
    ENV_BLOCK="${ENV_BLOCK}
${EXTRA_ENV}"
  fi
fi

PM2_SCRIPT="npm"
PM2_ARGS="start"
if [ -n "$START_CMD" ]; then
  PM2_SCRIPT="bash"
  PM2_ARGS="-c ${START_CMD}"
fi

cat > "${APP_DIR}/ecosystem.config.js" <<EOF
module.exports = {
  apps: [{
    name:    '${APP_NAME}',
    cwd:     '${WORK_DIR}',
    script:  '${PM2_SCRIPT}',
    args:    '${PM2_ARGS}',
    env: {
${ENV_BLOCK}
    },
    max_memory_restart: '${MAX_MEMORY}M',
    error_file:  '/var/log/panel/pm2-${APP_NAME}-error.log',
    out_file:    '/var/log/panel/pm2-${APP_NAME}-out.log',
    merge_logs:  true,
    autorestart: true,
    watch:       false,
  }],
};
EOF

# ── Start or reload/restart with PM2 ───────────────────────────────────────
if pm2 describe "${APP_NAME}" &>/dev/null; then
  if [ "$PM2_MODE" = "reload" ]; then
    echo "[panel] Zero-downtime reload..."
    pm2 reload "${APP_NAME}" --update-env
  else
    echo "[panel] Restarting PM2 process..."
    pm2 restart "${APP_NAME}" --update-env
  fi
else
  echo "[panel] Starting new PM2 process..."
  pm2 start "${APP_DIR}/ecosystem.config.js"
fi

pm2 save
echo "[panel] ${APP_NAME} deployed and running on port ${PORT}."
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/deploy_app.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy_app.sh
git commit -m "feat(scripts): add deploy_app.sh supporting next/vite/static/node/custom types"
```

---

## Task 6: Update setup_app.sh for multi-type support

**Files:**
- Modify: `scripts/setup_app.sh`

- [ ] **Step 1: Replace setup_app.sh**

Replace the file completely:

```bash
#!/usr/bin/env bash
# setup_app.sh — Install, build, and start a manually-uploaded app
# Usage: setup_app.sh <app_name> <port> [pm2_mode] [max_memory]
# Env vars: APP_TYPE, ROOT_DIR, OUTPUT_DIR, BUILD_CMD, START_CMD, INSTALL_CMD
set -euo pipefail

APP_NAME="${1:?app_name is required}"
PORT="${2:?port is required}"
PM2_MODE="${3:-restart}"
MAX_MEMORY="${4:-512}"
APPS_DIR="${APPS_DIR:-/var/www/apps}"

APP_TYPE="${APP_TYPE:-}"
ROOT_DIR="${ROOT_DIR:-/}"
OUTPUT_DIR="${OUTPUT_DIR:-dist}"
BUILD_CMD="${BUILD_CMD:-}"
START_CMD="${START_CMD:-}"
INSTALL_CMD="${INSTALL_CMD:-}"

# ── Validation ─────────────────────────────────────────────────────────────
if ! [[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "[error] Invalid app name: ${APP_NAME}" >&2; exit 1
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "[error] Invalid port: ${PORT}" >&2; exit 1
fi

APP_DIR="${APPS_DIR}/${APP_NAME}"
if [ ! -d "${APP_DIR}" ]; then
  echo "[error] App directory not found: ${APP_DIR}" >&2; exit 1
fi

# ── Resolve working directory ──────────────────────────────────────────────
WORK_DIR="${APP_DIR}${ROOT_DIR%/}"
[ -z "$WORK_DIR" ] && WORK_DIR="$APP_DIR"

# Handle nested zip: if WORK_DIR doesn't exist but there's one subdir with package.json, move it
if [ ! -d "$WORK_DIR" ] || { [ "$ROOT_DIR" = "/" ] && [ ! -f "${WORK_DIR}/package.json" ]; }; then
  cd "${APP_DIR}"
  SUBDIRS_WITH_PKG=()
  for d in */; do
    [ -f "${d}package.json" ] && SUBDIRS_WITH_PKG+=("$d")
  done
  if [ "${#SUBDIRS_WITH_PKG[@]}" -eq 1 ]; then
    SUBDIR="${SUBDIRS_WITH_PKG[0]}"
    echo "[setup] Moving contents of ${SUBDIR} to app root..."
    shopt -s dotglob
    mv "${SUBDIR}"* . 2>/dev/null || true
    shopt -u dotglob
    rmdir "${SUBDIR}" 2>/dev/null || true
  elif [ "${#SUBDIRS_WITH_PKG[@]}" -gt 1 ]; then
    echo "[error] Multiple package.json found — set root_dir to specify which to deploy" >&2; exit 1
  fi
  WORK_DIR="${APP_DIR}"
fi

cd "${WORK_DIR}"

# ── Write .panel_meta ──────────────────────────────────────────────────────
# APP_TYPE is already resolved by the backend before calling this script
RESOLVED_TYPE="${APP_TYPE:-node}"
cat > "${APP_DIR}/.panel_meta" <<EOF
{"app_type":"${RESOLVED_TYPE}","root_dir":"${ROOT_DIR}"}
EOF

echo "[setup] Setting up ${APP_NAME} (type: ${RESOLVED_TYPE}) on port ${PORT}"

# ── Install dependencies ───────────────────────────────────────────────────
if [ "$RESOLVED_TYPE" != "static" ]; then
  if [ -n "$INSTALL_CMD" ]; then
    echo "[setup] Running custom install: ${INSTALL_CMD}"
    eval "$INSTALL_CMD"
  elif [ -f "pnpm-lock.yaml" ]; then
    command -v pnpm &>/dev/null || { echo "[error] pnpm not installed" >&2; exit 1; }
    pnpm install
  elif [ -f "yarn.lock" ]; then
    command -v yarn &>/dev/null || { echo "[error] yarn not installed" >&2; exit 1; }
    yarn install
  elif [ -f "package-lock.json" ]; then
    npm ci --production=false
  else
    npm install
  fi
fi

# ── Cleanup previous build output ─────────────────────────────────────────
IS_STATIC=false
[ "$RESOLVED_TYPE" = "vite" ] || [ "$RESOLVED_TYPE" = "static" ] && IS_STATIC=true
[ "$RESOLVED_TYPE" = "custom" ] && [ -z "$START_CMD" ] && IS_STATIC=true

if [ "$IS_STATIC" = "true" ]; then
  FULL_OUTPUT="${WORK_DIR}/${OUTPUT_DIR}"
  if [ -n "$OUTPUT_DIR" ] && [ "$OUTPUT_DIR" != "/" ] && [ -d "$FULL_OUTPUT" ]; then
    find "$FULL_OUTPUT" -mindepth 1 -delete 2>/dev/null || true
  fi
fi

# ── Build ──────────────────────────────────────────────────────────────────
if [ -n "$BUILD_CMD" ]; then
  echo "[setup] Running custom build: ${BUILD_CMD}"
  NODE_ENV=production eval "$BUILD_CMD"
elif [ "$RESOLVED_TYPE" = "static" ]; then
  echo "[setup] Static app — no build step."
else
  HAS_BUILD=$(node -e "const p=require('./package.json');process.stdout.write(p.scripts&&p.scripts.build?'yes':'no')" 2>/dev/null || echo "no")
  if [ "$HAS_BUILD" = "yes" ]; then
    echo "[setup] Building..."
    NODE_ENV=production npm run build
  elif [ "$RESOLVED_TYPE" = "custom" ]; then
    echo "[error] custom app has no build script and BUILD_CMD is not set" >&2; exit 1
  else
    echo "[setup] No build script — skipping."
  fi
fi

# ── Post-build validation for static types ────────────────────────────────
if [ "$IS_STATIC" = "true" ]; then
  INDEX_PATH="${WORK_DIR}/${OUTPUT_DIR}/index.html"
  if [ ! -f "$INDEX_PATH" ]; then
    echo "[error] No index.html found in ${OUTPUT_DIR} — not a valid static app" >&2; exit 1
  fi
  echo "[setup] Static app verified."
  nginx -t && nginx -s reload 2>/dev/null || true
  echo "[setup] ${APP_NAME} deployed as static app."
  exit 0
fi

# ── Ensure start script ────────────────────────────────────────────────────
HAS_START=$(node -e "const p=require('./package.json');process.stdout.write(p.scripts&&p.scripts.start?'yes':'no')" 2>/dev/null || echo "no")
if [ -z "$START_CMD" ] && [ "$HAS_START" = "no" ]; then
  if [ "$RESOLVED_TYPE" = "next" ]; then
    node -e "
      const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
      pkg.scripts=pkg.scripts||{};pkg.scripts.start='next start -p \${PORT:-${PORT}}';
      fs.writeFileSync('package.json',JSON.stringify(pkg,null,2));
    "
  else
    node -e "
      const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
      pkg.scripts=pkg.scripts||{};pkg.scripts.start='node index.js';
      fs.writeFileSync('package.json',JSON.stringify(pkg,null,2));
    "
  fi
fi

# ── Log directory ──────────────────────────────────────────────────────────
mkdir -p /var/log/panel

# ── PM2 ecosystem file ─────────────────────────────────────────────────────
ENV_BLOCK="      NODE_ENV: 'production',
      PORT:     '${PORT}',"

if [ -f "${APP_DIR}/.env" ]; then
  EXTRA_ENV=$(node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('${APP_DIR}/.env', 'utf8').split('\n');
    lines.forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 0) return;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('\"') && val.endsWith('\"')) || (val.startsWith(\"'\") && val.endsWith(\"'\"))) {
        val = val.slice(1, -1);
      }
      if (key === 'NODE_ENV' || key === 'PORT') return;
      val = val.replace(/'/g, \"\\\\\\'\" );
      console.log(\"      '\" + key + \"': '\" + val + \"',\");
    });
  " 2>/dev/null)
  [ -n "$EXTRA_ENV" ] && ENV_BLOCK="${ENV_BLOCK}
${EXTRA_ENV}"
fi

PM2_SCRIPT="npm"
PM2_ARGS="start"
if [ -n "$START_CMD" ]; then
  PM2_SCRIPT="bash"
  PM2_ARGS="-c ${START_CMD}"
fi

cat > "${APP_DIR}/ecosystem.config.js" <<EOF
module.exports = {
  apps: [{
    name:    '${APP_NAME}',
    cwd:     '${WORK_DIR}',
    script:  '${PM2_SCRIPT}',
    args:    '${PM2_ARGS}',
    env: {
${ENV_BLOCK}
    },
    max_memory_restart: '${MAX_MEMORY}M',
    error_file:  '/var/log/panel/pm2-${APP_NAME}-error.log',
    out_file:    '/var/log/panel/pm2-${APP_NAME}-out.log',
    merge_logs:  true,
    autorestart: true,
    watch:       false,
  }],
};
EOF

if pm2 describe "${APP_NAME}" &>/dev/null; then
  if [ "$PM2_MODE" = "reload" ]; then
    pm2 reload "${APP_NAME}" --update-env
  else
    pm2 restart "${APP_NAME}" --update-env
  fi
else
  pm2 start "${APP_DIR}/ecosystem.config.js"
fi

pm2 save 2>/dev/null || true
echo "[setup] ${APP_NAME} is now running on port ${PORT}."
```

- [ ] **Step 2: Commit**

```bash
git add scripts/setup_app.sh
git commit -m "feat(scripts): update setup_app.sh for multi app type support"
```

---

## Task 7: Update backend handlers — SQL queries and helper

**Files:**
- Modify: `backend/internal/handlers/apps.go`

All SQL queries that SELECT or RETURNING from apps need the 6 new columns. There are 4 places:

1. `List` handler — `SELECT ... FROM apps`
2. `getAppByName` — `SELECT ... FROM apps WHERE name = $1`
3. `Create` handler — `INSERT INTO apps ... RETURNING`
4. `UpdateEnv` handler — `UPDATE apps ... RETURNING`

- [ ] **Step 1: Update List query (line 51)**

Replace the `SELECT` in `List` at line 50-52:

```go
rows, err := h.db.Query(ctx,
    "SELECT id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd, created_at, updated_at FROM apps ORDER BY created_at DESC")
```

And update the `rows.Scan` call at line 62-63:

```go
if err := rows.Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
    &envJSON, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts,
    &app.AppType, &app.BuildCmd, &app.StartCmd, &app.RootDir, &app.OutputDir, &app.InstallCmd,
    &app.CreatedAt, &app.UpdatedAt); err != nil {
```

- [ ] **Step 2: Update getAppByName query (line 610-614)**

Replace the SELECT and Scan in `getAppByName`:

```go
err := h.db.QueryRow(ctx,
    "SELECT id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd, created_at, updated_at FROM apps WHERE name = $1",
    name,
).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
    &envJSON, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts,
    &app.AppType, &app.BuildCmd, &app.StartCmd, &app.RootDir, &app.OutputDir, &app.InstallCmd,
    &app.CreatedAt, &app.UpdatedAt)
```

- [ ] **Step 3: Update UpdateEnv RETURNING query (line 464-469)**

Replace the UPDATE...RETURNING and its Scan in `UpdateEnv`:

```go
err = h.db.QueryRow(ctx,
    `UPDATE apps SET env_vars = $1, updated_at = NOW() WHERE name = $2
     RETURNING id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd, created_at, updated_at`,
    envJSON, name,
).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
    &envBytes, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts,
    &app.AppType, &app.BuildCmd, &app.StartCmd, &app.RootDir, &app.OutputDir, &app.InstallCmd,
    &app.CreatedAt, &app.UpdatedAt)
```

- [ ] **Step 4: Add appEnvFromApp helper**

Add this helper function near the bottom of `apps.go` (before `sanitizeDeployError`):

```go
// appEnvFromApp returns env vars to pass to deploy scripts for a given app.
func appEnvFromApp(app *models.App) map[string]string {
	return map[string]string{
		"APP_TYPE":    app.AppType,
		"ROOT_DIR":    app.RootDir,
		"OUTPUT_DIR":  app.OutputDir,
		"BUILD_CMD":   app.BuildCmd,
		"START_CMD":   app.StartCmd,
		"INSTALL_CMD": app.InstallCmd,
	}
}

// readPanelMeta reads the .panel_meta file written by deploy scripts.
func readPanelMeta(appDir string) (services.PanelMeta, error) {
	return services.ReadPanelMeta(appDir)
}
```

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handlers/apps.go
git commit -m "feat(apps): update SQL queries to include new app type fields"
```

---

## Task 8: Update Create and Action handlers

**Files:**
- Modify: `backend/internal/handlers/apps.go`

- [ ] **Step 1: Update Create handler body struct and deploy call**

Replace the `Create` handler (lines 144-250) body struct, deploy call, and INSERT:

```go
// Create handles POST /api/apps
func (h *AppsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string            `json:"name"`
		RepoURL    string            `json:"repo_url"`
		Branch     string            `json:"branch"`
		EnvVars    map[string]string `json:"env_vars"`
		AppType    string            `json:"app_type"`    // "" or "auto" = detect; otherwise use as-is
		RootDir    string            `json:"root_dir"`
		OutputDir  string            `json:"output_dir"`
		BuildCmd   string            `json:"build_cmd"`
		StartCmd   string            `json:"start_cmd"`
		InstallCmd string            `json:"install_cmd"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if body.Name == "" {
		Error(w, http.StatusBadRequest, "App name is required")
		return
	}
	if !services.ValidateAppName(body.Name) {
		Error(w, http.StatusBadRequest, "Invalid app name. Use lowercase letters, numbers and hyphens only.")
		return
	}
	if body.RepoURL != "" && !repoURLPattern.MatchString(body.RepoURL) {
		Error(w, http.StatusBadRequest, "Invalid repository URL. Must start with https:// or git@")
		return
	}
	if body.Branch == "" {
		body.Branch = "main"
	}
	if !branchPattern.MatchString(body.Branch) {
		Error(w, http.StatusBadRequest, "Invalid branch name.")
		return
	}
	if body.EnvVars == nil {
		body.EnvVars = make(map[string]string)
	}

	// Normalize fields
	if body.AppType == "auto" {
		body.AppType = "" // empty = auto-detect in script
	}
	if body.RootDir == "" {
		body.RootDir = "/"
	}
	if body.OutputDir == "" {
		body.OutputDir = "dist"
	}

	// Validate root_dir: must start with /, no ".."
	if !strings.HasPrefix(body.RootDir, "/") || strings.Contains(body.RootDir, "..") {
		Error(w, http.StatusBadRequest, "root_dir must start with / and must not contain ..")
		return
	}

	ctx := r.Context()

	// Check for duplicate
	var exists bool
	err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM apps WHERE name = $1)", body.Name).Scan(&exists)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Database error")
		return
	}
	if exists {
		Error(w, http.StatusConflict, "App name already exists")
		return
	}

	// Allocate port (all app types — port stays allocated for simplicity)
	port, err := h.port.Allocate(ctx)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	appDir := h.cfg.AppsDir + "/" + body.Name
	if err := os.MkdirAll(appDir, 0755); err != nil {
		Error(w, http.StatusInternalServerError, "Failed to create app directory")
		return
	}
	if len(body.EnvVars) > 0 {
		if err := services.WriteEnvFile(h.cfg.AppsDir, body.Name, body.EnvVars); err != nil {
			fmt.Printf("[warn] failed to write .env for %s: %v\n", body.Name, err)
		}
	}

	// Resolved type (may be filled in after deploy)
	resolvedType := body.AppType
	resolvedRoot := body.RootDir

	// Deploy or leave as empty directory
	if body.RepoURL != "" {
		scriptEnv := map[string]string{
			"APP_TYPE":    body.AppType,
			"ROOT_DIR":    body.RootDir,
			"OUTPUT_DIR":  body.OutputDir,
			"BUILD_CMD":   body.BuildCmd,
			"START_CMD":   body.StartCmd,
			"INSTALL_CMD": body.InstallCmd,
		}
		result, err := h.exec.RunScriptEnv("deploy_app.sh", scriptEnv,
			body.Name, body.RepoURL, body.Branch, fmt.Sprintf("%d", port), "restart", "512")
		if err != nil {
			Error(w, http.StatusInternalServerError, "Deploy failed")
			return
		}
		if result.Code != 0 {
			Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
			return
		}
		// Read detected type from .panel_meta (script writes this after detection)
		if meta, err := readPanelMeta(appDir); err == nil && meta.AppType != "" {
			resolvedType = meta.AppType
			resolvedRoot = meta.RootDir
		}
		if resolvedType == "" {
			resolvedType = "next" // safe fallback
		}
	}

	// Insert into database
	envJSON, _ := json.Marshal(body.EnvVars)
	var app models.App
	var envBytes []byte
	err = h.db.QueryRow(ctx,
		`INSERT INTO apps (name, repo_url, branch, port, env_vars, app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		 RETURNING id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd, created_at, updated_at`,
		body.Name, body.RepoURL, body.Branch, port, envJSON,
		resolvedType, body.BuildCmd, body.StartCmd, resolvedRoot, body.OutputDir, body.InstallCmd,
	).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
		&envBytes, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts,
		&app.AppType, &app.BuildCmd, &app.StartCmd, &app.RootDir, &app.OutputDir, &app.InstallCmd,
		&app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to save app")
		return
	}
	json.Unmarshal(envBytes, &app.EnvVars)
	app.Domains = make([]models.Domain, 0)

	SuccessCreated(w, app)
}
```

- [ ] **Step 2: Update Action handler — all RunScript calls and add re-detect/setup**

In the `Action` handler, replace all `RunScript("deploy_next_app.sh", ...)` calls with `RunScriptEnv("deploy_app.sh", appEnvFromApp(app), ...)`, and similarly for `setup_app.sh`. Also add the `re-detect` case and guard static apps against PM2 actions.

Replace the entire `Action` handler switch statement:

```go
switch body.Action {
case "start":
	// Static apps have no process
	if services.IsStaticType(app.AppType, app.StartCmd) {
		Success(w, map[string]string{"message": "Static app — no process to start"})
		return
	}

	pm2List, listErr := h.pm2.List()
	isRegistered := false
	if listErr == nil {
		for _, p := range pm2List {
			if p.Name == app.Name {
				isRegistered = true
				break
			}
		}
	}

	if !isRegistered {
		services.WriteEnvFile(h.cfg.AppsDir, app.Name, app.EnvVars)
		var result *models.ExecResult
		var err error
		if app.RepoURL != "" {
			result, err = h.exec.RunScriptEnv("deploy_app.sh", appEnvFromApp(app),
				app.Name, app.RepoURL, app.Branch, fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
		} else {
			result, err = h.exec.RunScriptEnv("setup_app.sh", appEnvFromApp(app),
				app.Name, fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
		}
		if err != nil {
			Error(w, http.StatusInternalServerError, "Failed to start app")
			return
		}
		if result.Code != 0 {
			Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
			return
		}
		Success(w, map[string]string{"message": "App built and started"})
		return
	}

	result, err := h.pm2.Action("start", app.Name)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to start app")
		return
	}
	Success(w, map[string]string{"message": result.Stdout})

case "stop", "restart", "reload":
	if services.IsStaticType(app.AppType, app.StartCmd) {
		Success(w, map[string]string{"message": "Static app — no process to manage"})
		return
	}
	result, err := h.pm2.Action(body.Action, app.Name)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to "+body.Action+" app")
		return
	}
	Success(w, map[string]string{"message": result.Stdout})

case "delete":
	h.pm2.Action("delete", app.Name)
	for _, d := range app.Domains {
		h.nginx.RemoveConfig(d.Domain)
	}
	if len(app.Domains) > 0 {
		h.nginx.TestAndReload()
	}
	_, err := h.db.Exec(ctx, "DELETE FROM apps WHERE name = $1", app.Name)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to delete app")
		return
	}
	appDir := filepath.Join(h.cfg.AppsDir, app.Name)
	if resolved, err := filepath.Abs(appDir); err == nil && strings.HasPrefix(resolved, filepath.Clean(h.cfg.AppsDir)) {
		os.RemoveAll(resolved)
	}
	Success(w, map[string]string{"message": "App deleted"})

case "rebuild":
	if app.RepoURL == "" {
		Error(w, http.StatusBadRequest, "Cannot rebuild — app has no git repository")
		return
	}
	services.WriteEnvFile(h.cfg.AppsDir, app.Name, app.EnvVars)
	result, err := h.exec.RunScriptEnv("deploy_app.sh", appEnvFromApp(app),
		app.Name, app.RepoURL, app.Branch, fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
	if err != nil {
		Error(w, http.StatusInternalServerError, "Rebuild failed")
		return
	}
	if result.Code != 0 {
		Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
		return
	}
	h.syncPanelMeta(ctx, app)
	Success(w, map[string]string{"message": "Rebuild complete"})

case "setup":
	services.WriteEnvFile(h.cfg.AppsDir, app.Name, app.EnvVars)
	// Run Go detection before calling script (for ZIP/manual apps where APP_TYPE may be empty)
	appDir := filepath.Join(h.cfg.AppsDir, app.Name)
	if app.AppType == "" || app.AppType == "next" {
		if meta, err := services.DetectAppType(appDir, app.RootDir); err == nil && meta.AppType != "" {
			app.AppType = meta.AppType
			app.RootDir = meta.RootDir
			h.db.Exec(ctx, "UPDATE apps SET app_type=$1, root_dir=$2, updated_at=NOW() WHERE name=$3",
				app.AppType, app.RootDir, app.Name)
		}
	}
	result, err := h.exec.RunScriptEnv("setup_app.sh", appEnvFromApp(app),
		app.Name, fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
	if err != nil {
		Error(w, http.StatusInternalServerError, "Setup failed")
		return
	}
	if result.Code != 0 {
		Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
		return
	}
	Success(w, map[string]string{"message": "App deployed on port " + fmt.Sprintf("%d", app.Port)})

case "setup-reload":
	services.WriteEnvFile(h.cfg.AppsDir, app.Name, app.EnvVars)
	appDir := filepath.Join(h.cfg.AppsDir, app.Name)
	if app.AppType == "" || app.AppType == "next" {
		if meta, err := services.DetectAppType(appDir, app.RootDir); err == nil && meta.AppType != "" {
			app.AppType = meta.AppType
			app.RootDir = meta.RootDir
			h.db.Exec(ctx, "UPDATE apps SET app_type=$1, root_dir=$2, updated_at=NOW() WHERE name=$3",
				app.AppType, app.RootDir, app.Name)
		}
	}
	result, err := h.exec.RunScriptEnv("setup_app.sh", appEnvFromApp(app),
		app.Name, fmt.Sprintf("%d", app.Port), "reload", fmt.Sprintf("%d", app.MaxMemory))
	if err != nil {
		Error(w, http.StatusInternalServerError, "Zero-downtime deploy failed")
		return
	}
	if result.Code != 0 {
		Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
		return
	}
	Success(w, map[string]string{"message": "Zero-downtime deploy complete"})

case "rebuild-reload":
	if app.RepoURL == "" {
		Error(w, http.StatusBadRequest, "Cannot rebuild — app has no git repository")
		return
	}
	services.WriteEnvFile(h.cfg.AppsDir, app.Name, app.EnvVars)
	result, err := h.exec.RunScriptEnv("deploy_app.sh", appEnvFromApp(app),
		app.Name, app.RepoURL, app.Branch, fmt.Sprintf("%d", app.Port), "reload", fmt.Sprintf("%d", app.MaxMemory))
	if err != nil {
		Error(w, http.StatusInternalServerError, "Zero-downtime rebuild failed")
		return
	}
	if result.Code != 0 {
		Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
		return
	}
	h.syncPanelMeta(ctx, app)
	Success(w, map[string]string{"message": "Zero-downtime rebuild complete"})

case "re-detect":
	appDir := filepath.Join(h.cfg.AppsDir, app.Name)
	meta, err := services.DetectAppType(appDir, "/")
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	_, err = h.db.Exec(ctx,
		"UPDATE apps SET app_type=$1, root_dir=$2, updated_at=NOW() WHERE name=$3",
		meta.AppType, meta.RootDir, app.Name)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update app type")
		return
	}
	Success(w, map[string]interface{}{
		"message":  "App type re-detected",
		"app_type": meta.AppType,
		"root_dir": meta.RootDir,
	})

default:
	Error(w, http.StatusBadRequest, "Invalid action")
}
```

- [ ] **Step 3: Add syncPanelMeta helper method to AppsHandler**

Add this method after the `getAppByName` method:

```go
// syncPanelMeta reads .panel_meta written by the deploy script and updates the DB if type changed.
func (h *AppsHandler) syncPanelMeta(ctx context.Context, app *models.App) {
	appDir := filepath.Join(h.cfg.AppsDir, app.Name)
	meta, err := services.ReadPanelMeta(appDir)
	if err != nil || meta.AppType == "" {
		return
	}
	if meta.AppType == app.AppType && meta.RootDir == app.RootDir {
		return
	}
	h.db.Exec(ctx, "UPDATE apps SET app_type=$1, root_dir=$2, updated_at=NOW() WHERE name=$3",
		meta.AppType, meta.RootDir, app.Name)
}
```

- [ ] **Step 4: Update Webhook handler**

Replace the two `RunScript` calls in the `Webhook` handler (lines 594-601):

```go
go func() {
	if app.RepoURL != "" {
		h.exec.RunScriptEnv("deploy_app.sh", appEnvFromApp(app),
			app.Name, app.RepoURL, app.Branch, fmt.Sprintf("%d", app.Port), "reload", fmt.Sprintf("%d", app.MaxMemory))
	} else {
		h.exec.RunScriptEnv("setup_app.sh", appEnvFromApp(app),
			app.Name, fmt.Sprintf("%d", app.Port), "reload", fmt.Sprintf("%d", app.MaxMemory))
	}
}()
```

- [ ] **Step 5: Verify the file compiles**

```bash
cd C:/Users/User/Documents/panel/backend && go build ./...
```

Expected: no output (success). If there are errors, fix them before continuing.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handlers/apps.go
git commit -m "feat(apps): update Create/Action handlers for multi app type support"
```

---

## Task 9: Update domains and SSL handlers for static NGINX config

**Files:**
- Modify: `backend/internal/handlers/domains.go`
- Modify: `backend/internal/handlers/ssl.go`
- Modify: `backend/main.go`

- [ ] **Step 1: Update DomainsHandler to accept appsDir**

Replace `DomainsHandler` struct and constructor:

```go
type DomainsHandler struct {
	db      *services.DB
	nginx   *services.Nginx
	appsDir string
}

func NewDomainsHandler(db *services.DB, nginx *services.Nginx, appsDir string) *DomainsHandler {
	return &DomainsHandler{db: db, nginx: nginx, appsDir: appsDir}
}
```

- [ ] **Step 2: Update Add handler to choose NGINX config type**

In `Add`, replace the existing `SELECT id, port FROM apps` query and `WriteConfig` call:

```go
// Get app — include app_type, root_dir, output_dir, start_cmd to pick NGINX template
var appID, appType, rootDir, outputDir, startCmd string
var appPort int
err := h.db.QueryRow(ctx,
    "SELECT id, port, app_type, root_dir, output_dir, start_cmd FROM apps WHERE name = $1",
    body.AppName,
).Scan(&appID, &appPort, &appType, &rootDir, &outputDir, &startCmd)
if err != nil {
    Error(w, http.StatusNotFound, "App not found")
    return
}
```

Then replace the `WriteConfig` call:

```go
// Choose NGINX config based on app type
var nginxErr error
if services.IsStaticType(appType, startCmd) {
    // Compute doc root: APP_DIR + ROOT_DIR + OUTPUT_DIR
    workDir := filepath.Join(h.appsDir, body.AppName)
    if rootDir != "/" && rootDir != "" {
        workDir = filepath.Join(workDir, filepath.FromSlash(strings.TrimPrefix(rootDir, "/")))
    }
    docRoot := filepath.Join(workDir, outputDir)
    nginxErr = h.nginx.WriteStaticConfig(body.Domain, docRoot, false)
} else {
    nginxErr = h.nginx.WriteConfig(body.Domain, appPort, false)
}
if nginxErr != nil {
    log.Printf("Failed to write NGINX config for %s: %v", body.Domain, nginxErr)
    Error(w, http.StatusInternalServerError, "Failed to configure NGINX for domain")
    return
}
```

Add missing imports to `domains.go`:

```go
import (
    "context"
    "log"
    "net/http"
    "path/filepath"
    "strings"
    "time"

    "github.com/go-chi/chi/v5"

    "panel-backend/internal/models"
    "panel-backend/internal/services"
)
```

- [ ] **Step 3: Update SSLHandler to accept appsDir**

Replace `SSLHandler` struct and constructor:

```go
type SSLHandler struct {
	db      *services.DB
	nginx   *services.Nginx
	exec    *services.Executor
	appsDir string
}

func NewSSLHandler(db *services.DB, nginx *services.Nginx, exec *services.Executor, appsDir string) *SSLHandler {
	return &SSLHandler{db: db, nginx: nginx, exec: exec, appsDir: appsDir}
}
```

- [ ] **Step 4: Update SSL Enable/Disable to choose NGINX config type**

In `Enable`, replace the existing SELECT and `WriteConfig` call at lines 50-72:

```go
// Look up domain, app port, and app type
var appID, appType, rootDir, outputDir, startCmd string
var port int
err := h.db.QueryRow(ctx,
    `SELECT a.id, a.port, a.app_type, a.root_dir, a.output_dir, a.start_cmd
     FROM domains d JOIN apps a ON a.id = d.app_id WHERE d.domain = $1`,
    body.Domain,
).Scan(&appID, &port, &appType, &rootDir, &outputDir, &startCmd)
if err != nil {
    Error(w, http.StatusNotFound, "Domain not found")
    return
}
_ = appID
```

Replace the `WriteConfig(body.Domain, port, true)` call in Enable (after certbot):

```go
var writeErr error
if services.IsStaticType(appType, startCmd) {
    workDir := filepath.Join(h.appsDir, body.Domain) // Note: need app name here
    // Get app name from domain for path computation
    var appName string
    h.db.QueryRow(ctx, `SELECT a.name FROM domains d JOIN apps a ON a.id = d.app_id WHERE d.domain = $1`, body.Domain).Scan(&appName)
    workDir = filepath.Join(h.appsDir, appName)
    if rootDir != "/" && rootDir != "" {
        workDir = filepath.Join(workDir, filepath.FromSlash(strings.TrimPrefix(rootDir, "/")))
    }
    docRoot := filepath.Join(workDir, outputDir)
    writeErr = h.nginx.WriteStaticConfig(body.Domain, docRoot, true)
} else {
    writeErr = h.nginx.WriteConfig(body.Domain, port, true)
}
if writeErr != nil {
    Error(w, http.StatusInternalServerError, "Failed to configure NGINX for SSL")
    return
}
```

In `Disable`, replace the SELECT and `WriteConfig(body.Domain, port, false)` similarly (pattern is the same, just `ssl=false`).

Add `"path/filepath"` and `"strings"` to ssl.go imports.

- [ ] **Step 5: Update main.go**

In `main.go` line 53-54, update the constructor calls:

```go
domainsHandler := handlers.NewDomainsHandler(db, nginx, cfg.AppsDir)
sslHandler := handlers.NewSSLHandler(db, nginx, exec, cfg.AppsDir)
```

- [ ] **Step 6: Build to verify**

```bash
cd C:/Users/User/Documents/panel/backend && go build ./...
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/handlers/domains.go backend/internal/handlers/ssl.go backend/main.go
git commit -m "feat(domains/ssl): use static NGINX config for vite/static app types"
```

---

## Task 10: Update frontend — App interface and deploy modal

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/Apps.tsx`

- [ ] **Step 1: Update App interface in api.ts**

Replace the `App` interface:

```typescript
export interface App {
  id: string; name: string; repo_url: string; branch: string;
  port: number; domains: Domain[];
  status: string; cpu: number; memory: number;
  env_vars: Record<string, string>; created_at: string;
  webhook_secret?: string; max_memory: number; max_restarts: number;
  app_type: string; build_cmd: string; start_cmd: string;
  root_dir: string; output_dir: string; install_cmd: string;
}
```

- [ ] **Step 2: Add AppType selector component and update form state in Apps.tsx**

At the top of `Apps.tsx`, replace the `type DeployType` and `DEPLOY_TYPES` definitions and add `APP_TYPE_OPTIONS`:

```typescript
type DeployType = 'github' | 'git' | 'empty';
type EnvEntry = { key: string; value: string };

const DEPLOY_TYPES: { id: DeployType; label: string; desc: string; icon: React.ReactNode; color: string }[] = [
  { id: 'github', label: 'GitHub',        desc: 'Public or private GitHub repo',             icon: <Github size={20} />,  color: '#8b5cf6' },
  { id: 'git',    label: 'Git URL',        desc: 'GitLab, Gitea, or any git remote',          icon: <Globe size={20} />,   color: '#3b82f6' },
  { id: 'empty',  label: 'Empty / Manual', desc: 'Create directory, upload files yourself',   icon: <Upload size={20} />,  color: '#f59e0b' },
];

const APP_TYPE_OPTIONS = [
  { value: '',       label: 'Auto-detect', hint: 'Detected on first deploy and saved. Can be changed later.' },
  { value: 'next',   label: 'Next.js',     hint: 'SSR/SSG app served via PM2' },
  { value: 'vite',   label: 'Vite / SPA',  hint: 'Static files served by NGINX from dist/' },
  { value: 'node',   label: 'Node.js',     hint: 'Express, Fastify, or any Node server' },
  { value: 'static', label: 'Static HTML', hint: 'Plain HTML/CSS/JS, no build step' },
  { value: 'custom', label: 'Custom',       hint: 'Provide your own build and start commands' },
];

const STATIC_TYPES = new Set(['vite', 'static']);
function isStaticApp(appType: string, startCmd: string) {
  return STATIC_TYPES.has(appType) || (appType === 'custom' && !startCmd);
}
```

- [ ] **Step 3: Extend form state in AppsPage**

Replace the `form` state and `resetModal` function:

```typescript
const [form, setForm] = useState({
  name: '', repo_url: '', branch: 'main',
  app_type: '', root_dir: '/', output_dir: 'dist',
  build_cmd: '', start_cmd: '', install_cmd: '',
});
const [showAdvanced, setShowAdvanced] = useState(false);

function resetModal() {
  setShowNew(false); setError('');
  setDeployType('github');
  setForm({ name: '', repo_url: '', branch: 'main', app_type: '', root_dir: '/', output_dir: 'dist', build_cmd: '', start_cmd: '', install_cmd: '' });
  setEnvEntries([{ key: '', value: '' }]);
  setShowAdvanced(false);
}
```

- [ ] **Step 4: Update deployApp to send new fields**

Replace the `deployApp` function body's `api.post` call:

```typescript
const res = await api.post<App>('/apps', {
  name:       form.name,
  repo_url:   deployType === 'empty' ? '' : form.repo_url,
  branch:     form.branch,
  env_vars,
  app_type:   form.app_type,
  root_dir:   form.root_dir || '/',
  output_dir: form.output_dir || 'dist',
  build_cmd:  form.build_cmd,
  start_cmd:  form.start_cmd,
  install_cmd: form.install_cmd,
});
```

- [ ] **Step 5: Add App Type + root_dir fields to deploy modal**

In the modal's `<div className="space-y-5">`, after the Branch input block (after the closing `</>` of the git URL section, before the Env vars section), add:

```tsx
{/* App Type */}
<div>
  <label className="label">App Type</label>
  <select
    className="input"
    value={form.app_type}
    onChange={(e) => setForm({ ...form, app_type: e.target.value })}
  >
    {APP_TYPE_OPTIONS.map((o) => (
      <option key={o.value} value={o.value}>{o.label}</option>
    ))}
  </select>
  <p className="text-xs text-gray-600 mt-1.5">
    {APP_TYPE_OPTIONS.find(o => o.value === form.app_type)?.hint ?? ''}
  </p>
</div>

{/* Root Dir */}
<div>
  <label className="label">Root Directory</label>
  <input
    className="input"
    placeholder="/"
    value={form.root_dir}
    onChange={(e) => {
      let v = e.target.value;
      if (v && !v.startsWith('/')) v = '/' + v;
      v = v.replace(/\/+$/, '') || '/';
      setForm({ ...form, root_dir: v });
    }}
  />
  <p className="text-xs text-gray-600 mt-1.5">Subdirectory containing your app (e.g. /web). Use / for repo root.</p>
</div>

{/* Output Dir — shown for static types */}
{(form.app_type === 'vite' || form.app_type === 'static' || form.app_type === 'custom' || form.app_type === '') && (
  <div>
    <label className="label">Output Directory</label>
    <input
      className="input"
      placeholder="dist"
      value={form.output_dir}
      onChange={(e) => setForm({ ...form, output_dir: e.target.value || 'dist' })}
    />
    {form.app_type === 'vite' && (
      <p className="text-xs text-gray-600 mt-1.5">Must match <code className="text-gray-500">build.outDir</code> in vite.config</p>
    )}
  </div>
)}

{/* Advanced — Custom commands */}
{(form.app_type === 'custom' || showAdvanced) && (
  <div className="rounded-xl border border-white/8 bg-white/[0.01] p-4 space-y-3">
    <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Advanced / Custom Commands</p>
    <div>
      <label className="label">Build Command</label>
      <input className="input font-mono text-xs" placeholder="npm run build" value={form.build_cmd}
        onChange={(e) => setForm({ ...form, build_cmd: e.target.value })} />
    </div>
    {form.app_type !== 'vite' && form.app_type !== 'static' && (
      <div>
        <label className="label">Start Command</label>
        <input className="input font-mono text-xs" placeholder="node server.js" value={form.start_cmd}
          onChange={(e) => setForm({ ...form, start_cmd: e.target.value })} />
      </div>
    )}
    <div>
      <label className="label">Install Command</label>
      <input className="input font-mono text-xs" placeholder="npm install" value={form.install_cmd}
        onChange={(e) => setForm({ ...form, install_cmd: e.target.value })} />
    </div>
  </div>
)}

{form.app_type !== 'custom' && !showAdvanced && (
  <button type="button" className="btn-ghost text-xs" onClick={() => setShowAdvanced(true)}>
    Advanced options (custom build/start/install commands)
  </button>
)}
```

- [ ] **Step 6: Add app_type badge on app cards and filter actions for static apps**

In the app card's name row (where `StatusBadge` is rendered), add type badge after it:

```tsx
<StatusBadge status={app.status} />
{app.app_type && app.app_type !== 'next' && (
  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded text-gray-500"
    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
    {app.app_type}{app.root_dir && app.root_dir !== '/' ? ` · ${app.root_dir}` : ''}
  </span>
)}
```

In the Actions section, wrap the Restart and Start/Stop buttons in a condition:

```tsx
{/* Hide process-management actions for static apps */}
{!isStaticApp(app.app_type, app.start_cmd) && (
  <>
    <button onClick={() => doAction(app.name, 'restart')} disabled={!!acting} title="Restart"
      className="p-2 rounded-xl text-gray-600 hover:text-violet-400 hover:bg-violet-500/10 transition-all">
      <RotateCcw size={14} className={acting === app.name + 'restart' ? 'animate-spin' : ''} />
    </button>
    <button onClick={() => doAction(app.name, app.status === 'online' ? 'stop' : 'start')}
      disabled={!!acting} title={app.status === 'online' ? 'Stop' : 'Start'}
      className="p-2 rounded-xl text-gray-600 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all">
      {app.status === 'online' ? <Square size={14} /> : <Play size={14} />}
    </button>
  </>
)}
```

- [ ] **Step 7: Update empty state text**

In the empty state paragraph (line ~149):

```tsx
<p className="text-gray-600 text-sm mb-6">Deploy your first web application to get started</p>
```

- [ ] **Step 8: Build frontend to check for TypeScript errors**

```bash
cd C:/Users/User/Documents/panel/frontend && npm run build 2>&1 | tail -20
```

Expected: build completes with no TypeScript errors. Fix any type errors before committing.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/pages/Apps.tsx
git commit -m "feat(ui): add app type selector, root/output dir fields, static app badge"
```

---

## Task 11: End-to-end smoke test

- [ ] **Step 1: Build backend**

```bash
cd C:/Users/User/Documents/panel/backend && go build -o panel-server . 2>&1
```

Expected: `panel-server` binary produced, no errors.

- [ ] **Step 2: Verify migration is in migrations slice**

```bash
grep -n "version.*5" C:/Users/User/Documents/panel/backend/internal/services/db.go
```

Expected: one line showing version 5.

- [ ] **Step 3: Verify deploy_app.sh is executable**

```bash
ls -la C:/Users/User/Documents/panel/scripts/deploy_app.sh
```

Expected: file exists with execute permission.

- [ ] **Step 4: Verify allowedScripts includes deploy_app.sh**

```bash
grep "deploy_app" C:/Users/User/Documents/panel/backend/internal/services/executor.go
```

Expected: `"deploy_app.sh": true` present.

- [ ] **Step 5: Final commit**

```bash
git add -A
git status
```

Review that only expected files are staged, then:

```bash
git commit -m "chore: final cleanup for multi app type support" --allow-empty
```

---

## Spec Coverage Check

| Spec Requirement | Task |
|---|---|
| 6 new fields: app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd | Task 1 |
| DB migration 5 | Task 1 |
| Go detection: config files → deps → scripts signals | Task 2 |
| IsStaticType helper | Task 2 |
| deploy_app.sh: all 5 types, lockfile-aware install, cleanup, validation | Task 5 |
| setup_app.sh: updated for all types | Task 6 |
| RunScriptEnv + allowedScripts | Task 3 |
| Static NGINX: no-cache index.html, 1y assets, gzip, try_files | Task 4 |
| Domains handler: proxy vs static NGINX | Task 9 |
| SSL handler: proxy vs static NGINX | Task 9 |
| Create handler: new fields, auto-detect via .panel_meta | Task 8 |
| Action handler: re-detect, guard static apps, pass env to scripts | Task 8 |
| Frontend: type selector, root_dir, output_dir, advanced panel | Task 10 |
| App card: type badge, hide start/stop/restart for static | Task 10 |
