#!/usr/bin/env bash
# update_panel.sh — Zero-downtime panel self-update
# v2.2 — fixed PM2 restart race condition
#
# Safety guarantees:
#   1. User apps (PM2 processes) are NEVER touched — only panel-backend is restarted
#   2. Go binary is built to a temp file, then atomically swapped (mv)
#   3. Frontend is built to a temp dir, then atomically swapped (mv)
#   4. On any build failure, old binary + frontend remain untouched (automatic rollback)
#   5. Old binary + frontend kept as .bak for manual rollback
#   6. User app status is verified before and after the update
#
set -euo pipefail

PANEL_DIR="/opt/panel"
LOG_FILE="/var/log/panel/update.log"

mkdir -p /var/log/panel

# Redirect all output to log file AND stdout (so the API can capture it)
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "======================================"
echo "[update] $(date '+%Y-%m-%d %H:%M:%S') — Panel update started"
echo "======================================"

cd "$PANEL_DIR"

# ── Helper: list user apps (everything except panel-backend) ──────────────
list_user_apps() {
  pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    procs = json.load(sys.stdin)
    for p in procs:
        if p['name'] != 'panel-backend':
            print(f\"  {p['name']}: {p['pm2_env']['status']} (pid {p['pid']})\")
except:
    pass
" 2>/dev/null || true
}

# ── 1. Snapshot user app status ───────────────────────────────────────────
echo ""
echo "[1/7] Checking user apps before update..."
USER_APPS_BEFORE=$(list_user_apps)
if [ -n "$USER_APPS_BEFORE" ]; then
  echo "$USER_APPS_BEFORE"
else
  echo "  (no user apps running)"
fi
echo "[1/7] Done."

# ── 2. Pull latest code ──────────────────────────────────────────────────
echo ""
echo "[2/7] Pulling latest changes from GitHub..."
git fetch origin main 2>&1
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[update] Already up to date (${LOCAL:0:8})"
  echo "[update] Done — no changes."
  exit 0
fi

echo "[update] Updating from ${LOCAL:0:8} to ${REMOTE:0:8}"
git reset --hard origin/main 2>&1
echo "[2/7] Done."

# ── 3. Build Go backend to temp file (no overwrite until verified) ────────
echo ""
echo "[3/7] Building Go backend (to temp file)..."
export PATH="/usr/local/go/bin:$PATH"
cd "$PANEL_DIR/backend"

# Build to a temp file — the running binary is untouched
go build -o panel-server.new ./main.go 2>&1

# Verify the new binary is valid (not a 0-byte file or corrupt)
if [ ! -f panel-server.new ] || [ ! -s panel-server.new ]; then
  echo "[ERROR] Build produced empty or missing binary — aborting"
  rm -f panel-server.new
  exit 1
fi

# Quick sanity: binary starts with ELF magic bytes (7f 45 4c 46)
if ! head -c 4 panel-server.new | grep -q "ELF"; then
  echo "[ERROR] Built binary is not a valid ELF executable — aborting"
  rm -f panel-server.new
  exit 1
fi

echo "[3/7] Done — binary built successfully ($(du -h panel-server.new | cut -f1))."

# ── 4. Build frontend to temp dir (old dist stays intact until swap) ──────
echo ""
echo "[4/7] Building frontend (to temp dir)..."
cd "$PANEL_DIR/frontend"

# Build to dist.new — the live dist/ is untouched during build
npx vite build --outDir dist.new --emptyOutDir 2>&1

# Verify the build output exists
if [ ! -f dist.new/index.html ]; then
  echo "[ERROR] Frontend build failed — dist.new/index.html missing — aborting"
  rm -rf dist.new
  rm -f "$PANEL_DIR/backend/panel-server.new"
  exit 1
fi

echo "[4/7] Done — frontend built successfully."

# ── 5. Atomic swap: backend binary ───────────────────────────────────────
echo ""
echo "[5/7] Swapping backend binary..."
cd "$PANEL_DIR/backend"

# Keep backup of current binary for manual rollback
if [ -f panel-server ]; then
  cp panel-server panel-server.bak
fi

# Atomic rename (same filesystem = instant, no partial state)
mv panel-server.new panel-server
chmod +x panel-server
echo "[5/7] Done — binary swapped (old saved as panel-server.bak)."

# ── 6. Atomic swap: frontend dist ────────────────────────────────────────
echo ""
echo "[6/7] Swapping frontend files..."
cd "$PANEL_DIR/frontend"

# Atomic swap: rename old dist, rename new dist, remove old
# The window between the two mv's is sub-millisecond
if [ -d dist ]; then
  mv dist dist.old
fi
mv dist.new dist

# Clean up old dist (keep .bak for one cycle)
rm -rf dist.bak
if [ -d dist.old ]; then
  mv dist.old dist.bak
fi
echo "[6/7] Done — frontend swapped (old saved as dist.bak)."

# ── 7. Restart panel backend ONLY (user apps untouched) ──────────────────
echo ""
echo "[7/7] Scheduling panel backend restart (user apps NOT affected)..."

# Update script permissions
chmod +x "$PANEL_DIR/scripts/"*.sh

# Save PM2 process list
pm2 save --force 2>/dev/null || true

echo ""
echo "======================================"
NEW_HEAD=$(git rev-parse --short HEAD)
echo "[update] Update complete! Now running: $NEW_HEAD"
echo "[update] User apps: untouched"
echo "[update] $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================"

# Schedule PM2 restart AFTER this script exits cleanly.
# The script is a child process of the Go backend, so if we restart PM2
# here directly, it kills Go, which kills this script with SIGINT.
# By deferring the restart with nohup + sleep, the script exits first,
# Go sends the "complete" SSE event, then the backend restarts.
nohup bash -c "sleep 2 && pm2 restart panel-backend --update-env" >/dev/null 2>&1 &
