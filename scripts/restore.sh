#!/bin/sh
# Restore only into an empty Compose project; never overwrite existing notes.
set -eu
cd "$(dirname "$0")/.."
SOURCE=${1:?Usage: scripts/restore.sh BACKUP_DIRECTORY}
[ -f "$SOURCE/COMPLETE" ] && [ "$(cat "$SOURCE/COMPLETE")" = 'nas-sync-backup-v1' ]
(cd "$SOURCE" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c checksums.sha256; else shasum -a 256 -c checksums.sha256; fi)
if [ -n "$(docker compose ps --status running -q server)" ]; then
  echo 'Stop the sync service before restoring; use a fresh Compose project.' >&2
  exit 1
fi
docker compose up -d postgres --wait >/dev/null
COUNT=$(docker compose exec -T postgres psql -U nas_sync -d nas_sync -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
if [ "$COUNT" != '0' ]; then
  echo 'Target database is not empty. Restore to a fresh COMPOSE_PROJECT_NAME.' >&2
  exit 1
fi
# Ensure the object root has no existing objects before unpacking.
docker compose run --rm -T --no-deps --entrypoint sh server -ec '[ ! -d /data/objects ] || [ -z "$(find /data/objects -mindepth 1 -print -quit)" ]'
docker compose run --rm -T --no-deps --entrypoint tar server -xzf - -C /data < "$SOURCE/objects.tar.gz"
docker compose exec -T postgres pg_restore -U nas_sync -d nas_sync --no-owner --exit-on-error < "$SOURCE/database.dump"
# A restore starts a new history branch. Rotate identity before any client can
# connect, even if later writes reuse the pre-restore revision numbers.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U nas_sync -d nas_sync -c 'UPDATE vault SET id=gen_random_uuid()::text WHERE singleton' >/dev/null
docker compose up -d server --wait >/dev/null
echo 'Restore complete. The sync service rebuilt its readable file tree.'
