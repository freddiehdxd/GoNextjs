#!/usr/bin/env bash
# install_redis.sh — Install Redis and harden default config
set -euo pipefail

echo "[panel] Installing Redis..."

apt-get update -qq
apt-get install -y redis-server

# Bind to loopback only — do NOT expose Redis to the network
sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf

# Disable dangerous commands (optional hardening)
# Uncomment if you want to rename/disable FLUSHALL etc.
# echo "rename-command FLUSHALL \"\""   >> /etc/redis/redis.conf
# echo "rename-command FLUSHDB  \"\""   >> /etc/redis/redis.conf
# echo "rename-command CONFIG   \"\""   >> /etc/redis/redis.conf

systemctl enable redis-server
systemctl restart redis-server

echo "[panel] Redis installed and listening on 127.0.0.1:6379"
redis-cli ping
