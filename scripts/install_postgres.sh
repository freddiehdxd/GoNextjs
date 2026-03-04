#!/usr/bin/env bash
# install_postgres.sh — Install PostgreSQL 16 and create panel DB
set -euo pipefail

PANEL_DB_USER="${PANEL_DB_USER:-paneluser}"
PANEL_DB_PASS="${PANEL_DB_PASS:-panelpass}"
PANEL_DB_NAME="${PANEL_DB_NAME:-panel}"

echo "[panel] Installing PostgreSQL..."

apt-get update -qq
apt-get install -y postgresql postgresql-contrib

systemctl enable postgresql
systemctl start postgresql

echo "[panel] Creating panel database and user..."

# Run as postgres superuser
sudo -u postgres psql -v ON_ERROR_STOP=1 <<-SQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PANEL_DB_USER}') THEN
      CREATE ROLE "${PANEL_DB_USER}" LOGIN PASSWORD '${PANEL_DB_PASS}';
    END IF;
  END
  \$\$;

  SELECT 'CREATE DATABASE ${PANEL_DB_NAME} OWNER ${PANEL_DB_USER}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${PANEL_DB_NAME}')
  \gexec
SQL

echo "[panel] PostgreSQL ready."
echo "  Connection string: postgresql://${PANEL_DB_USER}:${PANEL_DB_PASS}@localhost:5432/${PANEL_DB_NAME}"
