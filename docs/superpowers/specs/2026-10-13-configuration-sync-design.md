# Obsidian 设置与插件同步设计

日期：2026-10-13。状态：用户以“开始”批准实施。

## 目标与授权边界

用户要求同步 Obsidian 设置和插件。沿用现有服务端权威、revision、内容块、幂等台账和冲突副本。用户已明确：冲突处理保持现状，历史容量管理以后再做。本次不加入自动合并、历史修剪或实时推送。界面、源码、注释与错误均为英文；文档可为中文。编译/测试单任务运行。

## 方案比较

1. **推荐：独立的配置同步范围，按项选择，收到更新后预览应用。** 支持所需设置/插件，兼容旧笔记客户端，适配桌面与移动端；增加配置适配器和小型导入界面。
2. 整个配置目录直接参加现有文件同步。改动较少，但会传递设备工作区、插件凭据和 MindSync 自身状态，旧客户端也可能写入配置；不采用。
3. 仅上传配置备份，再手工下载。最简单，但无法满足设备间持续同步；不采用。

## 同步内容与选择

每台设备独立启用 Settings and plugins，初始关闭。初次启用选择 Publish this device（作为配置来源）或 Review remote settings（接收已有配置）；两者先列出文件和动作，再开始。

- Obsidian settings：app.json、appearance.json、hotkeys.json、core-plugins.json。
- Themes and snippets：选中的 themes/<name>/ 与 snippets/*.css。
- Plugins：按插件选择 manifest.json、main.js、styles.css；缺失的可选样式文件不当错误。
- Plugin settings：按插件单独选择 data.json，默认不选。界面说明配置可能包含 API keys 或账号信息；不猜测或删改插件 JSON 字段。
- Enabled plugin list：作为单独选项；接收端只启用已安装、所选且兼容该平台的插件。保留 MindSync 的本机启用状态，保持已有 LiveSync 停用状态。桌面专用插件不在移动端启用。

永不同步 workspace*.json、MindSync 自身目录、LiveSync 的连接配置、状态日志、恢复副本、缓存、.git、node_modules 与临时文件。选择规则同时用于扫描、发送、接收和应用。取消选择不会产生删除或抹掉本地文件。已存在的未选插件文件保持原样。配置目录用 app.vault.configDir 获取，不固定为 .obsidian。

## 服务端兼容性与存储

新增 0003 配置范围迁移，files 增加 scope（旧数据默认 notes），活跃路径唯一约束变为 (scope,path_key)。所有文件 ID 和 operation ID 仍全库唯一。changes、operations 与 version_chunks 保持现有事务关系；对象库跨范围共享摘要对象。

保留 /v1 的笔记端点语义，只返回 notes。增加 /v1/configuration 下的 snapshot、changes、operations、operation result、history；对象/chunks 端点仍共用。路由决定范围，调用者不能用普通笔记操作修改配置范围。指纹包含配置范围，而旧笔记请求的指纹保持逐字节兼容。

info 仍 protocol 2，增加 configuration_sync 与 configuration_groups 能力标志。旧 0.2.1 插件只收到笔记，不会导入配置；新插件连接没有能力标志的服务时，普通同步继续可用，配置功能明确不可用。两个范围使用全库单调 cursor，各自分页过滤；无匹配变更时确认到请求固定的 until，不能丢掉另一个范围的变更。

配置远端路径相对于配置目录，例如 app.json、plugins/calendar/main.js。路径必须通过既有跨平台校验和配置允许列表。NAS 可读投影将配置存入单独的 configuration/ 树，避免映射到笔记目录；备份仍包含所有数据库记录与 objects，重启分别验证与重建投影。

## 客户端与接收应用

新增 ConfigurationLocal，使用官方 DataAdapter，不引入 Node 文件接口。配置同步拥有独立 checksum 双槽日志、待上传候选、已观察版本、待应用更新与恢复备份，均放在 MindSync 自身目录内。笔记状态槽不迁移、不重置。配置扫描前台每 30 秒检查一次，并在首次启用、回到前台和手动同步时检查。

收到远端配置先验证摘要并保存为待应用更新，不直接改正在运行的配置。英文预览列表显示路径、动作、远端版本及本地差异；按钮为 Publish selected、Review updates、Apply selected、Not now。关闭预览不会应用更新，更新继续保存在日志中。只有所选项目可发布/接收；权限/连接失败保留候选，并独立显示错误。

Apply selected 再读取本地内容并验证预览时的摘要；发生变化则拒绝过期应用并要求重新预览。写入前持久化原内容和更新意图，JSON 文本通过 DataAdapter.process 做条件替换；二进制插件文件使用持久备份、临时文件与可恢复替换。并发文件写入缺乏跨平台 CAS 时，不声称完全原子；恢复日志必须保留观察到的旧内容。

更新同一个插件按组处理：先准备所有文件，校验 manifest 的插件 ID、JSON 格式、平台兼容性和全部内容摘要，再写入；部分失败能够恢复原文件或在重启前完成恢复。界面只有整个组成功才显示 Applied。应用后提示 Reload Obsidian，不自动关闭应用，不自动加载未知插件。

并发修改保持双方内容：配置冲突副本存入本机 MindSync 配置恢复目录，并提供 View conflict copy 与 Keep local / Use remote，提交仍使用最新 revision 的条件写入。笔记冲突逻辑保持不变。用户推迟处理时不反复弹窗。

## 验收标准

- 原 73 项插件和 15 项服务端回归通过，旧笔记 fingerprint/幂等结果不变。
- 两个独立测试库往返同步 Obsidian JSON、CSS snippet、theme 和插件包，所有字节/摘要一致。
- 禁用配置功能的旧客户端快照/changes 不含配置记录；两个范围相同路径互不冲突。
- MindSync token、state slots、恢复日志、workspace 和未选择的第三方插件 data.json 从不上传/覆盖。
- 开关与选择变更不产生误删除；远端配置目录与接收端自定义 configDir 正确映射。
- 本地在预览后修改时阻止应用；断网、响应丢失、写入失败、进程中断可恢复。
- 插件更新的部分失败不显示成功，原文件可恢复；移动端拒绝启用 isDesktopOnly 插件。
- 配置导入与笔记同步并行请求的连接隔离仍成立；暂停/卸载不会启动新的同步工作。
- 打包源文件与当前插件界面无中文；安装保持原本地配置和笔记状态，新增功能默认关闭。

先完成隔离验收，再备份 NAS 库并部署；不对真实配置自动导入，不运行历史清理。实际 Obsidian/Android 生命周期验收需另行记录，headless DataAdapter 测试不充当实机证据。

## 学习依据

借鉴 LiveSync 将配置同步与笔记分开、独立选择项目、明确首次方向和重载边界；不复用其 PouchDB 多主模型或把整个隐藏目录直接开放。

- https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tips/hidden-file-sync.md
- https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md
- 当前插件依赖中 Obsidian DataAdapter 的 readBinary/writeBinary/process/list/rename 接口。

UX 技能针对 confirmation preview settings import 查询返回明确确认导入动作与简短成功反馈；使用现有 Obsidian Setting/Modal，保留键盘操作与可见错误，不引入新的视觉系统。

## 实施补充：包完整性

每次发布代码/主题包包含完整成员描述符（group ID + members），包括未变化文件。接收端等所有远端成员一致后才允许应用。插件 data.json 独立发布以允许只同步设置，但本机同时收到代码/设置更新时仍以插件为一组应用。全部待上传候选一次性持久化，断电不会仅记录半个包。服务端仍按文件提交；竞争造成部分包时不自动应用，需要来源端续传或显式重新发布解决。本机缺失可选包文件保留远端内容，插件卸载暂不自动传播。
