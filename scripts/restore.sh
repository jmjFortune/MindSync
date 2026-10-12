#!/bin/sh
# Restore only into an empty Compose project; never overwrite existing notes.
set -eu
cd "$(dirname "$0")/.."
# 可选：指定库。设置 MINDSYNC_LIBRARY=<库名> 时对该库操作；
# 不设置时使用默认 compose 项目（兼容单库用法）。
compose() {
    if [ -n "${MINDSYNC_LIBRARY:-}" ]; then
        if [ ! -f "libraries/$MINDSYNC_LIBRARY.env" ]; then
            echo "错误: 找不到 libraries/$MINDSYNC_LIBRARY.env" >&2
            return 1
        fi
        docker compose -p "mindsync-$MINDSYNC_LIBRARY" --env-file "libraries/$MINDSYNC_LIBRARY.env" "$@"
    else
        docker compose "$@"
    fi
}
SOURCE=${1:?Usage: scripts/restore.sh BACKUP_DIRECTORY}
[ -f "$SOURCE/COMPLETE" ] && { [ "$(cat "$SOURCE/COMPLETE")" = 'mindsync-backup-v1' ] || [ "$(cat "$SOURCE/COMPLETE")" = 'nas-sync-backup-v1' ]; }
(cd "$SOURCE" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c checksums.sha256; else shasum -a 256 -c checksums.sha256; fi)
if [ -n "$(compose ps --status running -q mindsync)" ]; then
  echo 'Stop the sync service before restoring; use a fresh Compose project.' >&2
  exit 1
fi
compose up -d postgres --wait >/dev/null
COUNT=$(compose exec -T postgres psql -U mindsync -d mindsync -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
if [ "$COUNT" != '0' ]; then
  echo 'Target database is not empty. Restore to a fresh COMPOSE_PROJECT_NAME.' >&2
  exit 1
fi
# Ensure the object root has no existing objects before unpacking.
compose run --rm -T --no-deps --entrypoint sh mindsync -ec '[ ! -d /data/objects ] || [ -z "$(find /data/objects -mindepth 1 -print -quit)" ]'
compose run --rm -T --no-deps --entrypoint tar mindsync -xzf - -C /data < "$SOURCE/objects.tar.gz"
compose exec -T postgres pg_restore -U mindsync -d mindsync --no-owner --exit-on-error < "$SOURCE/database.dump"
# A restore starts a new history branch. Rotate identity before any client can
# connect, even if later writes reuse the pre-restore revision numbers.
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U mindsync -d mindsync -c 'UPDATE vault SET id=gen_random_uuid()::text WHERE singleton' >/dev/null
compose up -d mindsync --wait >/dev/null
echo 'Restore complete. The sync service rebuilt its readable file tree.'
