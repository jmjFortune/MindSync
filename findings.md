# Technical findings

- Project: /Users/shiyun/Desktop/projects/MindSync, branch feat/docker-sync.
- User chose TypeScript + Rust/Axum/SQLx + PostgreSQL17; no Python/SQLite application dependencies.
- Plugin uses Obsidian Vault, Adapter and requestUrl without desktop Node/Electron dependencies.
- PostgreSQL and immutable objects live on local NAS disks; database port remains private.
- SHA-256 verified objects are authoritative alongside committed metadata; readable files are rebuildable projections.
- Independent review added regressions for stale tombstones, same-path replacement, casing, initial merge previews and interrupted writes.
- Restore rotates vault identity before accepting clients to separate history branches, including recycled revision numbers.
- Docker uses dedicated mindsync UID/GID10001; image and healthy Compose startup verified.
- Real HTTP sync and PostgreSQL/object backup restoration verified.
- Actual Windows/macOS Obsidian UI, Android hardware and external access remain unverified.
- fnOS acceptance (2026-10-12): build on the NAS needs `docker build --network=host` because the container resolver is unreachable from build containers there; containers must run as the data directory's owner because the storage layer denies unknown uids (10001) write access even after chown; the first start needs a longer health start period and a self-polled `/health` instead of `compose up --wait`.
- Libraries: one library equals one compose project plus one data directory plus one admin token. The first library uses unsuffixed names (project `mindsync`, containers `mindsync`/`postgres`); later libraries must be suffixed because container names are host-unique. `backup.sh`/`restore.sh` read the project name from the library env.

2026-10-13 分块实施：版本清单必须随 rename/delete 版本保留；GC 必须同时保护旧格式 changes.hash 和 version_chunks，不能仅统计分块引用。服务端 writer 锁用于提交与 GC/块发布互斥。现有客户端 Vault.readBinary/createBinary 需要整文件内存，50 MiB 上限保留，阶段 4 真流式延后。FastCDC 分块与摘要使用 Web Crypto，候选保留不可变 bytes/清单。本地 Docker daemon 未启动。

v2 实现细化：清单顺序由 JSON 数组索引定义，存入 version_chunks 和 changes.record。rename/delete 原样保留清单。旧请求新增 Option 字段序列化时 skip None，避免破坏已有幂等 fingerprint。单块候选通过 chunks API 去重，但仍提交整对象 FileRecord，空文件同样保留旧记录。GC 默认预览，保护所有旧历史对象及块引用，missing/重试发布续期；并发上传失败后须等待其它 worker 结束才能释放连接隔离。实际整个文件内存/哈希问题明确留到阶段 4，不能宣称已解决。用户最新低负载约束优先，全部执行验收延后。

NAS v2 验证继续：原 notes 是空库，升级前备份成功且本地迁移恢复健康；本地 73 插件/15 PG/9 HTTP、真实 SIGKILL（headless磁盘Vault，实际双槽）、30 秒模拟断网、有效 PDF 三版本 35.81245%、GC 老化保护通过。测试 vault 已安装 0.2.0，GUI 权限 pending 未操作。NAS UID/GID 1000:1001。原首份 Mac tar 包产生 ._0001_initial.sql 导致单 job release 宏失败；当前包和 Dockerignore 双重排除 AppleDouble，BuildKit registry/target caches locked，第二次远端构建 session46312。隔离 NAS 资源：mindsync-v2-verification 网络、mindsync-v2-verification-pg、/vol1/1000/libraries/.mindsync-v2-verification。生产 notes 尚未切换、未运行 GC、LiveSync 未触碰。

2026-10-13 收尾：NAS 单 job release 成功，隔离验收在 NAS Node loopback 执行（sshd 拒绝 forwarding，不修改权限）。阶段 1–3 的 HTTP/PDF/GC/实际进程 SIGKILL/30 秒模拟断网均通过。生产 notes 0.2.0 健康，库身份/游标/对象量不变，原设备 token 可用；旧镜像与最终备份保留。之前构建中/未启动 Docker/验收延后的记录为历史状态。真实 GUI/Android 与整文件内存优化仍未完成。

Configuration-sync design: Vault TFile enumeration excludes the configuration directory, so an explicit DataAdapter adapter is needed. Ordinary old clients currently accept all incoming snapshot paths; server-side scope filtering is needed before publishing configuration records. Add default notes scope without changing old request fingerprints, separate configuration routes and projection, capability flag under protocol 2, and independent configuration journals. DataAdapter.process supports conditional JSON replacement; binary groups need durable backups and staged application. LiveSync guidance supports separate opt-in selection and explicit initial direction. UI remains English and existing conflict/history behavior stays unchanged.
