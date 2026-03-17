#!/usr/bin/env bash
# install_nginx.sh — Install and configure NGINX
set -euo pipefail

echo "[panel] Installing NGINX..."

apt-get update -qq
apt-get install -y nginx

# Enable and start
systemctl enable nginx
systemctl start nginx

# Create a safe default to prevent exposing the default vhost
rm -f /etc/nginx/sites-enabled/default

# Ensure log dir exists
mkdir -p /var/log/nginx

echo "[panel] NGINX installed and running."
nginx -v
