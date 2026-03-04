#!/usr/bin/env bash
# setup_panel.sh — Full one-shot installation of the control panel
# Run as root on a fresh Ubuntu 22.04+ server.
# Usage: bash setup_panel.sh
set -euo pipefail

PANEL_DIR="/opt/panel"
PANEL_DB_USER="${PANEL_DB_USER:-paneluser}"
PANEL_DB_PASS="${PANEL_DB_PASS:-$(openssl rand -hex 16)}"
PANEL_DB_NAME="${PANEL_DB_NAME:-panel}"
JWT_SECRET="$(openssl rand -hex 64)"

echo "========================================"
echo "  Panel — Server Control Panel Setup"
echo "========================================"

# ── 1. System dependencies ─────────────────────────────────────────────────
echo "[1/8] Installing system dependencies..."
apt-get update -qq
apt-get install -y curl git openssl ufw

# ── 2. Node.js LTS ────────────────────────────────────────────────────────
echo "[2/8] Installing Node.js LTS..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v)  NPM: $(npm -v)"

# ── 3. PM2 ────────────────────────────────────────────────────────────────
echo "[3/8] Installing PM2..."
npm install -g pm2 --quiet
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

# ── 4. NGINX ──────────────────────────────────────────────────────────────
echo "[4/8] Installing NGINX..."
bash "${PANEL_DIR}/scripts/install_nginx.sh"

# ── 5. PostgreSQL ─────────────────────────────────────────────────────────
echo "[5/8] Installing PostgreSQL..."
PANEL_DB_USER="${PANEL_DB_USER}" \
PANEL_DB_PASS="${PANEL_DB_PASS}" \
PANEL_DB_NAME="${PANEL_DB_NAME}" \
  bash "${PANEL_DIR}/scripts/install_postgres.sh"

# ── 6. Redis ──────────────────────────────────────────────────────────────
echo "[6/8] Installing Redis..."
bash "${PANEL_DIR}/scripts/install_redis.sh"

# ── 7. Set up log dir and permissions ─────────────────────────────────────
echo "[7/8] Setting up directories..."
mkdir -p /var/www/apps /var/log/panel
chmod 755 /var/www/apps

# Make scripts executable
chmod +x "${PANEL_DIR}"/scripts/*.sh

# ── 8. Write .env files ───────────────────────────────────────────────────
echo "[8/8] Writing configuration..."

cat > "${PANEL_DIR}/backend/.env" <<EOF
PORT=4000
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme
DATABASE_URL=postgresql://${PANEL_DB_USER}:${PANEL_DB_PASS}@localhost:5432/${PANEL_DB_NAME}
APPS_DIR=/var/www/apps
NGINX_AVAILABLE=/etc/nginx/sites-available
NGINX_ENABLED=/etc/nginx/sites-enabled
SCRIPTS_DIR=${PANEL_DIR}/scripts
APP_PORT_START=3001
APP_PORT_END=3999
PANEL_ORIGIN=http://localhost:3000
EOF

cat > "${PANEL_DIR}/frontend/.env.local" <<EOF
BACKEND_URL=http://127.0.0.1:4000
EOF

# ── Install panel dependencies and build ──────────────────────────────────
echo "[panel] Installing backend dependencies..."
cd "${PANEL_DIR}/backend"
npm install --quiet

echo "[panel] Installing frontend dependencies and building..."
cd "${PANEL_DIR}/frontend"
npm install --quiet
npm run build

# ── Start panel with PM2 ──────────────────────────────────────────────────
echo "[panel] Starting panel services with PM2..."

pm2 delete panel-backend  2>/dev/null || true
pm2 delete panel-frontend 2>/dev/null || true

pm2 start "${PANEL_DIR}/backend/dist/index.js"  --name panel-backend  --env production
pm2 start "${PANEL_DIR}/frontend/node_modules/.bin/next" \
  --name panel-frontend \
  -- start -p 3000

pm2 save

# ── NGINX config for panel (IP-based, no domain needed) ───────────────────
echo "[panel] Writing NGINX config for panel..."

# Detect server public IP
SERVER_IP="$(curl -fsSL https://api.ipify.org || hostname -I | awk '{print $1}')"

cat > /etc/nginx/sites-available/panel <<NGINXCONF
# Panel control panel — accessible via server IP on port 80
# Managed by setup_panel.sh

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 100M;

    # Forward all traffic to the Next.js frontend (port 3000)
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINXCONF

ln -sf /etc/nginx/sites-available/panel /etc/nginx/sites-enabled/panel

# Remove default NGINX site if still present
rm -f /etc/nginx/sites-enabled/default

nginx -t && nginx -s reload

# ── UFW firewall ───────────────────────────────────────────────────────────
echo "[panel] Configuring firewall..."
ufw allow OpenSSH   >/dev/null
ufw allow 'Nginx Full' >/dev/null   # ports 80 + 443
ufw --force enable  >/dev/null

echo ""
echo "========================================"
echo "  Panel is running!"
echo ""
echo "  Access at: http://${SERVER_IP}"
echo ""
echo "  Default credentials:"
echo "    Username: admin"
echo "    Password: changeme"
echo ""
echo "  IMPORTANT: Change the password!"
echo "  Edit /opt/panel/backend/.env"
echo "  Set ADMIN_PASSWORD_HASH to a bcrypt hash"
echo "  Then: pm2 restart panel-backend"
echo ""
echo "  DB password saved to: /opt/panel/backend/.env"
echo "========================================"
