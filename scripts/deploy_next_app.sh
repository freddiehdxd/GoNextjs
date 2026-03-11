#!/usr/bin/env bash
# deploy_next_app.sh — Clone, build, and start a Next.js app with PM2
# Usage: deploy_next_app.sh <app_name> <repo_url> <branch> <port>
set -euo pipefail

APP_NAME="${1:?app_name is required}"
REPO_URL="${2:?repo_url is required}"
BRANCH="${3:-main}"
PORT="${4:?port is required}"
PM2_MODE="${5:-restart}"   # "restart" (default) or "reload" (zero-downtime)
MAX_MEMORY="${6:-512}"     # max memory in MB for PM2 max_memory_restart
APPS_DIR="${APPS_DIR:-/var/www/apps}"

# ── Validation ─────────────────────────────────────────────────────────────
if ! [[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "[error] Invalid app name: ${APP_NAME}" >&2
  exit 1
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "[error] Invalid port: ${PORT}" >&2
  exit 1
fi

if ! [[ "$REPO_URL" =~ ^https?:// ]] && ! [[ "$REPO_URL" =~ ^git@ ]]; then
  echo "[error] Invalid repo URL: must start with https:// or git@" >&2
  exit 1
fi

if ! [[ "$BRANCH" =~ ^[a-zA-Z0-9._/-]+$ ]]; then
  echo "[error] Invalid branch name: ${BRANCH}" >&2
  exit 1
fi

APP_DIR="${APPS_DIR}/${APP_NAME}"

echo "[panel] Deploying ${APP_NAME} from ${REPO_URL} (${BRANCH}) on port ${PORT}"

# ── Clone or pull ──────────────────────────────────────────────────────────
if [ -d "${APP_DIR}/.git" ]; then
  echo "[panel] Pulling latest changes..."
  git -C "${APP_DIR}" fetch origin
  git -C "${APP_DIR}" checkout "${BRANCH}"
  git -C "${APP_DIR}" reset --hard "origin/${BRANCH}"
else
  echo "[panel] Cloning repository..."
  mkdir -p "${APPS_DIR}"
  rm -rf "${APP_DIR}"
  git clone --branch "${BRANCH}" --depth 1 -- "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"

# ── Validate this is a Node.js project ────────────────────────────────────
if [ ! -f "package.json" ]; then
  echo "[error] No package.json found in repository root" >&2
  exit 1
fi

# ── Install dependencies ───────────────────────────────────────────────────
echo "[panel] Installing dependencies..."
if [ -f "package-lock.json" ]; then
  npm ci
else
  npm install
fi

# ── Ensure scripts exist in package.json ──────────────────────────────────
HAS_BUILD=$(node -e "const p=require('./package.json'); process.stdout.write(p.scripts&&p.scripts.build?'yes':'no')")
HAS_START=$(node -e "const p=require('./package.json'); process.stdout.write(p.scripts&&p.scripts.start?'yes':'no')")

# Add missing build script (next build)
if [ "$HAS_BUILD" = "no" ]; then
  echo "[panel] No build script found — adding 'next build'..."
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.build = 'next build';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
  "
fi

# Add missing start script (next start on the allocated port)
if [ "$HAS_START" = "no" ]; then
  echo "[panel] No start script found — adding 'next start'..."
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.start = 'next start -p \${PORT:-${PORT}}';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
  "
fi

# ── Build ──────────────────────────────────────────────────────────────────
echo "[panel] Building Next.js app..."
NODE_ENV=production npm run build

# Verify .next was produced
if [ ! -d "${APP_DIR}/.next" ]; then
  echo "[error] Build failed — .next directory not found" >&2
  exit 1
fi

# ── Log directory ──────────────────────────────────────────────────────────
mkdir -p /var/log/panel

# ── PM2 ecosystem file ─────────────────────────────────────────────────────
# Build env block: always include NODE_ENV and PORT, then merge .env vars
ENV_BLOCK="      NODE_ENV: 'production',
      PORT:     '${PORT}',"

if [ -f "${APP_DIR}/.env" ]; then
  echo "[panel] Loading environment variables from .env..."
  # Parse .env and generate JS object entries (handles quoted values)
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
      // Strip surrounding quotes
      if ((val.startsWith('\"') && val.endsWith('\"')) || (val.startsWith(\"'\") && val.endsWith(\"'\"))) {
        val = val.slice(1, -1);
      }
      // Skip NODE_ENV and PORT (already set)
      if (key === 'NODE_ENV' || key === 'PORT') return;
      // Escape single quotes for JS output
      val = val.replace(/'/g, \"\\\\\\'\" );
      console.log(\"      '\" + key + \"': '\" + val + \"',\");
    });
  " 2>/dev/null)
  if [ -n "$EXTRA_ENV" ]; then
    ENV_BLOCK="${ENV_BLOCK}
${EXTRA_ENV}"
  fi
fi

cat > "${APP_DIR}/ecosystem.config.js" <<EOF
module.exports = {
  apps: [{
    name:    '${APP_NAME}',
    cwd:     '${APP_DIR}',
    script:  'npm',
    args:    'start',
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
    echo "[panel] Zero-downtime reload of PM2 process..."
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
