# 库（Library）抽象设计 —— 多库拓扑与可叠加扩展接口

> 状态：待评审
> 日期：2026-10-12
> 选定拓扑：**B —— 一库 = 一个 vault + 一个服务端实例 + 一个数据目录 + 一个令牌**

## 1. 背景与目标

需要把 Zotero 的文献附件接入同步，但**不与笔记库混在一起**，而是与 vault **平级**成库。
以后还可能继续接入别的库（其它采集源、归档库等）。

目标：把"库"做成一个**可复制、可叠加的接口**——新增一个库是配置动作，不是改代码动作。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 库（Library） | 一个独立的同步域。对外表现为：一个服务端实例 + 一个数据目录 + 一个管理令牌 |
| vault | Obsidian 的笔记库目录。**一个 vault 连一个库**，由插件配置决定 |
| 实例 | 该库对应的 `mindsync` 容器 + 其 PostgreSQL 容器（同一 compose 文件、不同项目名） |

## 3. 为什么不采用另外两种

**vault 内 prefix（`Vault/Zotero/`）** —— 零改动，但附件混在笔记库里，不满足"平级"；且会让笔记库的历史与体积被文献附件污染。

**单实例多库（服务端改造）** —— Obsidian 插件**无法通过 Vault API 读写 vault 之外的文件**；桌面端可用 Node `fs` 绕过，但会破坏现有约束（`plugin/src/main.ts` 只用 `requestUrl` + Vault API，**不使用 Node 文件接口**），移动端直接失效。此外服务端 `vault` 是 singleton 表并带 `vault_id` 不匹配保护，改成多库要动 schema、协议、插件与设备订阅，并使我方 10 组 PG 集成场景失效。收益不足。

**结论**：平级只能在"独立 vault + 独立实例"这一层实现，而这恰好**不需要改协议、不需要改插件**。

## 4. 库的接口契约

一个库由且仅由下列配置定义（全部落在 env 文件里）：

| 键 | 含义 | 约束 |
| --- | --- | --- |
| `MINDSYNC_LIBRARY` | 库名；compose 项目名固定为 `mindsync-<库名>`，所有库命令都必须显式传 `-p mindsync-<库名>` | 仅小写字母、数字、`-`；全局唯一 |
| `MINDSYNC_PORT` | 宿主机发布端口 | 各库不得重复 |
| `MINDSYNC_BIND_ADDRESS` | 监听地址 | 局域网填 NAS 的实际 IP |
| `MINDSYNC_DATA_DIR` | 数据目录（bind mount 源） | 绝对路径；**各库不得重复**；其下 `vault/` 即可读文件树 |
| `MINDSYNC_ADMIN_TOKEN` | 管理令牌 | 由使用者输入，不使用随机生成；各库独立 |
| `POSTGRES_PASSWORD` | 数据库口令 | 由使用者输入；各库独立 |

**不变量**

1. 一个库的数据目录只能被一个实例挂载（沿用现有约束）。
2. 各库的端口、数据目录、令牌、数据库互不复用。
3. 停掉一个库不影响其它库。
4. 插件、协议、服务端 schema **均不因新增库而改变**。

## 5. 新增一个库的标准步骤

```sh
# 1) 定义库（脚本会提示输入管理令牌与数据库口令，不打印、不随机生成）
sh scripts/add-library.sh zotero 8081 /vol1/1000/libraries/zotero

# 2) 脚本内部完成：创建数据目录 → 用一次性容器 chown 10001:10001
#    → 由 libraries/example.env 生成 libraries/zotero.env
#    → docker compose -p mindsync-zotero --env-file libraries/zotero.env up -d --wait
#    → 等待 /health 通过并打印结果

# 3) 在对应 vault 里安装插件，填 http://<NAS>:8081 并用该库的管理令牌注册设备
```

**不触碰**：其它库的容器、数据、令牌；共享镜像只在源目录构建一次。

## 6. 目录布局

NAS 上：

```text
/vol1/1000/docker/mindsync/            # 一份源码 + 一份 compose（共享镜像）
├── compose.yaml
├── scripts/add-library.sh             # 新增
├── libraries/
│   ├── example.env                    # 模板
│   ├── notes.env                      # 笔记库（首个库）
│   └── zotero.env.example             # 预留：文献附件库
└── .env                               # 保留，兼容原有单库用法

/vol1/1000/libraries/                  # 各库数据目录（bind mount）
├── notes/                             #   └─ vault/ 即可读文件树
└── zotero/                            # 预留，本次不创建内容
```

Mac 上：

```text
~/Documents/Obsidian Vault/            # 笔记库（现有）
~/Documents/Zotero Library/            # 预留：日后与 vault 平级的第二个库
```

## 7. compose 的最小改动

只加一项，且向后兼容：

```yaml
volumes:
  - ${MINDSYNC_DATA_DIR:-sync_data}:/data
```

未设置 `MINDSYNC_DATA_DIR` 时仍是原有的命名卷行为（现有文档与部署不受影响）；
设置为绝对路径时成为 bind mount，从而让 `vault/` 可读文件树能在飞牛文件管理器里直接浏览。

PostgreSQL 继续使用项目级命名卷（不同项目名即天然隔离；且数据库卷不应放到 SMB/NFS）。

## 8. 设备与订阅

- 每台设备**按 vault 决定订阅哪些库**：只装笔记库 vault 的设备，不会拿到文献附件库。
- 手机默认只订阅笔记库，避免把大量 PDF 拉到手机。
- 一个库的管理令牌只能注册该类设备的设备令牌；库之间令牌不通用。

## 9. 本次范围

1. 提交改名改动（`Obsidian NAS Sync` → `MindSync`）——已检查，仅剩两处**故意**保留的旧标记（`scripts/restore.sh` 兼容旧备份、`backups/*/COMPLETE` 测试产物）。
2. `compose.yaml` 加 `MINDSYNC_DATA_DIR`（见第 7 节）。
3. 新增 `scripts/add-library.sh` 与 `libraries/example.env`。
4. 在飞牛上部署**首个库**（笔记库），数据目录走 bind mount，本地 `/vol1/1000/libraries/notes/`。
5. 用一次性容器解决 `10001:10001` 属主问题（`admin` 无免密 sudo）。
6. 预留 `libraries/zotero.env.example` + 文档说明；**不创建** Zotero 库内容。
7. 打包与校验（`scripts/package.mjs`）。

## 10. 明确不做

- Zotero 侧的任何实现（读取 `zotero.sqlite` / storage 目录）——后续单独设计。
- 服务端多库支持（单实例管多库）。
- vault 内 prefix 式的 `ContentSource` 接口——已在第 3 节说明理由；如日后确需"vault 内的外部内容源"，另行设计。

## 11. 验证

- `docker compose config --quiet` 对每个库的 env 均通过。
- 在飞牛上同时跑**两个库**（`notes` 与一个临时库 `scratch`）：
  - 两个数据目录、两个端口、两套令牌互不干扰；
  - 停掉 `scratch`，`notes` 的 `/health` 与同步不受影响；
  - 两个库的 `vault/` 可读文件树各自独立、可在文件管理器中浏览。
- 权限：`/vol1/1000/libraries/<name>/` 属主为 `10001:10001`，容器可写。
- 钉住 `MINDSYNC_ADMIN_TOKEN` 与 `POSTGRES_PASSWORD` 均由使用者输入，脚本输出与日志中不出现明文。
- 打包产物不含凭据、本地数据与构建缓存。

## 12. 风险

| 风险 | 处置 |
| --- | --- |
| 端口冲突 | `add-library.sh` 启动前检查端口占用并报错 |
| 数据目录填错导致跨库串用 | 脚本校验：目录必须存在且未被其它库 env 引用 |
| 忘记 `-p` 导致误操作到笔记库 | 文档与脚本一律显式传 `-p mindsync-<库名>`；`add-library.sh` 不依赖默认项目名 |
| 磁盘占用增长（文献 PDF 体积大） | 各库独立数据目录，便于单独统计与限额；文档提示 |
| 备份遗漏新库 | 文档补充：备份按库分别执行（`scripts/backup.sh` 在库的 compose 项目下运行） |
| 移动端引用到文献库 | 默认不安装文献库 vault；文档明确"按 vault 订阅" |
