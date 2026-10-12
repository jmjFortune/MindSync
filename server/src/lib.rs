mod path;
mod storage;
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use std::{path::PathBuf, sync::Arc};
use storage::Storage;
use subtle::ConstantTimeEq;
use tokio::{io::AsyncWriteExt, sync::Mutex};
use uuid::Uuid;

#[derive(Clone)]
pub struct Config {
    pub data: PathBuf,
    pub database_url: String,
    pub admin_token: String,
    pub max_file_bytes: usize,
}
#[derive(Clone)]
struct AppState {
    pool: PgPool,
    storage: Storage,
    admin_hash: String,
    max_file_bytes: usize,
    writer: Arc<Mutex<()>>,
}
#[derive(Clone)]
struct Identity {
    id: String,
    admin: bool,
}
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    current: Option<Option<Box<FileRecord>>>,
}
impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
            current: None,
        }
    }
    fn invalid() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_REQUEST",
            "Invalid request",
        )
    }
    fn invalid_path() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_PATH",
            "Path is not cross-platform safe",
        )
    }
    fn storage() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "STORAGE_ERROR",
            "Storage is unavailable or content integrity verification failed",
        )
    }
    fn missing() -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Record not found")
    }
    fn reused() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "OPERATION_REUSED",
            "Operation ID belongs to a different request or identity",
        )
    }
    fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Administrator credential required",
        )
    }
    fn too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "FILE_TOO_LARGE",
            "File exceeds the configured size limit",
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = json!({"code":self.code,"message":self.message});
        if let Some(current) = self.current {
            error["current"] = json!(current)
        }
        (self.status, Json(json!({"error":error}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self::storage()
    }
}
impl From<std::io::Error> for ApiError {
    fn from(_: std::io::Error) -> Self {
        Self::storage()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FileRecord {
    pub id: String,
    pub path: String,
    pub revision: i64,
    pub hash: String,
    pub size: i64,
    pub deleted: bool,
}
const FILE_COLUMNS: &str = "id,path,revision,hash,size,deleted";
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !matches!(id, "__proto__" | "constructor" | "prototype")
        && id.chars().all(|c| !c.is_control() && c != '/' && c != '\\')
}

pub async fn app(config: Config) -> Result<Router, Box<dyn std::error::Error + Send + Sync>> {
    if config.admin_token.len() < 32 || config.admin_token.chars().any(char::is_whitespace) {
        return Err("NAS_SYNC_ADMIN_TOKEN must be a strong token of at least 32 characters with no whitespace".into());
    }
    if config.max_file_bytes == 0 || config.max_file_bytes > i64::MAX as usize {
        return Err("NAS_SYNC_MAX_FILE_BYTES must be positive".into());
    }
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    sqlx::query("INSERT INTO vault(singleton,id) VALUES(TRUE,$1) ON CONFLICT DO NOTHING")
        .bind(Uuid::new_v4().to_string())
        .execute(&pool)
        .await?;
    let storage = Storage::new(&config.data)?;
    // Verify every historical reference before replacing the readable projection.
    let references=sqlx::query("SELECT DISTINCT hash,size FROM files UNION SELECT DISTINCT record->>'hash' AS hash,(record->>'size')::bigint AS size FROM changes").fetch_all(&pool).await?;
    for row in references {
        storage.verify(row.get("hash"), Some(row.get("size")))?;
    }
    storage.vault.clear()?;
    storage.tmp.clear()?;
    let files = sqlx::query_as::<_, FileRecord>(&format!(
        "SELECT {FILE_COLUMNS} FROM files WHERE NOT deleted ORDER BY path"
    ))
    .fetch_all(&pool)
    .await?;
    for file in files {
        path::normalize(&file.path).map_err(|_| "Invalid path in authoritative metadata")?;
        storage.projection(&file.path, &file.hash, file.size)?;
    }
    let state = AppState {
        pool,
        storage,
        admin_hash: digest(config.admin_token.as_bytes()),
        max_file_bytes: config.max_file_bytes,
        writer: Arc::new(Mutex::new(())),
    };
    let protected = Router::new()
        .route("/v1/info", get(info))
        .route("/v1/devices", get(devices).post(register_device))
        .route("/v1/devices/{id}", delete(revoke_device))
        .route("/v1/snapshot", get(snapshot))
        .route("/v1/changes", get(changes))
        .route("/v1/objects/{hash}", put(upload).get(download))
        .route("/v1/operations", post(operation))
        .route("/v1/operations/{id}", get(operation_result))
        .route("/v1/files/{id}/history", get(history))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Ok(Router::new()
        .route("/health", get(health))
        .merge(protected)
        .fallback(|| async { ApiError::missing() })
        .layer(DefaultBodyLimit::max(65536))
        .layer(middleware::from_fn(structured_errors))
        .with_state(state))
}
// Axum's routing and path extractor errors must obey the same wire contract.
async fn structured_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    let json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    if !(status.is_client_error() || status.is_server_error()) || json {
        return response;
    }
    match status {
        StatusCode::PAYLOAD_TOO_LARGE => ApiError::too_large(),
        StatusCode::NOT_FOUND => ApiError::missing(),
        status if status.is_server_error() => ApiError::storage(),
        _ => ApiError::invalid(),
    }
    .into_response()
}
async fn authenticate(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() <= 1024)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Invalid or revoked credential",
            )
        })?;
    let hash = digest(token.as_bytes());
    let identity = if bool::from(hash.as_bytes().ct_eq(state.admin_hash.as_bytes())) {
        Identity {
            id: format!("admin:{}", state.admin_hash),
            admin: true,
        }
    } else {
        let id = sqlx::query_scalar::<_, String>(
            "SELECT id FROM devices WHERE token_hash=$1 AND NOT revoked",
        )
        .bind(hash)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Invalid or revoked credential",
            )
        })?;
        Identity { id, admin: false }
    };
    request.extensions_mut().insert(identity);
    Ok(next.run(request).await)
}
async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    sqlx::query("SELECT cursor FROM vault")
        .execute(&state.pool)
        .await?;
    state.storage.health()?;
    Ok(Json(json!({"status":"ok"})))
}
async fn info(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let row = sqlx::query("SELECT id,cursor FROM vault")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(
        json!({"protocol":1,"vault_id":row.get::<String,_>("id"),"cursor":row.get::<i64,_>("cursor"),"max_file_bytes":state.max_file_bytes,"storage_bytes":state.storage.usage()?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceRequest {
    name: String,
}
async fn register_device(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    body: Result<Json<DeviceRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let Json(body) = body.map_err(|_| ApiError::invalid())?;
    if body.name.trim().is_empty() || body.name.len() > 200 {
        return Err(ApiError::invalid());
    }
    let id = Uuid::new_v4().to_string();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO devices(id,name,token_hash) VALUES($1,$2,$3)")
        .bind(&id)
        .bind(&body.name)
        .bind(digest(token.as_bytes()))
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"id":id,"name":body.name,"token":token})))
}
async fn devices(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let rows = sqlx::query("SELECT id,name,revoked FROM devices ORDER BY id")
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(
        json!({"devices":rows.into_iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"revoked":r.get::<bool,_>("revoked")})).collect::<Vec<_>>()}),
    ))
}
async fn revoke_device(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let changed = sqlx::query("UPDATE devices SET revoked=TRUE WHERE id=$1")
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError::missing());
    }
    Ok(Json(json!({"id":id,"revoked":true})))
}
async fn snapshot(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let cursor = sqlx::query_scalar::<_, i64>("SELECT cursor FROM vault")
        .fetch_one(&mut *tx)
        .await?;
    let files =
        sqlx::query_as::<_, FileRecord>(&format!("SELECT {FILE_COLUMNS} FROM files ORDER BY id"))
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(Json(json!({"files":files,"cursor":cursor})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangesQuery {
    #[serde(default)]
    after: i64,
    until: Option<i64>,
    limit: Option<i64>,
}
async fn changes(
    State(state): State<AppState>,
    query: Result<Query<ChangesQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let Query(q) = query.map_err(|_| ApiError::invalid())?;
    let latest = sqlx::query_scalar::<_, i64>("SELECT cursor FROM vault")
        .fetch_one(&state.pool)
        .await?;
    let until = q.until.unwrap_or(latest);
    let limit = q.limit.unwrap_or(100);
    if q.after < 0 || until < q.after || until > latest || !(1..=1000).contains(&limit) {
        return Err(ApiError::invalid());
    }
    let rows = sqlx::query_scalar::<_, Value>(
        "SELECT record FROM changes WHERE revision>$1 AND revision<=$2 ORDER BY revision LIMIT $3",
    )
    .bind(q.after)
    .bind(until)
    .bind(limit + 1)
    .fetch_all(&state.pool)
    .await?;
    let has_more = rows.len() > limit as usize;
    let rows = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    let cursor = rows
        .last()
        .and_then(|v| v["revision"].as_i64())
        .unwrap_or(until);
    Ok(Json(
        json!({"changes":rows,"cursor":cursor,"until":until,"has_more":has_more}),
    ))
}
async fn upload(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    if !valid_hash(&hash) {
        return Err(ApiError::invalid());
    }
    if let Some(length) = request.headers().get(header::CONTENT_LENGTH) {
        let length = length
            .to_str()
            .ok()
            .and_then(|n| n.parse::<u64>().ok())
            .ok_or_else(ApiError::invalid)?;
        if length > state.max_file_bytes as u64 {
            return Err(ApiError::too_large());
        }
    }
    let (temp, file) = state.storage.temporary()?;
    let mut file = tokio::fs::File::from_std(file);
    let mut bytes = 0usize;
    let mut hasher = Sha256::new();
    let mut stream = request.into_body().into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::invalid())?;
        bytes = bytes
            .checked_add(chunk.len())
            .ok_or_else(ApiError::too_large)?;
        if bytes > state.max_file_bytes {
            return Err(ApiError::too_large());
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    if hex::encode(hasher.finalize()) != hash {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "HASH_MISMATCH",
            "Body does not match SHA-256",
        ));
    }
    file.flush().await?;
    file.sync_all().await?;
    state.storage.publish(&temp, &hash, bytes as i64)?;
    Ok(Json(json!({"hash":hash,"size":bytes})))
}
async fn download(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    if !valid_hash(&hash) {
        return Err(ApiError::invalid());
    }
    let storage = state.storage.clone();
    let file = tokio::task::spawn_blocking(move || storage.verify(&hash, None))
        .await
        .map_err(|_| ApiError::storage())?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ApiError::missing()
            } else {
                ApiError::storage()
            }
        })?;
    let size = file.metadata()?.len();
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CONTENT_LENGTH, &size.to_string()),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    operation_id: String,
    kind: String,
    file_id: String,
    path: Option<String>,
    base_revision: i64,
    hash: Option<String>,
    size: Option<i64>,
}
async fn operation(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    body: Result<Json<Operation>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(mut op) = body.map_err(|_| ApiError::invalid())?;
    if !valid_id(&op.operation_id)
        || !valid_id(&op.file_id)
        || op.base_revision < 0
        || !matches!(op.kind.as_str(), "put" | "rename" | "delete")
    {
        return Err(ApiError::invalid());
    }
    let mut path_key = None;
    if let Some(path) = &op.path {
        let (path, key) = path::normalize(path)?;
        op.path = Some(path);
        path_key = Some(key)
    }
    match op.kind.as_str() {
        "put" => {
            if op.path.is_none()
                || op.hash.as_ref().is_none_or(|h| !valid_hash(h))
                || op.size.is_none_or(|s| s < 0)
            {
                return Err(ApiError::invalid());
            }
        }
        "rename" => {
            if op.path.is_none() || op.hash.is_some() || op.size.is_some() {
                return Err(ApiError::invalid());
            }
        }
        "delete" => {
            if op.path.is_some() || op.hash.is_some() || op.size.is_some() {
                return Err(ApiError::invalid());
            }
        }
        _ => unreachable!(),
    }
    let fingerprint =
        digest(&serde_json::to_vec(&(identity.id.clone(), &op)).map_err(|_| ApiError::invalid())?);
    let _writer = state.writer.lock().await;
    let mut tx = state.pool.begin().await?;
    let cursor =
        sqlx::query_scalar::<_, i64>("SELECT cursor FROM vault WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    // Recheck revocation inside the commit transaction, closing the authenticate/commit window.
    if !identity.admin
        && !sqlx::query_scalar::<_, bool>("SELECT NOT revoked FROM devices WHERE id=$1 FOR SHARE")
            .bind(&identity.id)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or(false)
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Invalid or revoked credential",
        ));
    }
    if let Some(row) = sqlx::query("SELECT fingerprint,result FROM operations WHERE id=$1")
        .bind(&op.operation_id)
        .fetch_optional(&mut *tx)
        .await?
    {
        if row.get::<String, _>("fingerprint") != fingerprint {
            return Err(ApiError::reused());
        }
        let result: Value = row.get("result");
        tx.rollback().await?;
        repair_file(&state, &op.file_id).await?;
        return Ok(Json(result));
    }
    if op
        .size
        .is_some_and(|size| size as u64 > state.max_file_bytes as u64)
    {
        return Err(ApiError::too_large());
    }
    let current =
        sqlx::query_as::<_, FileRecord>(&format!("SELECT {FILE_COLUMNS} FROM files WHERE id=$1"))
            .bind(&op.file_id)
            .fetch_optional(&mut *tx)
            .await?;
    if current.as_ref().map(|c| c.revision).unwrap_or(0) != op.base_revision
        || (current.is_none() && op.kind != "put")
        || (current.as_ref().is_some_and(|c| c.deleted) && op.kind != "put")
    {
        let mut error = ApiError::new(
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "Base revision does not match current file",
        );
        error.current = Some(current.map(Box::new));
        return Err(error);
    }
    let mut file = if let Some(c) = current.clone() {
        c
    } else {
        FileRecord {
            id: op.file_id.clone(),
            path: op.path.clone().unwrap(),
            revision: 0,
            hash: op.hash.clone().unwrap(),
            size: op.size.unwrap(),
            deleted: false,
        }
    };
    if op.kind != "delete" {
        let target = op.path.as_ref().unwrap();
        let key = path_key.as_ref().unwrap();
        let rows = sqlx::query("SELECT path,path_key FROM files WHERE NOT deleted AND id<>$1")
            .bind(&op.file_id)
            .fetch_all(&mut *tx)
            .await?;
        for row in rows {
            let other: String = row.get("path");
            let other_key: String = row.get("path_key");
            if path::collides(key, &other_key) || path::directory_case_conflict(target, &other) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "PATH_CONFLICT",
                    "Target path or a case-equivalent directory is occupied",
                ));
            }
        }
        if op.kind == "put" {
            file.hash = op.hash.clone().unwrap();
            file.size = op.size.unwrap();
        }
        state.storage.verify(&file.hash, Some(file.size))?;
        // An old projection file can itself be a parent of the new path. Keep
        // it until metadata commits, then replace it with a directory below.
        let old_key = path::normalize(&file.path)?.1;
        if !key.starts_with(&format!("{old_key}/")) {
            state.storage.vault.parent(target, true)?;
        }
        file.path = target.clone();
        file.deleted = false;
    } else {
        file.deleted = true;
    }
    file.revision = cursor.checked_add(1).ok_or_else(ApiError::storage)?;
    let key = path::normalize(&file.path)?.1;
    sqlx::query("INSERT INTO files(id,path,path_key,revision,hash,size,deleted) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,path_key=EXCLUDED.path_key,revision=EXCLUDED.revision,hash=EXCLUDED.hash,size=EXCLUDED.size,deleted=EXCLUDED.deleted").bind(&file.id).bind(&file.path).bind(key).bind(file.revision).bind(&file.hash).bind(file.size).bind(file.deleted).execute(&mut *tx).await?;
    let record = serde_json::to_value(&file).map_err(|_| ApiError::storage())?;
    let result = json!({"file":record,"cursor":file.revision});
    sqlx::query("INSERT INTO changes(revision,file_id,record) VALUES($1,$2,$3)")
        .bind(file.revision)
        .bind(&file.id)
        .bind(&record)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO operations(id,identity,fingerprint,result) VALUES($1,$2,$3,$4)")
        .bind(&op.operation_id)
        .bind(&identity.id)
        .bind(fingerprint)
        .bind(&result)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE vault SET cursor=$1 WHERE singleton")
        .bind(file.revision)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if let Some(old) = current {
        if old.path != file.path || file.deleted {
            let old_key = path::normalize(&old.path)?.1;
            let new_key = path::normalize(&file.path)?.1;
            if !file.deleted && new_key.starts_with(&format!("{old_key}/")) {
                state.storage.remove_ancestor_projection(&old.path)?;
            } else {
                state.storage.remove_projection(&old.path)?;
            }
        }
    }
    if !file.deleted {
        state
            .storage
            .projection(&file.path, &file.hash, file.size)?
    }
    Ok(Json(result))
}
async fn repair_file(state: &AppState, id: &str) -> Result<(), ApiError> {
    let file =
        sqlx::query_as::<_, FileRecord>(&format!("SELECT {FILE_COLUMNS} FROM files WHERE id=$1"))
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    if let Some(file) = file {
        let active_paths = sqlx::query("SELECT id,path_key FROM files WHERE NOT deleted")
            .fetch_all(&state.pool)
            .await?;
        let historical_paths = sqlx::query_scalar::<_, String>(
            "SELECT DISTINCT record->>'path' FROM changes WHERE file_id=$1",
        )
        .bind(id)
        .fetch_all(&state.pool)
        .await?;
        // A commit can precede removal of an old rename/delete projection.
        // Historical paths may now belong to another file, including a new
        // ancestor or descendant; never remove a currently occupied path.
        for historical in historical_paths {
            let key = path::normalize(&historical)
                .map_err(|_| ApiError::storage())?
                .1;
            let occupied = active_paths.iter().any(|active| {
                let owner: &str = active.get("id");
                let active_key: &str = active.get("path_key");
                if owner == id {
                    key == active_key
                } else {
                    path::collides(&key, active_key)
                }
            });
            if !occupied {
                let contains_current = active_paths.iter().any(|active| {
                    let owner: &str = active.get("id");
                    let active_key: &str = active.get("path_key");
                    owner == id && active_key.starts_with(&format!("{key}/"))
                });
                if contains_current {
                    state.storage.remove_ancestor_projection(&historical)?;
                } else {
                    state.storage.remove_projection(&historical)?;
                }
            }
        }
        if !file.deleted {
            state
                .storage
                .projection(&file.path, &file.hash, file.size)?
        }
    }
    Ok(())
}
async fn operation_result(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let _writer = state.writer.lock().await;
    let row = sqlx::query("SELECT identity,result FROM operations WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(ApiError::missing)?;
    if row.get::<String, _>("identity") != identity.id {
        return Err(ApiError::reused());
    }
    let result: Value = row.get("result");
    let file_id = result["file"]["id"]
        .as_str()
        .ok_or_else(ApiError::storage)?;
    repair_file(&state, file_id).await?;
    Ok(Json(result))
}
async fn history(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let versions = sqlx::query_scalar::<_, Value>(
        "SELECT record FROM changes WHERE file_id=$1 ORDER BY revision",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    if versions.is_empty() {
        return Err(ApiError::missing());
    }
    Ok(Json(json!({"versions":versions})))
}
