#!/usr/bin/env bash
# install_postgres.sh — Install PostgreSQL 17 and create panel DB/user
set -euo pipefail

PG_VERSION="17"
PANEL_DB_USER="${PANEL_DB_USER:-paneluser}"
PANEL_DB_PASS="${PANEL_DB_PASS:-panelpass}"
PANEL_DB_NAME="${PANEL_DB_NAME:-panel}"

echo "[panel] Installing PostgreSQL ${PG_VERSION}..."

# ── Add official PostgreSQL APT repository (ensures we get PG17) ───────────
if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
  echo "[panel] Adding PostgreSQL APT repository..."
  apt-get install -y -qq curl ca-certificates gnupg >/dev/null 2>&1

  # Import the repository signing key
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg

  # Detect Ubuntu/Debian codename
  CODENAME=$(lsb_release -cs 2>/dev/null || echo "noble")
  echo "deb [signed-by=/etc/apt/trusted.gpg.d/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
fi

apt-get update -qq
apt-get install -y postgresql-${PG_VERSION} postgresql-client-${PG_VERSION} postgresql-contrib

systemctl enable postgresql
systemctl start postgresql

# ── Wait for PostgreSQL to be ready ───────────────────────────────────────
echo "[panel] Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
  if sudo -u postgres pg_isready -q 2>/dev/null; then
    echo "  PostgreSQL ${PG_VERSION} ready (${i}s)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[error] PostgreSQL did not become ready in 30 seconds" >&2
    exit 1
  fi
  sleep 1
done

# ── Create user and database ───────────────────────────────────────────────
echo "[panel] Creating panel database and user..."

sudo -u postgres psql -v ON_ERROR_STOP=1 <<-SQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PANEL_DB_USER}') THEN
      -- SUPERUSER so paneluser can CREATE/DROP databases and roles via TCP
      CREATE ROLE "${PANEL_DB_USER}" LOGIN SUPERUSER PASSWORD '${PANEL_DB_PASS}';
    ELSE
      ALTER ROLE "${PANEL_DB_USER}" SUPERUSER;
    END IF;
  END
  \$\$;

  SELECT 'CREATE DATABASE ${PANEL_DB_NAME} OWNER ${PANEL_DB_USER}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${PANEL_DB_NAME}')
  \gexec
SQL

echo "[panel] PostgreSQL ${PG_VERSION} ready."
echo "  Connection: postgresql://${PANEL_DB_USER}:${PANEL_DB_PASS}@localhost:5432/${PANEL_DB_NAME}"
