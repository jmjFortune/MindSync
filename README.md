# Obsidian NAS Sync

自己的 NAS 同步服务：TypeScript Obsidian 插件 + Rust/Axum 服务端 + PostgreSQL。飞牛 NAS 通过 Docker Compose 部署，设备保留完整本地库，可离线编辑。面向 macOS、Windows 和 Android；第一版为单用户、单库、多设备。

## 当前交付

支持笔记、附件、版本历史、设备令牌、删除传播、稳定身份的重命名、断线重试和冲突副本。版本冲突保留双方内容；操作 ID 防止重复提交。NAS 保存不可变内容对象，PostgreSQL 保存版本和变更日志，可读 Markdown 文件树由它们重建。

Android 需要 Obsidian 在前台运行；应用关闭或被系统挂起时不承诺后台同步。默认排除隐藏目录、Obsidian 设置和插件自身数据。单文件默认上限 50 MiB，暂不支持分片续传、端到端加密、多人协作、WebDAV 或 RAG。历史对象暂不自动清理，会持续占用空间。可读文件树只供查看和导出，直接修改会在重建时丢弃。

## 部署与安装

完整步骤见 [飞牛部署说明](docs/deploy-fnos.md)。在装有 Docker Compose 的机器上先启动服务：

```sh
sh scripts/init-env.sh
# 编辑 .env，将 NAS_SYNC_BIND_ADDRESS 设置为 NAS 局域网 IP。
docker compose up -d --build --wait
```

初始化脚本生成随机管理令牌和 PostgreSQL 密码，保存在权限为 600 的 `.env` 中，不会打印。保持数据库密码为生成的十六进制字符串，避免连接 URI 中的特殊字符。每台设备在插件设置中填写服务地址，用管理令牌注册一次，之后使用独立设备令牌。

将安装包内 `nas-sync` 文件夹复制到本地库的 `.obsidian/plugins/`，或库自定义配置目录下的 `plugins/`。它包含 `main.js`、`manifest.json` 和 `styles.css`。在 Obsidian 社区插件设置中启用 NAS Sync。所有设备首次连接先预览同步计划，再确认合并。

## 开发

```sh
npm ci --prefix plugin
npm test --prefix plugin
npm run build --prefix plugin
cargo build --manifest-path server/Cargo.toml --locked
cargo clippy --manifest-path server/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path server/Cargo.toml -- --check
```

服务端集成测试需专用空 PostgreSQL 数据库。测试会建立 schema 并修改测试数据，不能指向生产库：

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/nas_sync_test cargo test --manifest-path server/Cargo.toml --locked
```

真实 HTTP 联调使用专用本地服务，会注册设备并创建测试笔记：

```sh
npm exec --prefix plugin -- esbuild scripts/integration.ts --bundle --platform=node --format=esm --outfile=plugin/dist/integration.mjs
set -a
. ./.env
set +a
node plugin/dist/integration.mjs
```

使用 `.env` 中的 `NAS_SYNC_PORT`；未设置时访问 `http://127.0.0.1:18080`。可用 `NAS_SYNC_TEST_URL` 指定本地地址。生成插件 ZIP 和不包含凭证、编译缓存的源码包：

```sh
npm run build --prefix plugin
node scripts/package.mjs
```

## 扩展

[协议](docs/protocol.md)使用文件身份、版本、对象哈希和变更游标，独立于存储位置。服务端内容存储接口预留后续 WebDAV、S3 和网盘实现；仍由 NAS 管理版本一致性。RAG 可通过快照、分页变更和对象下载 API 建立自己的索引，暂未实现索引器或专用 RAG 身份。

[设计](docs/superpowers/specs/2026-10-12-obsidian-nas-sync-design.md)与[验证记录](docs/verification.md)说明约束及已完成的测试。真实飞牛、Windows、Android 实机和外网通道需要进一步验收。
