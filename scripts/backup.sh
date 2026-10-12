#!/bin/sh
# Pause application writes; PostgreSQL remains up for a consistent dump.
set -eu
cd "$(dirname "$0")/.."
DEST=${1:-./backups/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$DEST"
chmod 700 "$DEST"
if [ -e "$DEST/COMPLETE" ] || [ -e "$DEST/database.dump" ]; then
  echo 'Destination must be unused.' >&2
  exit 1
fi
WAS_RUNNING=$(docker compose ps --status running -q server)
resume() {
  if [ -n "$WAS_RUNNING" ]; then docker compose start server >/dev/null; fi
}
trap resume EXIT
trap 'exit 130' HUP INT TERM
docker compose stop server >/dev/null
docker compose exec -T postgres pg_dump -U nas_sync -d nas_sync -Fc > "$DEST/database.dump"
docker compose run --rm -T --no-deps --entrypoint tar server -czf - -C /data objects > "$DEST/objects.tar.gz"
(cd "$DEST" && if command -v sha256sum >/dev/null 2>&1; then sha256sum database.dump objects.tar.gz; else shasum -a 256 database.dump objects.tar.gz; fi > checksums.sha256)
printf 'nas-sync-backup-v1\n' > "$DEST/COMPLETE"
echo "Backup complete: $DEST (credentials are not included)."
