#!/bin/sh
# Create a MindSync library.
#
#   One library = one server instance + one data directory + one admin token
#
# Usage:
#   sh scripts/add-library.sh <name> <port> <data-dir>
# Examples:
#   sh scripts/add-library.sh notes  8080 /vol1/1000/libraries/notes
#   sh scripts/add-library.sh zotero 8081 /vol1/1000/libraries/zotero
#
# Enter the library admin token and PostgreSQL password in your own terminal.
# Secrets are not echoed, logged, or generated; they are stored in libraries/<name>.env (mode 600).
set -eu
cd "$(dirname "$0")/.."

NAME=${1-}
PORT=${2-}
DIR=${3-}
NO_START=0
if [ "${4-}" = "--no-start" ]; then
    NO_START=1
fi

usage() {
    cat >&2 <<'TXT'
Usage: sh scripts/add-library.sh <name> <port> <data-dir> [--no-start]

  name        Lowercase letters, digits, and hyphens; e.g. notes / zotero
  port        Unique host port for this library; e.g. 8080 / 8081
  data-dir    Absolute path to a dedicated data directory; vault/ is the readable file tree.
  --no-start  Prepare directories and credentials without starting, for backup restoration.

Examples:
  sh scripts/add-library.sh notes  8080 /vol1/1000/libraries/notes
  sh scripts/add-library.sh zotero 8081 /vol1/1000/libraries/zotero
TXT
    exit 1
}

[ -n "$NAME" ] && [ -n "$PORT" ] && [ -n "$DIR" ] || usage

case "$NAME" in
    *[!a-z0-9-]*|""|-) echo "Error: library names may contain only lowercase letters, digits, and hyphens" >&2; exit 1 ;;
esac
case "$PORT" in
    *[!0-9]*|"") echo "Error: the port must be numeric" >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "Error: the port must be between 1 and 65535" >&2
    exit 1
fi
case "$DIR" in
    /*) ;;
    *) echo "Error: the data directory must be an absolute path" >&2; exit 1 ;;
esac

ENV_FILE="libraries/$NAME.env"
if [ -e "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE already exists. Review and remove it before recreating, or choose another library name." >&2
    exit 1
fi

# Library Compose project and container names.
# The first library uses project mindsync and containers mindsync / postgres.
# Later libraries use suffixes because container names must be unique on the host.
if [ -n "${MINDSYNC_PROJECT:-}" ]; then
    PROJECT=$MINDSYNC_PROJECT
else
    # Use a suffix when another library exists, excluding example.env.
    others=$(ls libraries/*.env 2>/dev/null | grep -v '/example\.env$' || true)
    if [ -z "$others" ]; then
        PROJECT="mindsync"
    else
        PROJECT="mindsync-$NAME"
    fi
fi
if [ "$PROJECT" = "mindsync" ]; then
    APP_CONTAINER="mindsync"
    PG_CONTAINER="postgres"
else
    APP_CONTAINER="$PROJECT"
    PG_CONTAINER="postgres-${PROJECT#mindsync-}"
fi

# Refuse an existing database volume: its saved password may differ from the new credentials.
if docker volume inspect "${PROJECT}_postgres_data" >/dev/null 2>&1; then
    echo "Error: volume ${PROJECT}_postgres_data already exists; library '$NAME' was previously deployed." >&2
    echo "      To redeploy, first remove the project (this deletes the library database):" >&2
    echo "        docker compose -p $PROJECT down -v" >&2
    exit 1
fi

# Check for occupied ports; each library needs a unique port.
if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$/"; then
        echo "Error: port $PORT is in use; choose another port" >&2
        exit 1
    fi
elif command -v netstat >/dev/null 2>&1; then
    if netstat -an 2>/dev/null | grep -qE "[.:]$PORT[[:space:]]+.*LISTEN"; then
        echo "Error: port $PORT is in use; choose another port" >&2
        exit 1
    fi
else
    echo "Note: ss/netstat was not found; skipping the port availability check." >&2
fi

# Allow only an empty directory or one previously created for this library.
MARKER="$DIR/.mindsync-library"
if [ -e "$MARKER" ]; then
    OWNER=$(cat "$MARKER")
    if [ "$OWNER" != "$NAME" ]; then
        echo "Error: $DIR belongs to library '$OWNER' and cannot be used for '$NAME'" >&2
        exit 1
    fi
fi
if [ ! -e "$MARKER" ] && [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    echo "Error: $DIR is not empty and was not created by this tool" >&2
    exit 1
fi

BIND=${MINDSYNC_BIND_ADDRESS:-0.0.0.0}
MAXBYTES=${MINDSYNC_MAX_FILE_BYTES:-52428800}

printf 'Library   : %s\n' "$NAME"
printf 'Port      : %s\n' "$PORT"
printf 'Data dir  : %s\n' "$DIR"
printf 'Project   : %s   (containers %s / %s)\n' "$PROJECT" "$APP_CONTAINER" "$PG_CONTAINER"
printf 'Bind IP   : %s\n\n' "$BIND"

read_secret() {
    if [ -t 0 ]; then stty -echo; fi
    IFS= read -r value || true
    if [ -t 0 ]; then stty echo; echo; fi
    printf %s "$value"
}

TOKEN=""
DBPW=""
attempt=0
while :; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 10 ]; then
        echo "Error: too many unsuccessful attempts; aborting." >&2
        exit 1
    fi
    printf 'Enter the library admin token (at least 32 characters; used to register devices): '
    TOKEN=$(read_secret)
    if [ "${#TOKEN}" -lt 32 ]; then
        printf 'Error: the admin token needs at least 32 characters; you entered %s. The server rejects shorter tokens. Try again.\n\n' "${#TOKEN}"
        continue
    fi
    printf 'Enter it again to confirm: '
    TOKEN2=$(read_secret)
    if [ "$TOKEN" != "$TOKEN2" ]; then
        printf 'Error: the values do not match. Try again.\n\n'
        continue
    fi
    if printf %s "$TOKEN" | grep -qE '[^A-Za-z0-9_.~!@%^&*+=:;,@-]'; then
        printf 'Error: the admin token allows only A-Za-z0-9 and - _ . ~ ! @ %% ^ & * + = : ; ,\n\n'
        continue
    fi
    break
done

attempt=0
while :; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 10 ]; then
        echo "Error: too many unsuccessful attempts; aborting." >&2
        exit 1
    fi
    printf 'Enter the library PostgreSQL password (any length): '
    DBPW=$(read_secret)
    if [ -z "$DBPW" ]; then
        printf 'Error: the password cannot be empty. Try again.\n\n'
        continue
    fi
    printf 'Enter it again to confirm: '
    DBPW2=$(read_secret)
    if [ "$DBPW" != "$DBPW2" ]; then
        printf 'Error: the values do not match. Try again.\n\n'
        continue
    fi
    if printf %s "$DBPW" | grep -qE '[^A-Za-z0-9_.~!@%^&*+=:;,@-]'; then
        printf 'Error: the database password allows only A-Za-z0-9 and - _ . ~ ! @ %% ^ & * + = : ; ,\n\n'
        continue
    fi
    break
done

mkdir -p "$DIR"

# Run the container as the data directory owner.
# Do not chown to the image UID 10001: fnOS storage ACLs may reject unknown users.
OWNER=$(stat -c '%u %g' "$DIR" 2>/dev/null || stat -f '%u %g' "$DIR" 2>/dev/null || echo "")
RUN_UID=$(printf '%s' "$OWNER" | awk '{print $1}')
RUN_GID=$(printf '%s' "$OWNER" | awk '{print $2}')
if [ -z "$RUN_UID" ] || [ -z "$RUN_GID" ]; then
    echo "Error: cannot read the owner of $DIR" >&2
    exit 1
fi
if [ "$RUN_UID" = "0" ]; then
    RUN_UID=10001
    RUN_GID=10001
    echo "Warning: $DIR is owned by root; using UID 10001. Prefer assigning the directory to your user first." >&2
fi
printf 'Container user: %s:%s (data directory owner)\n' "$RUN_UID" "$RUN_GID"

umask 077
{
    printf 'MINDSYNC_LIBRARY=%s\n' "$NAME"
    printf 'MINDSYNC_ADMIN_TOKEN=%s\n' "$TOKEN"
    printf 'POSTGRES_PASSWORD=%s\n' "$DBPW"
    printf 'MINDSYNC_BIND_ADDRESS=%s\n' "$BIND"
    printf 'MINDSYNC_PORT=%s\n' "$PORT"
    printf 'MINDSYNC_DATA_DIR=%s\n' "$DIR"
    printf 'MINDSYNC_RUN_UID=%s\n' "$RUN_UID"
    printf 'MINDSYNC_RUN_GID=%s\n' "$RUN_GID"
    printf 'MINDSYNC_PROJECT=%s\n' "$PROJECT"
    printf 'MINDSYNC_CONTAINER_NAME=%s\n' "$APP_CONTAINER"
    printf 'MINDSYNC_POSTGRES_CONTAINER_NAME=%s\n' "$PG_CONTAINER"
    printf 'MINDSYNC_MAX_FILE_BYTES=%s\n' "$MAXBYTES"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
printf '%s\n' "$NAME" > "$MARKER"
unset TOKEN TOKEN2 DBPW DBPW2

# Ensure the image exists, including with --no-start, because restore needs it.
if docker image inspect mindsync:latest >/dev/null 2>&1; then
    echo "Reusing the existing mindsync:latest image."
else
    echo "mindsync:latest was not found. Building it first (the initial Rust image and crate downloads may take time)."
    echo "Note: builds use --network=host because some NAS container DNS configurations cannot resolve build dependencies."
    if ! docker build --network=host -t mindsync:latest .; then
        echo "Error: image build failed." >&2
        exit 1
    fi
fi

if [ "$NO_START" = "1" ]; then
    cat <<SUMMARY

Library '$NAME' is prepared (not started).

  Data dir    : $DIR
  Credentials : $ENV_FILE              (mode 600)
  Start       : docker compose -p $PROJECT --env-file $ENV_FILE up -d

Use this empty library for scripts/restore.sh, or start it later.
SUMMARY
    exit 0
fi

echo "Starting $PROJECT ..."
# Do not use --wait: initial migrations and projection rebuilding may involve a restart.
# Compose may report failure too early; poll /health after starting instead.
if ! docker compose -p "$PROJECT" --env-file "$ENV_FILE" up -d; then
    echo >&2
    echo "Error: startup failed. Diagnose with: docker compose -p $PROJECT --env-file $ENV_FILE logs --tail 100" >&2
    exit 1
fi

printf 'Waiting for /health (initial startup may take a minute or two)... '
i=0
while [ "$i" -lt 120 ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        echo 'OK.'
        i=-1
        break
    fi
    i=$((i + 1))
    sleep 2
done
if [ "$i" != "-1" ]; then
    echo
    echo "Error: /health was not ready within 240 seconds. Diagnose with:" >&2
    echo "  docker compose -p $PROJECT --env-file $ENV_FILE ps" >&2
    echo "  docker compose -p $PROJECT --env-file $ENV_FILE logs --tail 100 mindsync" >&2
    exit 1
fi

cat <<SUMMARY

Library '$NAME' is ready.

  Server URL  : http://<NAS-IP>:$PORT        (local: http://127.0.0.1:$PORT)
  File tree   : $DIR/vault/
  History     : $DIR/objects/                  (do not delete manually)
  Credentials : $ENV_FILE                      (mode 600; back up separately, excluded by backup.sh)
  Containers  : $APP_CONTAINER / $PG_CONTAINER
  compose    : -p $PROJECT --env-file $ENV_FILE

Next: install the plugin in this vault, enter the server URL, and register using this library admin token.

Routine commands (always include -p to target the correct library):
  docker compose -p $PROJECT --env-file $ENV_FILE ps
  docker compose -p $PROJECT --env-file $ENV_FILE logs --tail 100 mindsync
  docker compose -p $PROJECT --env-file $ENV_FILE down
SUMMARY

if [ "$BIND" = "0.0.0.0" ]; then
    cat <<'NOTE'

Note: binding to 0.0.0.0 exposes this port to the local network. Review network access.
      Use an HTTPS reverse proxy with a valid certificate for internet access.
NOTE
fi
