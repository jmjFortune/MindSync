# 分块、去重、续传实施计划 — 2026-10-13

用户授权：根据交接设计继续实施阶段 1–3，按默认参数推进。睡觉期间仅做低负载源码工作；用户随后明确允许恢复验证，编译与测试限制并发。编译单 job、插件测试单 worker，NAS 隔离验收服务限 CPU/内存。

1. 设计与当前实现核对：完成。
2. 服务端迁移、块 API、版本清单与投影：完成，15 项专用 PostgreSQL 测试通过。
3. 插件 FastCDC、持久候选、块上传下载与进度：完成，73 项测试/类型检查/构建通过。
4. 手动 GC 与安全测试：完成，本地与 NAS 隔离 HTTP 安全验收通过；生产未运行 GC。
5. 集成验证、部署、文档与打包：本地和 NAS HTTP/PDF/真实 SIGKILL/30 秒模拟断网验收通过；NAS notes 0.2.0 健康，库身份/游标保持一致；最终文档、ZIP/源包内容与校验和检查完成；代码保留在当前分支。

保留单主 revision、幂等操作、冲突副本与移动端 Vault API。旧对象永久可读。默认块 16/64/256 KiB，GC 手动、默认预览、7 天宽限期。客户端仍整文件读取/哈希/替换，50 MiB 上限保留；可选阶段 4 未实施。

## 证据与环境

完整证据见 docs/verification.md；执行记录见 progress.md。
- 本地插件 73/73、服务端 15/15、构建/clippy/fmt、9 组 HTTP 均通过。
- NAS：2 MiB 重复内容零额外 PUT，10 MiB 实际进程强杀重启补传 4,092,761 bytes < 5 MiB，提交前退出零额外 PUT；模拟 30 秒断网自动恢复 46,297 ms。
- 有效 PDF 三版本物理/逻辑比例 0.358124537；GC 仅回收 61-byte 孤立对象，逻辑大小不变，7 个历史版本可读且 pending 保留。
- 旧库实际为空：升级前备份完成、本地恢复迁移与身份轮换通过；非空旧历史兼容另由测试验证。
- 生产镜像 mindsync:v0.2.0 健康，uid/gid 1000:1001；旧镜像 pre-v2-20261013 和两份升级前备份保留，最终备份本地副本校验通过。
- 测试 vault 已安装 0.2.0 且原设备 token 可用；配置/状态未改。UI 权限 pending，未操作界面，需要重载插件。
- 本地/NAS 专用测试服务已停止清理；原有服务和 LiveSync 未改动。

## 未覆盖

真实 Obsidian GUI、Windows/Android、前后台生命周期、移动端 requestUrl 与大附件内存仍待硬件验收；不把 headless Vault 的结果当实机 UI。默认 50 MiB 不提高，不宣称全程流式。

## English-only implementation — 2026-10-13

User requires English for everything except documentation. Translate UI, errors, CLI output, comments, and package metadata; preserve runtime behavior and user content. Keep Unicode filename regression coverage through escapes. Release the plugin as 0.2.1; the unchanged Rust runtime remains 0.2.0.

- Source/CLI/config translations and persistent AGENTS.md language rule: complete.
- Single-worker plugin tests: 73 passed; build, source language audit, CLI usage, shell syntax and Compose validation passed. ZIP/source contents, credential exclusions and SHA-256 checksums passed.
- Both installed plugins updated to 0.2.1; credentials, pause settings and journal slots verified unchanged.
- Source/scripts/templates synced to NAS; backend healthy with unchanged image, and notes.env remains mode 600. No backend restart was needed.
