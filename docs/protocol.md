# MindSync HTTP API v2

除 `GET /health` 外，全部 API 使用 `Authorization: Bearer <token>`。服务端权威、单用户单库；`revision` 全库递增，兼作变更 cursor。路径、设备撤销、冲突及操作幂等规则保持不变。插件支持协议 1 和 2；连接 v1 时使用原整对象路径。部署 v2 必须同步升级插件。

## 文件记录与内容

文件记录为 `{id,path,revision,hash,size,deleted,chunked?,chunks?}`。`hash` 始终是整文件 SHA-256，`size` 是整文件字节数。旧记录省略 `chunked` 等同 `false`，整文件存于 `objects/<hash>`，永久可读。

`chunked:true` 的记录附带按顺序排列的 `chunks:[{hash,size},...]`。每个哈希指向一个不可变块对象；数组下标就是 ordinal。`version_chunks` 与版本记录在同一个提交事务里写入。重命名、删除版本也保留内容清单和历史引用。删除不回收历史内容；恢复用历史内容及最新 tombstone revision 提交 put。

客户端默认用 FastCDC 的 Gear rolling hash、最小切点跳过和两段归一化掩码。参数为 min 16 KiB、avg 64 KiB、max 256 KiB；Gear 表固定在 `plugin/src/chunker.ts`，不依赖其它产品代码，SHA-256 身份不受切点算法实现变化影响。算法原理见 [FastCDC 原论文](https://www.usenix.org/conference/atc16/technical-sessions/presentation/xia)。小于 64 KiB 的文件为单块；只有多个块时客户端提交 `chunked:true`，避免小笔记增加版本块表项。空文件走整对象记录。

## 端点

- `GET /health` → `{status:"ok"}`。
- `GET /v1/info` → `{protocol:2,vault_id,max_file_bytes,cursor,storage_bytes,logical_bytes,chunk_algo:"fastcdc",chunk_min:16384,chunk_avg:65536,chunk_max:262144}`。`storage_bytes` 为对象库实际字节数；`logical_bytes` 是所有保留版本（包括重命名和 tombstone）的 size 总和，不计去重。保留默认 50 MiB 文件上限。
- `POST /v1/devices` 管理令牌授权，body `{name}` → `{id,name,token}`；`GET /v1/devices` 列表，`DELETE /v1/devices/{id}` 撤销。设备令牌不能管理设备或执行 GC。
- `GET /v1/snapshot` → `{files:FileRecord[],cursor}`，包括 tombstone；元数据与 cursor 来自同一个数据库快照。
- `GET /v1/changes?after=N&until=U&limit=100` → `{changes:FileRecord[],cursor,until,has_more}`。首次省略 until 固定当前上界；cursor 为末项 revision，空页取 until。
- `PUT /v1/objects/{sha256}` 二进制 body → `{hash,size}`。保留 v1 上传路径，校验摘要与单文件上限。
- `GET /v1/objects/{sha256}` → `application/octet-stream`。用于旧对象和单块文件；多块版本不存在整文件对象时须按清单下载。
- `POST /v1/chunks/missing` body `{hashes:[sha256,...]}` → `{missing:[sha256,...],present:N}`。输入去重后统计，最多 8192 个哈希。已经存在的对象校验后刷新宽限期，长时间暂停的候选恢复时仍可安全提交。对象损坏返回 STORAGE_ERROR，不报告为可用。
- `PUT /v1/chunks/{sha256}` body 为单个块 → `{hash,size}`。独立 256 KiB 上限，流式校验长度和摘要。对象已存在时不重复落盘，仍校验重试 body；缺失块通过临时文件 fsync 后发布。发布与 GC 互斥，GC 先删除的未提交块可由重试重新发布。
- `GET /v1/chunks/{sha256}` → 原始块字节。下载端校验块长度、SHA-256，再校验拼接结果的整文件长度与 SHA-256。
- `POST /v1/operations` body `{operation_id,kind:"put"|"rename"|"delete",file_id,path?,base_revision,hash?,size?,chunked?,chunks?}` → `{file:FileRecord,cursor}`。新建用 base_revision=0；已有身份必须提供精确版本。rename 不修改内容；delete 不允许 0 版本复活。put 的 `chunked:true` 必须带非空清单；每块 1–262144 字节，合计等于 size，最多 8192 块。单块 `chunked:false` 清单必须与整文件 hash/size 相同。块存在性、实际长度、各摘要及拼接摘要通过后才提交文件、版本、清单与台账。元数据请求体上限 1 MiB。
- `GET /v1/operations/{operation_id}` → 已提交结果，缺失 404。全库唯一 ID，请求指纹包含设备身份；同 ID 内容不同返回 OPERATION_REUSED。新增可选字段缺省时不进入指纹，保留升级前的台账重试兼容。
- `GET /v1/files/{id}/history` → `{versions:FileRecord[]}`。旧格式和多块格式的历史均可用同身份恢复。
- `POST /v1/maintenance/gc` 管理令牌授权，body `{dry_run?:boolean}`，默认 true → `{dry_run,objects,bytes,grace_seconds,storage_bytes}`。false 才实际回收；objects/bytes 是符合条件的对象计数和大小。没有自动触发器。

## 错误与事务

错误统一为 `{error:{code,message,current?,missing?}}`。401 UNAUTHORIZED；403 FORBIDDEN；404 NOT_FOUND；409 REVISION_CONFLICT（含 current，可能 null）、PATH_CONFLICT、OPERATION_REUSED；413 FILE_TOO_LARGE；422 INVALID_PATH、INVALID_REQUEST、HASH_MISMATCH、INVALID_MANIFEST、MISSING_CHUNK（missing 为缺失哈希列表）；503 STORAGE_ERROR。

无效清单、缺失块、冲突不推进 cursor、不保留半条文件版本或操作台账。已发布块可以在提交失败后留下，供续传复用；不构成可见版本。不可变内容先落盘，再提交数据库；服务端不依赖明文含义，摘要比较只针对实际字节。

## 续传、进度与本地状态

所有上传操作先持久化 operation ID、不可变内容和块清单，再发请求。重启或断网后先查询操作结果；已提交则直接确认，未提交才重新询问 missing，并仅上传缺失的唯一块，最后使用原操作 ID 和清单提交。分块参数变化不重新生成待提交清单。升级前的整对象候选继续使用原格式，避免改变指纹。

插件同时上传最多 3 个块；单块请求超时 30 秒，可重试 2 次。永久校验/权限错误不做块内重试。网络错误保留队列，随后沿用前台自动同步退避；应用回到前台触发重试。所有并发上传结束后才释放连接上下文。状态栏和状态窗口展示块进度，已存在块计入完成数。Android 挂起期间不保证运行。

下载逐块校验并在内存组装，成功后调用原 Vault 条件替换；下载失败不改本地文件、不确认版本。状态仍为双槽校验和日志。现有 Obsidian Vault 读写接口及 Web Crypto SHA-256 都处理整文件，本期不承诺整文件流式哈希/流式落地或下载块缓存，50 MiB 上限保留；阶段 4 另行实现。

## 手动 GC

回收条件必须同时满足：不被任何 `version_chunks` 引用、不被任何旧格式历史记录或当前文件引用、修改时间早于宽限期。默认 7 天，服务端环境变量 `MINDSYNC_GC_GRACE_SECONDS` 可配置。块发布/续传协商会刷新修改时间；提交、GC、块发布使用同一 writer 锁保护。临时上传文件不属于对象回收集合。

GC 不删除任何历史版本，也不回收仍有历史引用的块。它只清理未完成上传等无引用对象；历史增长不会因运行 GC 自动消失。默认 CLI 预览：`node scripts/gc.mjs`；显式 `--apply` 才删除。凭据只从环境变量读取，不打印。

## 恢复旧备份

备份仍为 PostgreSQL 导出与 objects 归档。0002 增量迁移不重写旧文件，首次启动验证历史完整性并重建单块/多块投影。恢复保留版本与 cursor，但轮换 vault ID 表示新的历史分支。现有客户端以 VAULT_MISMATCH 停止，须保留原本地库并在新本地库连接。客户端保存远端游标高水位，检测数据库回退并报告 SERVER_ROLLBACK；不能通过清空客户端状态强行接续。
