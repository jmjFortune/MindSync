# MindSync

自己的 NAS 同步服务：TypeScript Obsidian 插件 + Rust/Axum 服务端 + PostgreSQL。飞牛 NAS 通过 Docker Compose 部署，设备保留完整本地库，可离线编辑。面向 macOS、Windows 和 Android；第一版为单用户、单库、多设备。

## 当前交付

支持笔记、附件、版本历史、设备令牌、删除传播、稳定身份的重命名、断线重试和冲突副本。版本冲突保留双方内容；操作 ID 防止重复提交。NAS 保存不可变内容对象，PostgreSQL 保存版本和变更日志，可读 Markdown 文件树由它们重建。

Android 需要 Obsidian 在前台运行；应用关闭或被系统挂起时不承诺后台同步。笔记同步默认排除隐藏目录；0.3.0 新增独立的设置和插件同步，按设备启用并按项选择，收到更新后预览应用。MindSync 自身凭据/日志与 workspace 文件保持本机独立。单文件默认上限 50 MiB，v2 支持内容分块、跨版本去重和未提交候选的断点续传，本地与 NAS 验证结果见验证记录。暂不支持端到端加密、多人协作、WebDAV 或 RAG。历史对象不自动清理；手动 GC 只回收超过宽限期的无引用对象，保留所有历史版本。可读文件树只供查看和导出，直接修改会在重建时丢弃。

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

[设计](docs/superpowers/specs/2026-10-12-mindsync-design.md)与[验证记录](docs/verification.md)说明约束及已完成的测试。真实飞牛、Windows、Android 实机和外网通道需要进一步验收。

0.3.1 起不在 Obsidian 底部状态栏添加 MindSync 项。同步入口保留在侧边栏图标、命令面板和 MindSync 设置；状态与冲突通过命令面板的 View status and conflicts 查看。更新插件后重载即可生效。

0.3.2 的连接设置和配置选择改为显式保存：修改后点击 Save changes，关闭页面会丢弃未保存草稿。注册、测试和同步前先保存修改。Device token 默认用圆点隐藏，可点 Show/Hide 查看或隐藏；注册仍会保存新设备令牌。设置页去掉说明小字，连接行使用垂直居中布局。

0.3.3 新增右侧栏 MindSync 页签，与 Git 等面板并列。点击左侧 MindSync 图标或命令 MindSync: Open MindSync 打开；顶部提供同步、预览、暂停/继续、历史和设置/插件管理，下方显示本机同步状态、待处理数量、配置更新与冲突副本。启动仅添加页签，不自动展开侧栏或抢占焦点；面板更新不新增网络轮询。连接地址和令牌仍在插件设置页保存。

0.3.4 侧栏字号跟随 Obsidian 原生导航字号，标题和表单保持紧凑。预览、历史、配置选择/发布/审核以及保留副本查看都在 MindSync 面板内完成，用 Back 返回概览；成功和错误使用页面内反馈，不再弹出 MindSync 模态框或通知。首次合并仍需明确确认，配置仍需分组审核。连接设置的 Save changes 保持不变。

0.3.5 使用用户提供的脑回路图标作为 MindSync 页签和左侧入口，实际同步按钮仍用刷新图标。预览或历史请求失败后正确移除 Loading 状态，并显示实际错误。跨平台路径检查保持不变：冒号等 Windows 不支持的字符会被拒绝；不会自动更名或忽略用户文件。
