#!/bin/sh
# 新增一个 MindSync 库。
#
#   一个库 = 一个服务端实例 + 一个独立数据目录 + 一个管理令牌
#
# 用法:
#   sh scripts/add-library.sh <库名> <端口> <数据目录>
# 例:
#   sh scripts/add-library.sh notes  8080 /vol1/1000/libraries/notes
#   sh scripts/add-library.sh zotero 8081 /vol1/1000/libraries/zotero
#
# 脚本会提示输入该库的管理令牌与 PostgreSQL 密码：只在你自己的终端里输入，
# 不回显、不打印、不写入日志、不随机生成。凭据只落在 libraries/<库名>.env（权限 600）。
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
用法: sh scripts/add-library.sh <库名> <端口> <数据目录> [--no-start]

  库名      小写字母、数字和短横线，例如 notes / zotero
  端口      该库在宿主机发布的端口，各库不得重复，例如 8080 / 8081
  数据目录  该库的独立数据目录（绝对路径）。其下 vault/ 是可读文件树。
  --no-start  只准备数据目录与凭据文件，不启动。用于先建空库再恢复备份。

例:
  sh scripts/add-library.sh notes  8080 /vol1/1000/libraries/notes
  sh scripts/add-library.sh zotero 8081 /vol1/1000/libraries/zotero
TXT
    exit 1
}

[ -n "$NAME" ] && [ -n "$PORT" ] && [ -n "$DIR" ] || usage

case "$NAME" in
    *[!a-z0-9-]*|""|-) echo "错误: 库名只能包含小写字母、数字和短横线" >&2; exit 1 ;;
esac
case "$PORT" in
    *[!0-9]*|"") echo "错误: 端口必须是数字" >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "错误: 端口必须在 1-65535 之间" >&2
    exit 1
fi
case "$DIR" in
    /*) ;;
    *) echo "错误: 数据目录必须是绝对路径" >&2; exit 1 ;;
esac

ENV_FILE="libraries/$NAME.env"
if [ -e "$ENV_FILE" ]; then
    echo "错误: $ENV_FILE 已存在。要重建请先确认并删除它，或换一个库名。" >&2
    exit 1
fi

# 该库若曾部署过，数据库卷里存着旧口令；此处必须拦住，避免启动后一直认证失败。
if docker volume inspect "mindsync-${NAME}_postgres_data" >/dev/null 2>&1; then
    echo "错误: 已存在数据卷 mindsync-${NAME}_postgres_data，说明库 '$NAME' 曾部署过。" >&2
    echo "      要重新部署，请先删除该项目（会清空该库的数据库内容）：" >&2
    echo "        docker compose -p mindsync-$NAME down -v" >&2
    exit 1
fi

# 端口占用检查（各库端口不得重复）
if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$/"; then
        echo "错误: 端口 $PORT 已被占用，请换一个端口" >&2
        exit 1
    fi
elif command -v netstat >/dev/null 2>&1; then
    if netstat -an 2>/dev/null | grep -qE "[.:]$PORT[[:space:]]+.*LISTEN"; then
        echo "错误: 端口 $PORT 已被占用，请换一个端口" >&2
        exit 1
    fi
else
    echo "提示: 未找到 ss/netstat，跳过端口占用检查。" >&2
fi

# 数据目录检查：只允许空目录，或本工具先前为该库创建的目录
MARKER="$DIR/.mindsync-library"
if [ -e "$MARKER" ]; then
    OWNER=$(cat "$MARKER")
    if [ "$OWNER" != "$NAME" ]; then
        echo "错误: $DIR 已属于库 '$OWNER'，不能给 '$NAME' 使用" >&2
        exit 1
    fi
fi
if [ ! -e "$MARKER" ] && [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    echo "错误: $DIR 已存在且非空，且不是本工具创建的库目录" >&2
    exit 1
fi

BIND=${MINDSYNC_BIND_ADDRESS:-0.0.0.0}
MAXBYTES=${MINDSYNC_MAX_FILE_BYTES:-52428800}

printf '库名      : %s\n' "$NAME"
printf '端口      : %s\n' "$PORT"
printf '数据目录  : %s\n' "$DIR"
printf '项目名    : mindsync-%s\n' "$NAME"
printf '监听地址  : %s\n\n' "$BIND"

read_secret() {
    if [ -t 0 ]; then stty -echo; fi
    IFS= read -r value || true
    if [ -t 0 ]; then stty echo; echo; fi
    printf %s "$value"
}

printf '请输入该库的管理令牌（至少 32 位；注册设备时使用）: '
TOKEN=$(read_secret)
printf '请再输入一次确认: '
TOKEN2=$(read_secret)
printf '请输入该库的 PostgreSQL 密码: '
DBPW=$(read_secret)
printf '请再输入一次确认: '
DBPW2=$(read_secret)

[ -n "$TOKEN" ] || { echo "错误: 管理令牌不能为空" >&2; exit 1; }
[ "$TOKEN" = "$TOKEN2" ] || { echo "错误: 两次输入的管理令牌不一致" >&2; exit 1; }
if [ "${#TOKEN}" -lt 32 ]; then
    echo "错误: 管理令牌至少需要 32 位" >&2
    exit 1
fi
[ -n "$DBPW" ] || { echo "错误: 数据库密码不能为空" >&2; exit 1; }
[ "$DBPW" = "$DBPW2" ] || { echo "错误: 两次输入的数据库密码不一致" >&2; exit 1; }

# 拒绝会破坏 env 文件与连接 URI 的字符，避免转义问题
if printf %s "$TOKEN$DBPW" | grep -qE '[^A-Za-z0-9_.~!@%^&*+=:;,@-]'; then
    echo "错误: 管理令牌与数据库密码只允许 A-Za-z0-9 以及  - _ . ~ ! @ % ^ & * + = : ; ,  这些字符" >&2
    exit 1
fi

mkdir -p "$DIR"

# 数据目录的属主：容器以该身份运行。
# 不 chown 成镜像内置的 10001 —— 飞牛等存储层只放行已知用户，未知 uid 会因 ACL 写入失败。
OWNER=$(stat -c '%u %g' "$DIR" 2>/dev/null || stat -f '%u %g' "$DIR" 2>/dev/null || echo "")
RUN_UID=$(printf '%s' "$OWNER" | awk '{print $1}')
RUN_GID=$(printf '%s' "$OWNER" | awk '{print $2}')
if [ -z "$RUN_UID" ] || [ -z "$RUN_GID" ]; then
    echo "错误: 无法读取 $DIR 的属主" >&2
    exit 1
fi
if [ "$RUN_UID" = "0" ]; then
    RUN_UID=10001
    RUN_GID=10001
    echo "警告: $DIR 属主是 root；将改以 10001 运行。建议先把该目录改归你的账号所有。" >&2
fi
printf '容器运行身份: %s:%s（数据目录属主）\n' "$RUN_UID" "$RUN_GID"

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
    printf 'MINDSYNC_MAX_FILE_BYTES=%s\n' "$MAXBYTES"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
printf '%s\n' "$NAME" > "$MARKER"
unset TOKEN TOKEN2 DBPW DBPW2

# 确保镜像存在。--no-start 时也要：随后的 restore 会用到该镜像。
if docker image inspect mindsync:latest >/dev/null 2>&1; then
    echo "复用已有镜像 mindsync:latest。"
else
    echo "未找到镜像 mindsync:latest，先构建（首次需拉取 Rust 基础镜像与 crates，较慢）。"
    echo "注: 构建使用 --network=host —— 部分 NAS 的容器默认 DNS 不可用，构建容器会解析失败。"
    if ! docker build --network=host -t mindsync:latest .; then
        echo "错误: 镜像构建失败。" >&2
        exit 1
    fi
fi

if [ "$NO_START" = "1" ]; then
    cat <<SUMMARY

库 '$NAME' 已准备完成（未启动）。

  数据目录   : $DIR
  凭据文件   : $ENV_FILE              （权限 600）
  启动       : docker compose -p mindsync-$NAME --env-file $ENV_FILE up -d

用途: 先准备一个空库，再用 scripts/restore.sh 恢复备份，或稍后再启动。
SUMMARY
    exit 0
fi

PROJECT="mindsync-$NAME"
echo "正在启动 $PROJECT ..."
# 不使用 --wait: 首次启动含数据库迁移与可读文件树重建，容器可能经历一次重启，
# compose 会在此时判定失败。改为启动后自行轮询 /health。
if ! docker compose -p "$PROJECT" --env-file "$ENV_FILE" up -d; then
    echo >&2
    echo "错误: 启动失败。排查: docker compose -p $PROJECT --env-file $ENV_FILE logs --tail 100" >&2
    exit 1
fi

printf '等待该库 /health 就绪（首次可能需要一两分钟）... '
i=0
while [ "$i" -lt 120 ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        echo '通过。'
        i=-1
        break
    fi
    i=$((i + 1))
    sleep 2
done
if [ "$i" != "-1" ]; then
    echo
    echo "错误: /health 未在 240 秒内通过。排查:" >&2
    echo "  docker compose -p $PROJECT --env-file $ENV_FILE ps" >&2
    echo "  docker compose -p $PROJECT --env-file $ENV_FILE logs --tail 100 mindsync" >&2
    exit 1
fi

cat <<SUMMARY

库 '$NAME' 已就绪。

  服务地址   : http://<NAS 地址>:$PORT        （本机: http://127.0.0.1:$PORT）
  可读文件树 : $DIR/vault/
  历史内容   : $DIR/objects/                  （不要手动删除）
  凭据文件   : $ENV_FILE                      （权限 600，备份脚本不包含它，请另行备份）
  compose    : -p mindsync-$NAME --env-file $ENV_FILE

下一步：在对应的 vault 里安装插件 → 填服务地址 → 用该库的管理令牌注册设备。

日常操作（务必带 -p，避免误操作到其它库）:
  docker compose -p mindsync-$NAME --env-file $ENV_FILE ps
  docker compose -p mindsync-$NAME --env-file $ENV_FILE logs --tail 100 mindsync
  docker compose -p mindsync-$NAME --env-file $ENV_FILE down
SUMMARY

if [ "$BIND" = "0.0.0.0" ]; then
    cat <<'NOTE'

注意: 监听地址为 0.0.0.0，该端口会向所在网络开放。请确认网络边界，
      外网访问必须使用有效证书的 HTTPS 反向代理，不要直接暴露本端口。
NOTE
fi
