# Docker MindSync Implementation Plan

> For agentic workers: use subagent-driven-development for implementation and independent reviews. Steps use checkbox syntax.

**Goal:** 交付可安装插件和 Docker 服务，通过真实 API 验证双向同步与故障恢复。
**Architecture:** 本地优先的插件以版本化 HTTP API 连接飞牛服务。服务以 PostgreSQL 事务和不可变对象管理权威版本，普通文件树可重建。
**Tech Stack:** TypeScript、Obsidian API、Rust Axum SQLx、PostgreSQL、Docker Compose。
**Spec:** docs/designs/2026-10-12-mindsync-design.md

## Global Constraints
单用户单库；macOS/Windows/Android；前台同步；附件默认 50 MiB；只有 NAS 本地后端；冲突保留副本；不复制第三方插件代码；外网与实机验收单独报告。

### Task 1: HTTP service and durable storage
Files: server/src/{main,lib,storage,path}.rs, server/tests/, server/Cargo.toml, server/migrations/, Dockerfile, compose.yaml.
Interfaces: consumes docs/protocol.md; produces complete HTTP API v1.
- [x] 写 API 集成测试：并发提交同 base_revision，assert 第二次 409 且第一个对象不变；同 operation_id 重试 assert revision 不变；删除后旧版本 put assert 409。
- [x] 运行 `cargo test --manifest-path server/Cargo.toml`，验证并发、幂等与删除冲突；恢复缺陷回归按失败到通过验证。
- [x] 实现不可变对象文件 fsync 后才提交数据库；PostgreSQL 行锁及事务 包住版本、路径和操作幂等检查；启动修复最新文件树。
- [x] 测试分页、撤销令牌、路径逃逸、对象校验、投影重建和备份恢复，运行同一测试命令。
- [x] 通过 `git diff --check` 后保存任务提交。

### Task 2: Cross-platform sync engine and plugin
Files: plugin/src/{types,engine,api,main,local}.ts, plugin/tests/, plugin/package.json, plugin/manifest.json, plugin/styles.css.
Interfaces: transport matches docs/protocol.md; local adapter reads/writes/removes local bytes and atomically persists durable state.
- [x] 构造两个内存客户端接 API：A 写 note.md → sync → B sync，assert B 内容相同；A/B 同时离线修改后 assert 两份均存在。
- [x] 运行 `npm test --prefix plugin`，验证双端同步与离线冲突结果。
- [x] 实现顺序调度、离线操作与候选内容持久化、响应丢失恢复、初次库合并预览、版本检查、冲突副本、删除及重命名；下载写入前对当前内容做再检查。
- [x] Obsidian 使用 requestUrl、Vault API、Web Crypto；提供连接、设备令牌、同步状态、预览、暂停和历史恢复界面；不使用 Node 文件接口。
- [x] 运行 `npm test --prefix plugin` 和 `npm run build --prefix plugin`。
- [x] 通过 diff 检查后保存任务提交。

### Task 3: Packaging and verification
Files: README.md, docs/deploy-fnos.md, scripts/{package.mjs,integration.ts,backup.sh,restore.sh}, dist/.
Interfaces: package emits main.js/manifest.json/styles.css ZIP and service source archive; integration runs built engine against real local service.
- [x] 编写新建库、非空库合并、局域网、HTTPS、令牌注册/撤销、备份恢复的可执行安装说明。
- [x] 用真实 HTTP 服务运行两个客户端离线冲突、删除传播、重启及响应丢失测试。
- [x] `docker compose config --quiet`；build image，启动测试容器并验证健康与持久化。
- [x] 独立审查设计覆盖与代码正确性，修复全部影响数据安全的问题，重复相关测试。
- [x] 打包并校验 ZIP 结构，记录实机和 NAS 外网未验收项。
