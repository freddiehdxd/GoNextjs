#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════╗
# ║  ServerPanel — One-Shot Installer                                         ║
# ║  Run on a fresh Ubuntu 22.04+ VPS as root.                                ║
# ║                                                                            ║
# ║  One-liner install:                                                        ║
# ║    curl -fsSL https://raw.githubusercontent.com/freddiehdxd/panel/main/scripts/install.sh | bash
# ║                                                                            ║
# ║  Or manual:                                                                ║
# ║    git clone https://github.com/freddiehdxd/panel.git /opt/panel           ║
# ║    bash /opt/panel/scripts/setup_panel.sh                                  ║
# ╚════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

PANEL_DIR="/opt/panel"
PANEL_DB_USER="${PANEL_DB_USER:-paneluser}"
PANEL_DB_PASS="${PANEL_DB_PASS:-$(openssl rand -hex 16)}"
PANEL_DB_NAME="${PANEL_DB_NAME:-panel}"
JWT_SECRET="$(openssl rand -hex 64)"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-$(openssl rand -hex 8)}"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[  ok]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[fail]${NC}  $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}${CYAN}[$1/${TOTAL_STEPS}]${NC} ${BOLD}$2${NC}"; }

TOTAL_STEPS=10

echo ""
echo -e "${BOLD}${CYAN}╔════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║     ServerPanel — Installer            ║${NC}"
echo -e "${BOLD}${CYAN}╚════════════════════════════════════════╝${NC}"
echo ""

# ── 0. Preflight ──────────────────────────────────────────────────────────
[ "$EUID" -ne 0 ] && fail "Please run as root (sudo bash $0)"

# Detect OS
if [ -f /etc/os-release ]; then
  . /etc/os-release
  if [[ "${ID}" != "ubuntu" && "${ID}" != "debian" ]]; then
    warn "Detected ${ID} — this script is tested on Ubuntu 22.04+. Proceeding anyway..."
  fi
fi

# ── 1. System packages ───────────────────────────────────────────────────
step 1 "Installing system dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git openssl ufw build-essential software-properties-common > /dev/null
ok "System packages installed"

# ── 2. Swap (for VPS with ≤2 GB RAM) ─────────────────────────────────────
step 2 "Checking swap"
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_RAM_MB" -lt 2048 ] && [ ! -f /swapfile ]; then
  info "Low RAM detected (${TOTAL_RAM_MB} MB) — creating 2 GB swap..."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile > /dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "2 GB swap created and enabled"
else
  ok "Swap OK (${TOTAL_RAM_MB} MB RAM)"
fi

# ── 3. Node.js LTS ───────────────────────────────────────────────────────
step 3 "Installing Node.js"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
fi
ok "Node $(node -v) / NPM $(npm -v)"

# ── 4. PM2 ────────────────────────────────────────────────────────────────
step 4 "Installing PM2"
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --quiet > /dev/null 2>&1
fi
# Auto-start PM2 on reboot
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root 2>/dev/null | \
  grep "sudo" | bash 2>/dev/null || true
ok "PM2 $(pm2 -v)"

# ── 5. NGINX ─────────────────────────────────────────────────────────────
step 5 "Installing NGINX"
if ! command -v nginx &>/dev/null; then
  apt-get install -y -qq nginx > /dev/null
fi
systemctl enable nginx > /dev/null 2>&1
systemctl start nginx
rm -f /etc/nginx/sites-enabled/default
ok "NGINX $(nginx -v 2>&1 | grep -oP '[\d.]+')"

# ── 6. PostgreSQL ────────────────────────────────────────────────────────
step 6 "Installing PostgreSQL"
if ! command -v psql &>/dev/null; then
  apt-get install -y -qq postgresql postgresql-contrib > /dev/null
fi
systemctl enable postgresql > /dev/null 2>&1
systemctl start postgresql

# Wait for ready
for i in $(seq 1 30); do
  sudo -u postgres pg_isready -q 2>/dev/null && break
  [ "$i" -eq 30 ] && fail "PostgreSQL did not start in 30 seconds"
  sleep 1
done

# Create user + database
sudo -u postgres psql -v ON_ERROR_STOP=1 <<-SQL > /dev/null 2>&1
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PANEL_DB_USER}') THEN
      CREATE ROLE "${PANEL_DB_USER}" LOGIN SUPERUSER PASSWORD '${PANEL_DB_PASS}';
    ELSE
      ALTER ROLE "${PANEL_DB_USER}" WITH PASSWORD '${PANEL_DB_PASS}';
      ALTER ROLE "${PANEL_DB_USER}" SUPERUSER;
    END IF;
  END
  \$\$;
  SELECT 'CREATE DATABASE ${PANEL_DB_NAME} OWNER ${PANEL_DB_USER}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${PANEL_DB_NAME}')
  \gexec
SQL
ok "PostgreSQL ready — DB: ${PANEL_DB_NAME}, User: ${PANEL_DB_USER}"

# ── 7. Redis ─────────────────────────────────────────────────────────────
step 7 "Installing Redis"
if ! command -v redis-server &>/dev/null; then
  apt-get install -y -qq redis-server > /dev/null
fi
sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf 2>/dev/null || true
systemctl enable redis-server > /dev/null 2>&1
systemctl restart redis-server
ok "Redis running on 127.0.0.1:6379"

# ── 8. Directories + config ──────────────────────────────────────────────
step 8 "Writing configuration"
mkdir -p /var/www/apps /var/log/panel
chmod 755 /var/www/apps
chmod +x "${PANEL_DIR}"/scripts/*.sh

cat > "${PANEL_DIR}/backend/.env" <<EOF
PORT=4000
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
ADMIN_USERNAME=${ADMIN_USER}
ADMIN_PASSWORD=${ADMIN_PASS}
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
NEXT_PUBLIC_API_URL=http://127.0.0.1:4000
EOF

ok "Config written to backend/.env and frontend/.env.local"

# ── 9. Build ─────────────────────────────────────────────────────────────
step 9 "Building application"

info "Installing backend dependencies..."
cd "${PANEL_DIR}/backend"
npm install --quiet > /dev/null 2>&1
npm run build
[ ! -f "${PANEL_DIR}/backend/dist/index.js" ] && fail "Backend build failed"
ok "Backend built"

info "Installing frontend dependencies..."
cd "${PANEL_DIR}/frontend"
npm install --quiet > /dev/null 2>&1
npm run build 2>&1 | tail -5
[ ! -d "${PANEL_DIR}/frontend/.next" ] && fail "Frontend build failed"
ok "Frontend built"

# ── 10. Start services ───────────────────────────────────────────────────
step 10 "Starting services"

# PM2
pm2 delete panel-backend  2>/dev/null || true
pm2 delete panel-frontend 2>/dev/null || true

pm2 start "${PANEL_DIR}/backend/dist/index.js" \
  --name panel-backend \
  --cwd "${PANEL_DIR}/backend" \
  --env production \
  --log /var/log/panel/backend.log \
  --merge-logs > /dev/null

pm2 start npm \
  --name panel-frontend \
  --cwd "${PANEL_DIR}/frontend" \
  --log /var/log/panel/frontend.log \
  --merge-logs \
  -- start > /dev/null

pm2 save > /dev/null 2>&1

info "Waiting for services..."
sleep 5

# Health checks
if curl -sf http://127.0.0.1:4000/health > /dev/null 2>&1; then
  ok "Backend healthy (port 4000)"
else
  warn "Backend not responding yet — check: pm2 logs panel-backend"
fi

if curl -sf http://127.0.0.1:3000 > /dev/null 2>&1; then
  ok "Frontend healthy (port 3000)"
else
  warn "Frontend not responding yet — check: pm2 logs panel-frontend"
fi

# ── NGINX config ─────────────────────────────────────────────────────────
SERVER_IP="$(curl -fsSL --connect-timeout 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

cat > /etc/nginx/sites-available/panel <<'NGINXCONF'
# ServerPanel — auto-generated by setup_panel.sh
# API requests go directly to backend (port 4000) — no Next.js middleman
# Frontend requests go to Next.js (port 3000)

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 100M;

    # API — proxy directly to Express backend (fast, no Next.js rewrite overhead)
    location /api/ {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;

        # No caching for API
        add_header Cache-Control "no-store, no-cache" always;
    }

    # Frontend — Next.js
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
    }
}
NGINXCONF

ln -sf /etc/nginx/sites-available/panel /etc/nginx/sites-enabled/panel
rm -f /etc/nginx/sites-enabled/default

nginx -t > /dev/null 2>&1 && systemctl reload nginx
ok "NGINX configured — proxying to backend + frontend"

# ── Firewall ─────────────────────────────────────────────────────────────
ufw allow OpenSSH      > /dev/null 2>&1
ufw allow 'Nginx Full' > /dev/null 2>&1
ufw --force enable     > /dev/null 2>&1
ok "Firewall enabled (SSH + HTTP/HTTPS)"

# ── Install Certbot (for later SSL usage) ────────────────────────────────
if ! command -v certbot &>/dev/null; then
  apt-get install -y -qq certbot python3-certbot-nginx > /dev/null 2>&1
  ok "Certbot installed (ready for SSL)"
fi

# ── Done ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║   ServerPanel installed successfully!              ║${NC}"
echo -e "${BOLD}${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Open in browser:${NC}  http://${SERVER_IP}"
echo ""
echo -e "  ${BOLD}Login:${NC}"
echo -e "    Username:  ${CYAN}${ADMIN_USER}${NC}"
echo -e "    Password:  ${CYAN}${ADMIN_PASS}${NC}"
echo ""
echo -e "  ${YELLOW}Save your password! It was auto-generated.${NC}"
echo -e "  To change it later: nano ${PANEL_DIR}/backend/.env"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    pm2 list                   — process status"
echo -e "    pm2 logs panel-backend     — backend logs"
echo -e "    pm2 restart panel-backend  — restart backend"
echo ""
