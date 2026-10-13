# v2 实施与验收记录

位置：/Users/shiyun/Desktop/projects/MindSync，分支 feat/docker-sync。

依据交接规格完成阶段 1–3 的源码、回归测试、协议/部署文档与验收脚本。用户睡觉期间只进行轻量源码工作；随后明确允许限制并发恢复验证。最新证据见 progress.md 和 docs/verification.md。

已完成本地 73 项插件测试、15 项服务端集成测试、构建/clippy/fmt、真实 HTTP、备份迁移、进程 SIGKILL/双槽恢复、模拟 30 秒断网、PDF 去重及手动 GC 验收。0.2.0 已打包并装入专用 macOS 测试 vault，保留配置/状态备份。

NAS 单 job release 镜像已构建；隔离库 HTTP/PDF/GC、进程 SIGKILL/模拟 30 秒断网恢复通过；生产 notes 已升级至 0.2.0，身份和游标保持一致且健康。NAS sshd 禁止端口转发，所以测试在 NAS 本机 Node 的 loopback 上运行。不要修改 SSH 配置绕过限制，也不要把 schema-reset/GC 验收脚本指向生产 notes。

保留不变量：旧操作指纹跳过新增 None 字段；rename/delete 保留清单；GC 保护所有旧格式历史和 version_chunks；missing 续期 pending；上传 worker 全部完成后释放连接隔离；重复块 PUT 校验 body，不重复写已有对象。

保留局限：50 MiB 上限、整文件 Vault 读取/组装/替换、Web Crypto 整文件 hash、base64 候选日志。可选阶段 4 未实施。headless 进程验收不等同真实 Obsidian UI/Android 生命周期；macOS UI 自动化权限未获准，未绕过。
