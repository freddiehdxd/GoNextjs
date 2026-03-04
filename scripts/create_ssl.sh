#!/usr/bin/env bash
# create_ssl.sh — Issue a Let's Encrypt certificate via Certbot
# Usage: create_ssl.sh <domain> <email>
set -euo pipefail

DOMAIN="${1:?domain is required}"
EMAIL="${2:?email is required}"

# ── Validation ─────────────────────────────────────────────────────────────
if ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
  echo "[error] Invalid domain: ${DOMAIN}" >&2
  exit 1
fi

if ! [[ "$EMAIL" =~ ^[^@]+@[^@]+\.[^@]+$ ]]; then
  echo "[error] Invalid email: ${EMAIL}" >&2
  exit 1
fi

# ── Install certbot if needed ──────────────────────────────────────────────
if ! command -v certbot &>/dev/null; then
  echo "[panel] Installing Certbot..."
  apt-get update -qq
  apt-get install -y certbot python3-certbot-nginx
fi

# ── Issue certificate ──────────────────────────────────────────────────────
echo "[panel] Issuing certificate for ${DOMAIN}..."
certbot --nginx \
  --non-interactive \
  --agree-tos \
  --redirect \
  --email "${EMAIL}" \
  -d "${DOMAIN}"

# ── Set up auto-renewal (idempotent) ──────────────────────────────────────
if ! systemctl is-enabled certbot.timer &>/dev/null; then
  systemctl enable --now certbot.timer
  echo "[panel] Certbot auto-renewal timer enabled."
fi

echo "[panel] SSL certificate issued for ${DOMAIN}."
