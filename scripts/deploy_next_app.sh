#!/usr/bin/env bash
# deploy_next_app.sh — Clone, build, and start a Next.js app with PM2
# Usage: deploy_next_app.sh <app_name> <repo_url> <branch> <port>
set -euo pipefail

APP_NAME="${1:?app_name is required}"
REPO_URL="${2:?repo_url is required}"
BRANCH="${3:-main}"
PORT="${4:?port is required}"
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

echo "[panel] Deploying ${APP_NAME} from ${REPO_URL} (${BRANCH}) on port ${PORT}"

# ── Ensure Node.js + PM2 present ──────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[panel] Installing Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
fi

if ! command -v pm2 &>/dev/null; then
  echo "[panel] Installing PM2..."
  npm install -g pm2
fi

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
  git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${APP_DIR}"
fi

# ── Install dependencies ───────────────────────────────────────────────────
echo "[panel] Installing dependencies..."
cd "${APP_DIR}"
npm ci --prefer-offline 2>&1 || npm install 2>&1

# ── Build ──────────────────────────────────────────────────────────────────
echo "[panel] Building Next.js app..."
npm run build 2>&1

# ── PM2 ecosystem file ─────────────────────────────────────────────────────
cat > "${APP_DIR}/ecosystem.config.js" <<EOF
module.exports = {
  apps: [{
    name:    '${APP_NAME}',
    cwd:     '${APP_DIR}',
    script:  'node_modules/.bin/next',
    args:    'start -p ${PORT}',
    env: {
      NODE_ENV: 'production',
      PORT:     '${PORT}',
    },
    max_memory_restart: '512M',
    error_file:   '/var/log/panel/pm2-${APP_NAME}-error.log',
    out_file:     '/var/log/panel/pm2-${APP_NAME}-out.log',
    merge_logs:   true,
  }],
};
EOF

mkdir -p /var/log/panel

# ── Start or restart with PM2 ──────────────────────────────────────────────
if pm2 describe "${APP_NAME}" &>/dev/null; then
  echo "[panel] Restarting existing PM2 process..."
  pm2 reload "${APP_NAME}" --update-env
else
  echo "[panel] Starting new PM2 process..."
  pm2 start "${APP_DIR}/ecosystem.config.js"
fi

pm2 save
echo "[panel] ${APP_NAME} deployed and running on port ${PORT}."
