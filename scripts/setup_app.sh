#!/usr/bin/env bash
# setup_app.sh — Install, build, and start an uploaded Next.js app with PM2
# Usage: setup_app.sh <app_name> <port>
#
# This is the counterpart to deploy_next_app.sh for manually-uploaded projects.
# It skips the git clone step and works directly with whatever files are in the app dir.
set -euo pipefail

APP_NAME="${1:?app_name is required}"
PORT="${2:?port is required}"
PM2_MODE="${3:-restart}"   # "restart" (default) or "reload" (zero-downtime)
MAX_MEMORY="${4:-512}"     # max memory in MB for PM2 max_memory_restart
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

APP_DIR="${APPS_DIR}/${APP_NAME}"

if [ ! -d "${APP_DIR}" ]; then
  echo "[error] App directory not found: ${APP_DIR}" >&2
  exit 1
fi

cd "${APP_DIR}"

# ── Handle nested directory (zip extracts into a subfolder) ────────────────
# If there's no package.json at the root but exactly one subdirectory has one,
# move everything up from that subdirectory to the app root.
if [ ! -f "package.json" ]; then
  echo "[setup] No package.json at root, checking subdirectories..."
  SUBDIRS_WITH_PKG=()
  for d in */; do
    if [ -f "${d}package.json" ]; then
      SUBDIRS_WITH_PKG+=("$d")
    fi
  done

  if [ "${#SUBDIRS_WITH_PKG[@]}" -eq 1 ]; then
    SUBDIR="${SUBDIRS_WITH_PKG[0]}"
    echo "[setup] Found package.json in ${SUBDIR} — moving contents to app root..."
    # Move all files from subdirectory to root (including dotfiles)
    shopt -s dotglob
    mv "${SUBDIR}"* . 2>/dev/null || true
    shopt -u dotglob
    rmdir "${SUBDIR}" 2>/dev/null || true
    echo "[setup] Files moved to app root."
  elif [ "${#SUBDIRS_WITH_PKG[@]}" -eq 0 ]; then
    echo "[error] No package.json found in app directory or any subdirectory" >&2
    exit 1
  else
    echo "[error] Multiple subdirectories with package.json found — cannot auto-detect project root" >&2
    echo "[error] Please upload a zip where the project is at the root level" >&2
    exit 1
  fi
fi

echo "[setup] Setting up ${APP_NAME} on port ${PORT}"

# ── Install dependencies ───────────────────────────────────────────────────
echo "[setup] Installing dependencies..."
if [ -f "package-lock.json" ]; then
  npm ci --production=false 2>&1
else
  npm install 2>&1
fi

# ── Detect project type and configure scripts ─────────────────────────────
HAS_BUILD=$(node -e "const p=require('./package.json'); process.stdout.write(p.scripts&&p.scripts.build?'yes':'no')")
HAS_START=$(node -e "const p=require('./package.json'); process.stdout.write(p.scripts&&p.scripts.start?'yes':'no')")

# Check if it's a Next.js project
IS_NEXT="no"
if node -e "const p=require('./package.json'); const d={...p.dependencies,...p.devDependencies}; process.exit(d.next?0:1)" 2>/dev/null; then
  IS_NEXT="yes"
fi

# Add missing build script
if [ "$HAS_BUILD" = "no" ]; then
  if [ "$IS_NEXT" = "yes" ]; then
    echo "[setup] No build script found — adding 'next build'..."
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.build = 'next build';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
    "
  else
    echo "[setup] No build script found — skipping build step."
  fi
fi

# Add missing start script
if [ "$HAS_START" = "no" ]; then
  if [ "$IS_NEXT" = "yes" ]; then
    echo "[setup] No start script found — adding 'next start'..."
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.start = 'next start -p \${PORT:-${PORT}}';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
    "
  else
    echo "[setup] No start script found — adding default 'node index.js'..."
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.start = 'node index.js';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
    "
  fi
fi

# Re-check after possible modifications
HAS_BUILD=$(node -e "const p=require('./package.json'); process.stdout.write(p.scripts&&p.scripts.build?'yes':'no')")

# ── Build ──────────────────────────────────────────────────────────────────
if [ "$HAS_BUILD" = "yes" ]; then
  echo "[setup] Building project..."
  NODE_ENV=production npm run build 2>&1
else
  echo "[setup] No build script — skipping build."
fi

# ── Log directory ──────────────────────────────────────────────────────────
mkdir -p /var/log/panel

# ── PM2 ecosystem file ─────────────────────────────────────────────────────
echo "[setup] Creating PM2 ecosystem config..."

# Build env block: always include NODE_ENV and PORT, then merge .env vars
ENV_BLOCK="      NODE_ENV: 'production',
      PORT:     '${PORT}',"

if [ -f "${APP_DIR}/.env" ]; then
  echo "[setup] Loading environment variables from .env..."
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
    echo "[setup] Zero-downtime reload of PM2 process..."
    pm2 reload "${APP_NAME}" --update-env 2>&1
  else
    echo "[setup] Restarting PM2 process..."
    pm2 restart "${APP_NAME}" --update-env 2>&1
  fi
else
  echo "[setup] Starting new PM2 process..."
  pm2 start "${APP_DIR}/ecosystem.config.js" 2>&1
fi

pm2 save 2>/dev/null || true

echo "[setup] ${APP_NAME} is now running on port ${PORT}."
