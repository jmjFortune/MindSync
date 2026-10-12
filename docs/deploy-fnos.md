# 飞牛 NAS 部署

## 1. 部署一个库

一个**库** = 一个服务端实例 + 一个独立数据目录 + 一个管理令牌。笔记库和文献附件库是两个库，互不影响；以后新增来源也只是再加一个库。需要飞牛上可用的 Docker 与 Docker Compose v2。

### 1.1 准备源码

将源码包解压到 NAS 本地磁盘，例如 `docker/mindsync`，通过终端进入该目录。首次构建需能下载 Rust crates 与 Docker 镜像，构建较慢属于正常现象。

### 1.2 新建第一个库

```sh
sh scripts/add-library.sh notes 8080 /vol1/1000/libraries/notes
```

脚本会提示输入该库的**管理令牌**（至少 32 位）与 **PostgreSQL 密码**：只在你自己的终端里输入，不回显、不打印、不随机生成。随后它完成：创建数据目录 → 生成 `libraries/notes.env`（权限 600）→ 首次构建镜像 → 启动 → 自行轮询 `/health` 直至就绪。

**命名规则**：第一个库使用干净名字 —— compose 项目 `mindsync`、容器 `mindsync` 与 `postgres`；之后新增的库自动加后缀（项目 `mindsync-<库名>`、容器 `mindsync-<库名>` 与 `postgres-<库名>`），因为容器名在宿主机上必须唯一。名称写在 `libraries/<库名>.env` 的 `MINDSYNC_PROJECT` / `MINDSYNC_CONTAINER_NAME` / `MINDSYNC_POSTGRES_CONTAINER_NAME` 里，可手工覆盖。

写成 env 的 `MINDSYNC_RUN_UID/GID` 决定容器运行身份，取值为**数据目录的属主**。飞牛等存储层只放行已知用户：若把目录强行改归镜像内置的 `10001`，容器会因 ACL 而以 `Permission denied` 启动失败。因此不要手工 chown 该目录。

### 1.3 再加一个库（例如以后接入文献附件）

```sh
sh scripts/add-library.sh zotero 8081 /vol1/1000/libraries/zotero
```

各库必须使用**互不相同**的 `MINDSYNC_PORT` 与 `MINDSYNC_DATA_DIR`。所有库命令都要显式带 `-p mindsync-<库名>`；脚本与文档一律如此，缺少 `-p` 会误操作到其它库。

### 1.4 库的数据目录

`objects/`（不可变历史内容）、`vault/`（最新可读文件树）与 `tmp/`（上传临时文件）。`vault/` 只供查看和导出：直接修改不会同步给设备，并会在重启修复时丢弃。不要手动删除 `objects/`。历史版本暂不自动清理。数据库端口不对宿主机发布；一个数据目录只能被一个实例挂载。

### 1.5 首次启动可能较慢

首次启动要执行数据库迁移与可读文件树重建，慢盘上可能超过镜像默认的健康检查起算期。`add-library.sh` 因此不使用 `--wait`，而是启动后自行轮询 `/health`（最长 240 秒）。compose 层面的健康检查起算期已在 `compose.yaml` 调整为 120 秒。

### 1.6 构建期 DNS（部分 NAS 必需）

若构建时报 `Could not resolve host: deb.debian.org` 或 `index.crates.io`，而宿主机解析正常，说明**容器默认 DNS 在该 NAS 上不可用**（容器 `/etc/resolv.conf` 里的解析器不可达）。这与镜像源无关。构建改用宿主网络即可：

```sh
docker build --network=host -t mindsync:latest .
```

`add-library.sh` 已内置该参数。

### 1.7 旧的单库方式（仍可用，推荐改用上面的库）

```sh
sh scripts/init-env.sh
# 编辑 .env：MINDSYNC_BIND_ADDRESS 设为 NAS 的局域网 IP，MINDSYNC_PORT 选未占用端口
docker compose up -d --build --wait
```

此方式默认使用项目命名卷，`vault/` 不便在文件管理器中浏览；多库场景请使用 `add-library.sh`。

## 2. 安装客户端

每台设备建立或选择本地 Obsidian 库，将安装包内 `mindsync/` 放入该库 `.obsidian/plugins/`。自定义配置目录使用对应的 `plugins/` 子目录。Android 可通过 USB、系统文件管理器或 NAS 文件共享复制；文件复制后重启 Obsidian。

在社区插件设置中启用 MindSync，打开插件设置：

1. 填写该库的地址，例如笔记库的 `http://NAS局域网IP:8080`，为设备起不同名称，例如 `Mac`、`Windows`、`Android-phone`、`Android-tablet`。
2. 在“注册此设备”输入该库 `libraries/<库名>.env` 中的 `MINDSYNC_ADMIN_TOKEN`，点击注册。管理令牌不保存在插件配置中。
3. 点击测试连接，再预览同步计划。两端都有内容时确认首次合并，冲突副本会保留本地内容。
4. 在其余设备重复注册，使用各自独立的设备令牌。

插件在编辑停止约 1 秒后上传，在前台每 5 秒检查远端。命令面板提供立即同步、预览、状态、暂停和历史恢复。Android 返回前台时触发同步；关闭或挂起应用后没有独立后台服务。隐藏文件、`.obsidian`、插件配置不参与同步；设备令牌仅在本地配置中。

先用测试库验证笔记、附件、离线并发编辑、删除和重命名，再接入重要笔记。操作前保留本地库备份。冲突副本是普通文件，会同步到其他设备；合并后可以自行删除。

## 3. 外网连接

Docker 不会自动建立外网入口。先验收局域网，再选择自己的 VPN、反向代理或已有安全隧道。FN Connect 是否能转发任意 Docker HTTP 服务取决于实际能力，不能把它当作已经具备的入口。

互联网访问应配置有效证书的 HTTPS，随后所有插件使用该 HTTPS 地址。反向代理需允许至少 50 MiB 的请求体并设置足够上传超时；调大服务端单文件上限时同时调整代理限制。不要通过忽略证书错误解决连接失败，也不要直接公开 PostgreSQL。

## 4. 备份与恢复

备份脚本暂停应用写入，导出数据库和不可变对象，再恢复原先运行的应用。同步期间其他设备可能短暂报网络错误，随后会重试。

```sh
# 单库（旧方式）
sh scripts/backup.sh

# 指定库：用该库的名字，备份前请确认库名正确
MINDSYNC_LIBRARY=notes sh scripts/backup.sh

# 或指定一个全新的备份目录
MINDSYNC_LIBRARY=notes sh scripts/backup.sh /实际备份路径/2026-10-12
```

> 不设置 `MINDSYNC_LIBRARY` 时脚本使用默认 compose 项目（兼容旧的单库方式）。多库部署下**务必**带上库名，否则会备份错库。

只有带 `COMPLETE` 标记且校验通过的备份才完整。它不包含 `.env`；另外安全备份管理令牌、数据库密码及部署配置。备份内含笔记正文和设备令牌哈希，应限制目录权限并复制到另一块介质。单独备份 Markdown、数据库卷或 objects 均不足以恢复完整版本库。

恢复到**全新的库和空数据目录**，禁止覆盖已有库。先准备目标库（`--no-start` 只建目录与凭据、不启动）：

```sh
sh scripts/add-library.sh notes-restored 8081 /vol1/1000/libraries/notes-restored --no-start
MINDSYNC_LIBRARY=notes-restored sh scripts/restore.sh /实际备份目录
```

旧单库方式仍可用：`COMPOSE_PROJECT_NAME=mindsync-restored MINDSYNC_PORT=8081 sh scripts/restore.sh /实际备份目录`。管理令牌可重新生成；原设备令牌的哈希在数据库备份中，因此恢复后原设备令牌仍然有效。

新库会使用独立数据目录与独立数据库卷。确认健康、笔记和历史正确后，再切换插件地址或反向代理。恢复保留备份时的文件版本和游标，但更换 vault ID 表示新的历史分支，应用启动会重建 `vault/`。现有客户端会报告库身份不匹配并停止，避免旧游标跳过恢复后的内容。先完整保留原本地库，再建立新的本地库连接恢复后的服务；需要保留备份之后的编辑时，将原库内容复制到新库并预览合并。不要通过删除原库状态文件强行接续。不要在恢复验收完成前删除原库。

## 5. 更新与设备撤销

更新前先执行备份，然后在源码目录用新源码重建并重启该库：`docker compose -p mindsync-<库名> --env-file libraries/<库名>.env up -d --build`。数据库迁移由服务启动自动执行；旧版本回退可能不兼容新 schema，回退应使用更新前的完整备份。

设备丢失时用管理令牌调用 `GET /v1/devices`，找到设备 ID，再调用 `DELETE /v1/devices/{id}`；见[协议](protocol.md)。撤销即时拒绝该设备后续请求。管理令牌泄露时更改该库的 `libraries/<库名>.env` 并重建容器；已注册设备令牌仍可使用，必要时逐个撤销。

故障定位先看 `docker compose -p mindsync-<库名> --env-file libraries/<库名>.env ps` 与 `... logs --tail 100 mindsync`。对象缺失、校验失败或数据库不可用时服务应明确报错；不要删除客户端状态文件来“修复”，这会失去删除和离线队列基线。恢复插件目录备份，或者创建新的本地库重新连接。

装有 Node.js 的管理电脑也可使用辅助脚本。通过环境变量读取凭证，脚本不打印令牌：

```sh
set -a
. ./libraries/notes.env
set +a
export MINDSYNC_URL=http://NAS局域网IP:8080
node scripts/devices.mjs list
node scripts/devices.mjs revoke 从列表选出的设备ID
```

## 6. 目录大小写重命名

例如 `Notes/` 改为 `notes/` 时，插件先把该目录内已同步文件的远端身份迁入唯一的 `MindSync Rename ...` 临时目录，全部确认后再迁入目标目录。文件身份不变，过程可恢复，但其他设备可能短暂看到临时目录。重命名期间其他设备在旧目录新建文件时会报告路径冲突并保留待同步计划；先解决新文件的目录归属再重试。不要手动删除临时目录来结束迁移。
