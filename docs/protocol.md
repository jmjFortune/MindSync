# MindSync HTTP API v1

除 GET /health 外，全部 API 使用 Authorization: Bearer <token>。单用户单库，vault_id 由 GET /v1/info 返回。JSON 的文件记录为 {id,path,revision,hash,size,deleted}，hash 在删除记录中可保留旧对象哈希。所有 revision 为全库递增整数，与变更 cursor 相同。

- GET /health → {status: "ok"}
- GET /v1/info → {protocol:1,vault_id,max_file_bytes,cursor,storage_bytes}
- POST /v1/devices，管理令牌授权，body {name} → {id,name,token}；GET /v1/devices 列表，DELETE /v1/devices/{id} 撤销。设备令牌不能创建或删除设备。
- GET /v1/snapshot → {files:FileRecord[],cursor}，包含删除记录，读取处于同一个数据库快照。
- GET /v1/changes?after=N&until=U&limit=100 → {changes:FileRecord[],cursor,until,has_more}。首次省略 until，固定当前上界。cursor 是最后一项 revision；空页取 until。
- PUT /v1/objects/{sha256}，二进制 body → {hash,size}；校验摘要和配置上限。
- GET /v1/objects/{sha256} → application/octet-stream。
- POST /v1/operations，body {operation_id,kind:"put"|"rename"|"delete",file_id,path?,base_revision,hash?,size?} → {file:FileRecord,cursor}。新建 base_revision=0，已有文件必须提供精确 revision。删除文件 ID 不允许以 base_revision=0 复活；恢复通过 put + 最新 tombstone revision。rename 不修改内容，put 可同步更新路径。
- GET /v1/operations/{operation_id} → 已提交操作结果；不存在返回 404。operation_id 在全库唯一，请求指纹包括设备 ID，同 ID 内容不同返回 409 OPERATION_REUSED。
- GET /v1/files/{id}/history → {versions:FileRecord[]}，客户端用某版本对象重新提交 put 实现恢复。
- 备份使用部署脚本：停止同步服务，pg_dump PostgreSQL，再归档 objects，恢复后服务重建文件投影。

错误统一为 {error:{code,message,current?}}。401 UNAUTHORIZED；403 FORBIDDEN；404 NOT_FOUND；409 REVISION_CONFLICT（含 current，可能 null）、PATH_CONFLICT、OPERATION_REUSED；413 FILE_TOO_LARGE；422 INVALID_PATH、INVALID_REQUEST、HASH_MISMATCH；503 STORAGE_ERROR。

初次连接不推断本地删除；游标与本地确认状态只有持久化成功才前移。客户端所有上传操作先持久化 operation ID 及不可变候选内容，响应丢失后先查询操作结果。

## 恢复旧备份的客户端行为

恢复脚本保留备份时的文件版本和游标，但更换 vault ID 表示新的历史分支。现有客户端以 `VAULT_MISMATCH` 停止，要求保留原本地库并在新的本地库重新连接。客户端另外保存远端游标高水位，检测手动数据库回退并报告 `SERVER_ROLLBACK`；正确恢复必须使用更换身份的恢复脚本，不能仅依赖游标下降。不会自动清空基线或误判删除。旧备份恢复不是现有客户端的透明接续。
