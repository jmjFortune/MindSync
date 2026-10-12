#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then
  echo '.env already exists; keeping existing credentials.'
  exit 0
fi
umask 077
ADMIN_SECRET=$(openssl rand -hex 32)
DB_SECRET=$(openssl rand -hex 32)
{
  printf 'NAS_SYNC_ADMIN_TOKEN=%s\n' "$ADMIN_SECRET"
  printf 'POSTGRES_PASSWORD=%s\n' "$DB_SECRET"
  printf 'NAS_SYNC_BIND_ADDRESS=127.0.0.1\nNAS_SYNC_PORT=8080\nNAS_SYNC_MAX_FILE_BYTES=52428800\n'
} > .env
unset ADMIN_SECRET DB_SECRET
echo 'Created .env with random credentials. Set NAS_SYNC_BIND_ADDRESS to the NAS LAN IP for LAN access.'
