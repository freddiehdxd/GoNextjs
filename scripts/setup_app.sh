#!/usr/bin/env bash
# setup_app.sh — Install, build, and start a manually-uploaded app
# Usage: setup_app.sh <app_name> <port> [pm2_mode] [max_memory]
# Env vars: APP_TYPE, ROOT_DIR, OUTPUT_DIR, BUILD_CMD, START_CMD, INSTALL_CMD
set -euo pipefail

APP_NAME="${1:?app_name is required}"
PORT="${2:?port is required}"
PM2_MODE="${3:-restart}"
if [[ "$PM2_MODE" != "restart" && "$PM2_MODE" != "reload" ]]; then
  echo "[error] Invalid PM2_MODE: ${PM2_MODE} (must be restart or reload)" >&2; exit 1
fi
MAX_MEMORY="${4:-512}"
if ! [[ "$MAX_MEMORY" =~ ^[0-9]+$ ]]; then
  echo "[error] Invalid MAX_MEMORY: ${MAX_MEMORY}" >&2; exit 1
fi
APPS_DIR="${APPS_DIR:-/var/www/apps}"

APP_TYPE="${APP_TYPE:-}"
ROOT_DIR="${ROOT_DIR:-/}"
OUTPUT_DIR="${OUTPUT_DIR:-dist}"
if [[ "$OUTPUT_DIR" =~ \.\. ]]; then
  echo "[error] OUTPUT_DIR must not contain .." >&2; exit 1
fi
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
if [ "$RESOLVED_TYPE" = "vite" ] || [ "$RESOLVED_TYPE" = "static" ]; then
  IS_STATIC=true
fi
if [ "$RESOLVED_TYPE" = "custom" ] && [ -z "$START_CMD" ]; then
  IS_STATIC=true
fi

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
  elif [ "$RESOLVED_TYPE" = "custom" ] && [ -z "$START_CMD" ]; then
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
  PM2_ARGS="-c \"${START_CMD}\""
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
