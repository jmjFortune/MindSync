# MindSync

自己的 NAS 同步服务：TypeScript Obsidian 插件 + Rust/Axum 服务端 + PostgreSQL。飞牛 NAS 通过 Docker Compose 部署，设备保留完整本地库，可离线编辑。面向 macOS、Windows 和 Android；第一版为单用户、单库、多设备。

## 当前交付

支持笔记、附件、版本历史、设备令牌、删除传播、稳定身份的重命名、断线重试和冲突副本。版本冲突保留双方内容；操作 ID 防止重复提交。NAS 保存不可变内容对象，PostgreSQL 保存版本和变更日志，可读 Markdown 文件树由它们重建。

Android 需要 Obsidian 在前台运行；应用关闭或被系统挂起时不承诺后台同步。笔记同步默认排除隐藏目录；0.3.0 新增独立的设置和插件同步，按设备启用并按项选择，收到更新后预览应用。MindSync 自身凭据/日志与 workspace 文件保持本机独立。单文件默认上限 50 MiB，v2 支持内容分块、跨版本去重和未提交候选的断点续传，本地与 NAS 验证结果见验证记录。暂不支持端到端加密、多人协作、WebDAV 或 RAG。历史对象不自动清理；手动 GC 只回收超过宽限期的无引用对象，保留所有历史版本。可读文件树只供查看和导出，直接修改会在重建时丢弃。

## 网络访问与隐私

插件**只连接一个地址**：你在 MindSync 设置页里自己填写的自建服务地址（`Server` 字段，例如 `https://notes.example.com` 或 `http://192.168.1.10:8080`）。代码中没有任何硬编码的第三方服务地址，唯一出现的 URL 是设置页的输入示例占位符。

联网只用于你要求的同步操作：注册设备并获取设备令牌、拉取/推送笔记与附件、查询版本历史与冲突副本、按项同步 Obsidian 设置与插件包、以及查看同步状态。所有请求都带设备令牌发往该地址下的 `/v1/*` 路由，协议见[协议说明](docs/protocol.md)。

- 不使用任何第三方或中转服务，不发送遥测，不含广告，不自更新，不下载并执行远程代码。
- 设备令牌、连接设置、状态日志与保留副本只保存在本机的配置目录（`plugins/mindsync/`）内，不参与设置与插件同步。
- 你的笔记、附件与服务端数据都留在你自己的 NAS 上；本插件不收集、不上传任何内容到作者或任何第三方。
- 未右键任何文件、未打开同步前不会产生请求；暂停自动同步后立即停止轮询，仍可在面板里手动操作。

**Network access（English summary）**：MindSync talks only to the self-hosted server URL entered by the user in its settings, under that server's `/v1/*` routes, using a device token. Network access is required to register devices and to sync notes, attachments, version history, conflict copies, and the opt-in Obsidian settings/plugin sync. The plugin contains no hardcoded third-party endpoints, no telemetry, no ads, no self-update, and no remotely loaded code. Credentials and state stay in the vault's config directory; all synced content stays on the user's own NAS.

## 部署与安装

完整步骤见 [飞牛部署说明](docs/deploy-fnos.md)。服务按**库**组织：一个库 = 一个服务端实例 + 一个独立数据目录 + 一个管理令牌。各库独立保存数据。目前已接入 Obsidian，库名为 obsidian；Zotero 客户端尚未实现，下方命令只展示如何部署独立文献库服务。

```sh
sh scripts/add-library.sh obsidian 8080 /vol1/1000/libraries/obsidian
```

脚本会提示输入该库的管理令牌与 PostgreSQL 密码（只在你自己的终端里输入，不随机生成、不打印），随后建目录、构建镜像、启动并等待 `/health`。再加一个库：

```sh
sh scripts/add-library.sh zotero 8081 /vol1/1000/libraries/zotero
```

各库必须使用不同的端口与数据目录，所有库命令都要显式带 `-p`（第一个库的项目名就是 `mindsync`，其余见 `libraries/<库名>.env` 里的 `MINDSYNC_PROJECT`）。`vault/` 是该库最新的**可读文件树**，可在飞牛文件管理器中直接浏览；它只供查看与导出，直接修改不会同步给设备。

旧的单库方式（`sh scripts/init-env.sh` + `.env` + `docker compose up -d --build --wait`）仍然可用，详见部署说明。

将安装包内 `mindsync` 文件夹复制到本地库的 `.obsidian/plugins/`，或库自定义配置目录下的 `plugins/`。它包含 `main.js`、`manifest.json` 和 `styles.css`。在 Obsidian 社区插件设置中启用 MindSync。所有设备首次连接先预览同步计划，再确认合并。

也可以用 BRAT（`jmjFortune/MindSync`）从 GitHub 安装并自动跟随新版本。0.3.6 起仓库根目录保留与 `plugin/manifest.json` 同步的 `manifest.json`，Release 标签与 manifest 版本号一致（形如 `0.3.6`），满足社区目录的安装与更新要求。

## 设置和插件同步（0.3.0）

先重载插件，再打开 MindSync → **Settings and plugins → Manage**。每台设备打开 **Sync settings and plugins**，选择 Obsidian 设置、主题、CSS snippets 和需要同步的插件。每个插件的 data.json 设置独立勾选，默认不选；可能包含账号/API keys。Enabled plugin list 也是独立选项，只启用已安装、所选且兼容的插件，并保留本机 MindSync 和未选择插件的启用状态。

来源设备点击 **Publish this device → Publish selected**；其他设备点击 **Review remote settings → Apply selected**。并发差异可选 **Keep local / Use remote**，原内容保存在本机恢复目录。插件文件整组校验与应用，未完成的远端包需等待来源端续传。应用后重载 Obsidian。配置前台每 30 秒检查，收到更新始终等待确认；暂停自动同步后仍可手动操作。第一次发布/接收前不会自动上传。

取消选择、移除本机插件或缺少可选 CSS 不会自动卸载其他设备的插件。workspace、LiveSync 配置、MindSync 的令牌/状态及缓存不参与同步。功能默认关闭，旧设备只同步笔记。NAS `configuration/` 是单独的可读配置投影，备份仍是数据库和不可变 objects。实际 GUI/移动端验收边界见[验证记录](docs/verification.md)。

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
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mindsync_test cargo test --manifest-path server/Cargo.toml --locked
```

真实 HTTP 联调使用专用本地服务，会注册设备并创建测试笔记：

```sh
npm exec --prefix plugin -- esbuild scripts/integration.ts --bundle --platform=node --format=esm --outfile=plugin/dist/integration.mjs
set -a
. ./.env
set +a
node plugin/dist/integration.mjs
```

使用 `.env` 中的 `MINDSYNC_PORT`；未设置时访问 `http://127.0.0.1:18080`。可用 `MINDSYNC_TEST_URL` 指定本地地址。生成插件 ZIP 和不包含凭证、编译缓存的源码包：

```sh
npm run build --prefix plugin
node scripts/package.mjs
```

## 分块与手动回收

协议 v2 默认 FastCDC 16/64/256 KiB，64 KiB 以下单块。客户端保存不可变候选和清单，恢复后只上传服务器缺失的块；已经提交的操作先从幂等台账确认。单块请求 30 秒超时，最多 3 个块并行，可从命令面板打开 MindSync: View status and conflicts 查看进度。插件仍使用整文件 Vault 读写，单文件默认 50 MiB。

GC 仅供管理端手动触发，默认预览。按部署说明载入相应库凭据，并设置 `MINDSYNC_URL` 后：

```sh
node scripts/gc.mjs         # 只预览
node scripts/gc.mjs --apply # 删除超过默认 7 天宽限期且没有任何版本引用的对象
```

v2 必须先完成测试与备份，再同步升级服务端和插件。0.2.0 已通过本地与 NAS 隔离验收，现有 NAS Obsidian 库服务已升级；具体证据与硬件验收边界见[验证记录](docs/verification.md)。

## 扩展

[协议](docs/protocol.md)使用文件身份、版本、对象哈希和变更游标，独立于存储位置。服务端内容存储接口预留后续 WebDAV、S3 和网盘实现；仍由 NAS 管理版本一致性。RAG 可通过快照、分页变更和对象下载 API 建立自己的索引，暂未实现索引器或专用 RAG 身份。

[设计](docs/designs/2026-10-12-mindsync-design.md)与[验证记录](docs/verification.md)说明约束及已完成的测试。真实飞牛、Windows、Android 实机和外网通道需要进一步验收。实施计划见 [docs/plans](docs/plans)。

各版本的插件行为变化见[更新记录](CHANGELOG.md)；当前插件版本 0.3.6。
