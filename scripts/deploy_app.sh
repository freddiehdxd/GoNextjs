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
if [[ "$PM2_MODE" != "restart" && "$PM2_MODE" != "reload" ]]; then
  echo "[error] Invalid PM2_MODE: ${PM2_MODE} (must be restart or reload)" >&2; exit 1
fi
MAX_MEMORY="${6:-512}"
if ! [[ "$MAX_MEMORY" =~ ^[0-9]+$ ]]; then
  echo "[error] Invalid MAX_MEMORY: ${MAX_MEMORY}" >&2; exit 1
fi
APPS_DIR="${APPS_DIR:-/var/www/apps}"

# New fields from env (empty = auto-detect or default)
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

# Resolved ROOT_DIR for .panel_meta
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
    elif [ "$APP_TYPE" = "custom" ] && [ -z "$START_CMD" ]; then
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
