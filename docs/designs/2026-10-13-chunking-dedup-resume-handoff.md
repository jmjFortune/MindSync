# MindSync 交接文档：内容分块 / 去重 / 断点续传（含信任模型结论）

> 日期：2026-10-13
> 状态：**待实施**
> 交付对象：实施者（GPT 或其它代理）
> 仓库：`~/Desktop/projects/MindSync`（分支 `feat/docker-sync`）
> 相关既有文档：`docs/protocol.md`、`docs/deploy-fnos.md`、`docs/verification.md`、
> `docs/designs/2026-10-12-library-abstraction-design.md`

---

# 第一部分：决策记录（不要再重新讨论）

## A1. 信任模型：采用**单主（服务端权威）**，保持现状

**结论**：MindSync 继续使用"服务端权威 + 单调 revision 全序"的单主模型，**不改为** LiveSync/CouchDB 那种多主收敛模型。

**理由**

1. 目标场景是「1 个使用者 + 几台设备 + 自己的 NAS 作为中心 + 每台设备保留完整本地副本」。
2. 单主的冲突判定是**确定的**：服务端用单调 `revision` 仲裁，客户端只需处理"基于旧版本提交"这一种情况（409 + `current`）。多主需要在客户端收敛版本树，且**同类修改无法完全自动化合并**，必然落到人工处理。
3. 删除、重命名、幂等可以**用数据库事务表达**：路径唯一约束、设备令牌即时撤销、响应丢失后安全重试（`operations` 幂等台账）。这些在多主模型里是 tombstone 与 GC 的经典难题。
4. 客户端保持"薄"，同一套 HTTP API 可同时支撑 Obsidian 插件、CLI 与 Web 客户端。
5. 单主的唯一实质代价是"服务端是单点"，而该代价已被两点抵消：**每台设备都有完整本地副本**；服务端有已验证的备份/恢复流程（`scripts/backup.sh`、`scripts/restore.sh`，恢复会轮换 vault 身份）。

**明确保留的边界**：不实现 P2P 直连、不实现"多台服务端互相对写"。若将来需要，属于独立立项。

## A2. 加密：本期不做，但设计不得封死去重

本期**不实现 E2EE**（使用者明确要求不加密文档）。但分块必须在**客户端**完成，因为这样将来加 E2EE（客户端加密后再分块）仍然可以保持去重能力。**服务端不得假设自己看到的是明文，也不得依赖明文做去重判断。**

## A3. 不做的事（防止范围蔓延）

- 不引入 LiveSync 的代码或依赖；机制可参考，实现必须落在 MindSync 自己的模型上。
- 不改动 LiveSync 的部署（`/vol1/1000/docker/livesync-couchdb`），不与它共享任何数据。
- 不改动服务端权威/事务/幂等这些既有不变量；不引入最终一致语义。
- 不实现自动删除历史（GC 见 B7，且默认手动）。
- 不实现多人协作、WebDAV、RAG。

---

# 第二部分：实施规格 —— 分块 / 去重 / 断点续传

## B1. 目标与非目标

**目标**

- 大文件与历史版本**不再整份重复存储**：相同内容块跨文件、跨版本、跨设备只存一份。
- **断点续传**：上传中途断网/退出/重启后可以继续，只补缺失的块。
- 传输单位变小（块级），弱网（ZeroTier / 移动网络）下可重试、可观测进度。
- 为将来取消 50 MiB 单文件上限、加 E2EE 留下正确的地基。

**非目标（本期）**

- 不做自动 GC、不做块级压缩、不做服务端加密、不做 P2P、不做多主。
- 不优化小文件的算法开销到极致（只要不显著变慢即可）。

## B2. 现状（实施者必须先读）

**服务端（Rust / Axum / SQLx / PostgreSQL 17）**

```
server/src/main.rs        配置与启动（环境变量 MINDSYNC_DATA/PORT/ADMIN_TOKEN/MAX_FILE_BYTES）
server/src/lib.rs         HTTP 路由与业务逻辑（约 760 行）
server/src/storage.rs     不可变对象存储（按 sha256 落盘）、投影重建
server/src/path.rs        路径校验
server/migrations/0001_initial.sql
server/tests/api.rs       集成测试（约 1030 行，需要专用空 PostgreSQL）
```

**关键数据库不变量（不得破坏）**

```sql
CREATE TABLE vault (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), id TEXT NOT NULL, cursor BIGINT NOT NULL DEFAULT 0 CHECK(cursor >= 0));
CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL, path_key TEXT NOT NULL, revision BIGINT NOT NULL CHECK(revision > 0), hash TEXT NOT NULL, size BIGINT NOT NULL CHECK(size >= 0), deleted BOOLEAN NOT NULL);
CREATE UNIQUE INDEX files_active_paths ON files(path_key) WHERE NOT deleted;   -- 同路径只能有一个活文件
CREATE TABLE changes (revision BIGINT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), record JSONB NOT NULL);
CREATE TABLE operations (id TEXT PRIMARY KEY, identity TEXT NOT NULL, fingerprint TEXT NOT NULL, result JSONB NOT NULL);  -- 幂等台账
```

- 所有 `revision` 是**全库单调递增整数**，同时充当变更 `cursor`。
- 提交必须**先落对象、再提交数据库**（不可变对象 + 事务）。
- `operations` 是幂等台账：同 `operation_id` + 同指纹重复提交返回同一结果；指纹包含设备身份。
- 删除不允许以 `base_revision = 0` 复活；恢复通过 put + 最新 tombstone revision。

**插件（TypeScript / Obsidian API）**

```
plugin/src/types.ts       FileRecord / Operation / Remote / Local / SyncState / validatePath / included / digest
plugin/src/engine.ts      SyncEngine：preview / sync / capture / flush / accept / protect / restore（约 310 行）
plugin/src/local.ts       ObsidianLocal：Vault API 读写、两个状态槽 + 校验和、目录重命名恢复、二进制替换恢复
plugin/src/main.ts        插件入口：设置界面、定时同步、命令、预览/状态/历史模态框（约 150 行）
plugin/src/api.ts         Api：/v1 各端点封装
plugin/src/connection.ts  ConnectionContext：运行期连接隔离
plugin/tests/*            Vitest（53 项）
```

**必须保持的插件约束**

- 只使用 Obsidian 的 `Vault` API、`requestUrl` 与 Web Crypto；**不得使用 Node 的文件接口**（会毁掉移动端）。
- 同步集合来自 `local.list()`（`engine.ts` 的 `capture()`），下载统一走 `local.replace()`。
- 冲突以"新文件"形式保留在 `MindSync Conflicts/` 下（`protect()`），不得改成自动覆盖。
- 状态写入 `.obsidian/plugins/mindsync/state-{0,1}.json`，带校验和，交替写两槽。

**当前部署现状（实施时可用于验证）**

- 飞牛 NAS 上以库的方式部署：项目 `mindsync`，容器 `mindsync` / `postgres`，端口 `8080`。
- 数据目录 `/vol1/1000/libraries/notes`，其下 `objects/`（不可变对象）、`vault/`（可读文件树）、`tmp/`。
- 库凭据 `libraries/notes.env`（权限 600，含管理令牌与数据库密码，**备份脚本不含它**）。
- 已注册设备令牌一枚（设备名 `Mac`，测试 vault 在 `~/Documents/MindSync 测试`）。

## B3. 数据模型改动

**对象库布局（保持不变，天然适配分块）**

```
<data>/objects/<sha256>        每个块就是一个对象文件，内容寻址即天然去重
<data>/tmp/                    上传临时文件
```

**数据库（新增迁移 `0002_chunks.sql`，不要改 0001）**

```sql
-- 每个文件版本与其块的对应关系；chunk 按内容哈希引用
CREATE TABLE version_chunks (
    revision   BIGINT NOT NULL REFERENCES changes(revision) ON DELETE CASCADE,
    ordinal    INTEGER NOT NULL,
    chunk_hash TEXT NOT NULL,
    chunk_size BIGINT NOT NULL CHECK (chunk_size > 0),
    PRIMARY KEY (revision, ordinal)
);
CREATE INDEX version_chunks_hash ON version_chunks(chunk_hash);

-- files 增加清单标记：不再有"整文件对象"时 size/hash 仍表示整文件（见下）
ALTER TABLE files ADD COLUMN chunked BOOLEAN NOT NULL DEFAULT FALSE;
```

**语义约定**

- `files.hash` 继续表示**整文件内容的 SHA-256**（客户端流式计算），`files.size` 表示整文件字节数。这样现有校验、冲突与大小上限的语义不变。
- `chunked = FALSE` 时，对象库中 `<hash>` 就是整文件对象（**旧数据的形态，必须继续可读**）。
- `chunked = TRUE` 时，对象库中没有整文件对象；内容由 `version_chunks` 里该 revision 的块按 `ordinal` 顺序拼接而成。
- 单块清单（`chunked = TRUE` 且只有一块）与旧对象在存储上是等价的，因此**新旧可共存**，无需数据迁移脚本。

## B4. 协议 v2

`GET /v1/info` 返回 `protocol: 2`，并新增：

```json
{ "protocol": 2, "vault_id": "...", "max_file_bytes": 52428800, "cursor": 12, "storage_bytes": 123456,
  "chunk_algo": "fastcdc", "chunk_avg": 65536, "chunk_min": 16384, "chunk_max": 262144 }
```

新增/调整端点：

| 端点 | 说明 |
|---|---|
| `POST /v1/chunks/missing` | body `{"hashes": ["...", ...]}` → `{"missing": ["...", ...], "present": N}`。客户端先问再传，**续传就是重新问一次** |
| `PUT /v1/chunks/{sha256}` | 上传单个块。**幂等**：块已存在直接返回成功，不重复写盘。校验摘要与长度上限 |
| `GET /v1/chunks/{sha256}` | 下载单个块（客户端按清单组装文件） |
| `POST /v1/operations` | `kind:"put"` 时新增可选字段 `chunks: [{hash,size}...]` 与 `chunked: true`。服务端**事务内校验每个块都存在**，然后写入 `files` + `changes` + `version_chunks` |

保持不变：`GET /v1/snapshot`、`GET /v1/changes`、`GET /v1/objects/{sha256}`（旧客户端/旧数据路径）、`GET /v1/files/{id}/history`、设备管理端点。

**错误码（沿用现有风格，新增两个）**

- `409 REVISION_CONFLICT` / `PATH_CONFLICT` / `OPERATION_REUSED`：语义不变
- `422 MISSING_CHUNK`（提交时引用了不存在的块，响应里带缺失哈希列表）
- `422 INVALID_MANIFEST`（块列表为空、总大小与块大小之和不符、ordinal 不连续等）

**兼容策略**

- 插件与服务端**必须同期升级**（当前只有 1–2 个客户端，风险可控）。插件侧把 `info.protocol !== 1` 的检查改为 `![1,2].includes(info.protocol)`，并对 `protocol: 1` 的服务端回退到旧路径。
- 旧数据（`chunked = FALSE`）永久可读；不强制重写。是否"重新分块"由将来的显式命令决定，本期不做。

## B5. 插件改动

新增 `plugin/src/chunker.ts`：

- FastCDC（gear hash）实现：`chunk(bytes: Uint8Array): {hash, size}[]`，参数 `avg/min/max` 取自 `/v1/info` 的建议值。
- 小文件阈值：整文件小于 `chunk_min * 4`（约 64 KiB，可调）时返回**单块**，由服务端按 `chunked = FALSE` 处理，避免小笔记产生额外表项。

改动 `plugin/src/engine.ts`：

- `capture()`：对每个待上传文件流式计算整文件 sha256 + 清单，写入候选（`Candidate` 增加 `chunks` 字段），状态槽里保存清单以便重启后续传。
- 上传流程改为：`POST /v1/chunks/missing` → 逐个 `PUT /v1/chunks/{hash}`（可并发，建议 2–4）→ `POST /v1/operations`（带清单）。
- 进度：把"已传 N/M 块"暴露给状态栏与"同步状态"模态框；`api.ts` 的 120 秒超时改为**按块计算**（单块请求用较短超时，避免一个大请求吃掉全部预算）。
- `accept()`：按 `chunked` 分派——`chunked = TRUE` 时按 `ordinal` 依次下载块并拼接（先写临时状态、成功后再替换，复用现有 `local.replace()` 的乐观校验语义）；`FALSE` 时走原路径。
- 续传的语义边界：**只对"尚未提交的候选"续传**；已提交的操作按现有幂等台账处理，不得重传块后重复提交操作。

## B6. 服务端改动要点

- 块上传写盘沿用 `storage.rs` 现有"先落盘 fsync、再返回成功"的路径；`PUT /v1/chunks/{hash}` 与 `PUT /v1/objects/{hash}` 共用实现，仅校验长度上限不同（块上限 = `chunk_max`）。
- `POST /v1/operations` 的 `put` 分支：若有 `chunks`，在**同一事务**内 `SELECT` 校验块存在性、写入 `version_chunks`、更新 `files`、插入 `changes`；任一缺失则整体回滚并返回 `MISSING_CHUNK`。
- 投影重建（`vault/` 可读文件树）：按 `chunked` 分派——拼接块或直接复制整文件对象。
- `storage_bytes` 统计口径改为对象库实际占用（去重后），并在 `info` 中额外返回 `logical_bytes`（所有版本按未去重计算的大小），便于观察去重收益。

## B7. 垃圾回收（GC）——默认手动

- **引用判定**：块被引用 = 存在任一 `version_chunks` 行引用它。删除作业**只删零引用的块**。
- **宽限期**：默认 7 天（可配置），避免删掉正在上传、尚未提交的块（这类块在提交前没有引用）。
- **触发方式**：本期只提供手动命令（例如 `scripts/gc.sh` 或服务端维护端点 `POST /v1/maintenance/gc`），**不自动执行**。
- **安全测试必须覆盖**：被任何保留版本引用过的块绝不删除；GC 后历史恢复仍可用；GC 与并发上传互不干扰（宽限期即为此）。
- 明确写下：MindSync 目前**历史对象不自动清理**（见 README/verification），GC 是这条限制的解法，但必须先确认使用者接受"删掉不再引用的历史块"。

## B8. 分阶段计划与完成定义

**阶段 1：分块 + 去重（必做）**
- 交付：`0002_chunks.sql`、块端点、`chunker.ts`、engine 上传路径、投影重建适配、协议文档更新。
- 完成定义：同一份 2 MiB 文件上传两次，第二次 `PUT /v1/chunks/*` 请求数为 **0**；往返内容 sha256 一致；旧数据（`chunked = FALSE`）仍能下载与恢复历史；`cargo test`、`npm test --prefix plugin`、`cargo clippy -- -D warnings`、`cargo fmt --check` 全绿。

**阶段 2：断点续传（必做）**
- 交付：missing 协商、块级重试、进度展示、跨重启恢复（清单持久化在状态槽）。
- 完成定义：上传 10 MiB 文件到一半强杀插件进程 → 重启 → 同步完成且内容一致，且**重传字节数 < 总大小的一半**；断网 30 秒后自动恢复。

**阶段 3：GC（必做，手动触发）**
- 交付：引用统计、手动 GC、宽限期、安全测试。
- 完成定义：上述 B7 的四条安全测试全部通过；GC 后 `storage_bytes` 下降而 `logical_bytes` 不变。

**阶段 4：大文件与读缓存（可选）**
- 提高 `MINDSYNC_MAX_FILE_BYTES` 上限（例如 512 MiB）并验证流式读写不整份进内存；客户端块缓存（可选）。

## B9. 验证与验收（必须可执行）

1. **现有测试全绿**：`cargo test --manifest-path server/Cargo.toml --locked`、`npm test --prefix plugin`、`cargo clippy ... -D warnings`、`cargo fmt -- --check`。
2. **去重率量化**：对同一 PDF 连续上传 3 个版本（小幅修改），记录 `storage_bytes` 与 `logical_bytes` 之比；期望明显小于 1（具体值写进验证记录）。
3. **中断续传**：见阶段 2 完成定义；另外覆盖"块传完但操作未提交时就退出"的情形（重启后应直接提交，不重传块）。
4. **旧数据兼容**：用升级前的备份恢复出一份旧库（`chunked = FALSE`），确认能读、能下、能恢复历史。
5. **冲突不回归**：并发编辑 → 冲突副本仍出现在 `MindSync Conflicts/`；大小写目录重命名的临时目录机制不受影响。
6. **GC 安全**：见 B7。
7. **飞牛实机**：在 NAS 上按 `docs/deploy-fnos.md` 升级（见 C3 的构建与权限注意事项），跑一遍阶段 1–3 的验收，并把结果写进 `docs/verification.md`。

## B10. 风险与注意事项

| 风险 | 处置 |
|---|---|
| 破坏幂等/事务语义 | 所有写路径必须在单事务内完成；块校验与 `version_chunks` 写入与 `changes` 同事务 |
| 上传中的块被 GC 误删 | 宽限期 + 只做手动 GC + 只删零引用块 |
| 小文件变慢 | 单块阈值；分块仅在超过阈值时启用 |
| 插件超时预算被大请求吃光 | 按块设置超时；块并发 2–4；失败块单独重试 |
| 块数量爆炸导致 PG 行数过大 | 平均块 64 KiB 起步；`version_chunks` 按 `revision` 分区可作为后续优化（本期不做） |
| 移动端内存 | 块大小上限 256 KiB，读组装用流式写入，避免整文件驻留内存 |
| 与 LiveSync 数据混淆 | 本期不碰 `/vol1/1000/docker/livesync-couchdb`；不把插件装进 LiveSync 的 vault |

---

# 第三部分：给实施者的上下文包

## C1. 环境与命令

```sh
# 插件
npm ci --prefix plugin
npm test --prefix plugin
npm run build --prefix plugin

# 服务端（需要专用空 PostgreSQL，不能指向生产库）
cargo build --manifest-path server/Cargo.toml --locked
cargo test --manifest-path server/Cargo.toml --locked
cargo clippy --manifest-path server/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path server/Cargo.toml -- --check
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mindsync_test cargo test --manifest-path server/Cargo.toml --locked

# 打包（插件 ZIP + 源码 tar.gz + 校验和；源包不含任何 .env）
node scripts/package.mjs
```

## C2. 部署与库的概念

- 一个**库** = 一个 compose 项目 + 一个独立数据目录 + 一个管理令牌；库之间互不影响。
- 第一个库使用干净名字：项目 `mindsync`、容器 `mindsync` 与 `postgres`。新增库自动加后缀（容器名在宿主机上必须唯一）。
- 新增库：`sh scripts/add-library.sh <库名> <端口> <数据目录>`（凭据由使用者自己输入，**不得随机生成或打印**）。
- 备份/恢复按库执行：`MINDSYNC_LIBRARY=<库名> sh scripts/backup.sh [目录]`、`MINDSYNC_LIBRARY=<库名> sh scripts/restore.sh <备份目录>`；恢复前用 `add-library.sh … --no-start` 准备空库。
- 只准备不启动：`sh scripts/add-library.sh <库名> <端口> <数据目录> --no-start`。

## C3. 飞牛 NAS 上的已知坑（照做，别重新踩）

1. **构建必须用宿主网络**：`docker build --network=host -t mindsync:latest .`
   原因：该 NAS 上容器默认 `/etc/resolv.conf` 里的解析器不可达，构建容器报 `Could not resolve host: deb.debian.org` / `index.crates.io`。与镜像源无关。
2. **容器必须以数据目录属主身份运行**（`MINDSYNC_RUN_UID/GID`，由 `add-library.sh` 写入）。
   原因：fnOS 存储层只放行已知用户；把目录 chown 成镜像内置的 `10001` 会让容器以 `Permission denied (os error 13)` 启动失败。
3. **不要用 `compose up --wait` 判定首次启动成功**：首启包含数据库迁移与可读文件树重建，慢盘上会超过健康检查起算期。`compose.yaml` 已把起算期调整为 120 秒、`retries` 5，`add-library.sh` 也改为自行轮询 `/health`（最长 240 秒）。
4. **重启数据库容器后首次请求可能一次失败**（连接池超时），容器由 `restart: unless-stopped` 拉回即可；不要据此判定部署失败。
5. **不要打印或提交任何凭据**：`libraries/*.env`、`.env` 均在 `.gitignore` 中；备份脚本不含 env。

## C4. 交付物清单（阶段 1–3）

```
server/migrations/0002_chunks.sql
server/src/lib.rs                 （块端点、清单提交、MISSING_CHUNK/INVALID_MANIFEST）
server/src/storage.rs             （块读写、引用统计、GC）
server/tests/api.rs               （新增：去重、中断续传、GC 安全、旧数据兼容）
plugin/src/chunker.ts             （FastCDC）
plugin/src/engine.ts              （清单、missing 协商、续传、按块下载组装）
plugin/src/api.ts                 （新端点与按块超时）
plugin/tests/*                    （chunker 单测、续传状态机、兼容回退）
docs/protocol.md                  （v2 协议）
docs/verification.md              （新增验证记录）
scripts/gc.sh 或服务端维护端点     （手动 GC）
```

## C5. 待确认项（如无异议按默认实施）

| 项 | 默认（建议） | 备选 |
|---|---|---|
| 分块算法 | **FastCDC**（gear hash） | Rabin-Karp（LiveSync 用的） |
| 平均块大小 | **64 KiB**（min 16 KiB / max 256 KiB） | 32 KiB（更省空间、更多行） |
| 小文件阈值 | **64 KiB 以下单块** | 不设阈值 |
| GC 策略 | **手动 + 引用计数 + 7 天宽限期** | 自动定期 |
| 协议兼容 | **升 v2，同期升级客户端；旧数据永久可读** | 仅服务端适配 v1 |

**实施前请先读完**：`docs/protocol.md`、`server/migrations/0001_initial.sql`、`server/src/lib.rs`、
`plugin/src/engine.ts`、`plugin/src/local.ts`、`plugin/src/types.ts`、`docs/verification.md`。
