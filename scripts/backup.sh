#!/bin/sh
# Pause application writes; PostgreSQL remains up for a consistent dump.
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
DEST=${1:-./backups/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$DEST"
chmod 700 "$DEST"
if [ -e "$DEST/COMPLETE" ] || [ -e "$DEST/database.dump" ]; then
  echo 'Destination must be unused.' >&2
  exit 1
fi
WAS_RUNNING=$(compose ps --status running -q mindsync)
resume() {
  if [ -n "$WAS_RUNNING" ]; then compose start mindsync >/dev/null; fi
}
trap resume EXIT
trap 'exit 130' HUP INT TERM
compose stop mindsync >/dev/null
compose exec -T postgres pg_dump -U mindsync -d mindsync -Fc > "$DEST/database.dump"
compose run --rm -T --no-deps --entrypoint tar mindsync -czf - -C /data objects > "$DEST/objects.tar.gz"
(cd "$DEST" && if command -v sha256sum >/dev/null 2>&1; then sha256sum database.dump objects.tar.gz; else shasum -a 256 database.dump objects.tar.gz; fi > checksums.sha256)
printf 'mindsync-backup-v1\n' > "$DEST/COMPLETE"
echo "Backup complete: $DEST (credentials are not included)."
