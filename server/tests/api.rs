use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use nas_sync_server::{Config, app};
use serde_json::{Value, json};
use tower::ServiceExt;

const ADMIN: &str = "integration-test-admin-credential-at-least-32-characters";
static DATABASE_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn request(
    router: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = router.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn fixture() -> (Router, tempfile::TempDir) {
    let db = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL must point to a disposable PostgreSQL database");
    let pool = sqlx::PgPool::connect(&db).await.unwrap();
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let dir = tempfile::tempdir().unwrap();
    let router = app(Config {
        data: dir.path().canonicalize().unwrap(),
        database_url: db,
        admin_token: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    (router, dir)
}
#[tokio::test]
async fn postgres_api_integration() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, _dir) = fixture().await;
    let (status, info) = request(&router, "GET", "/v1/info", ADMIN, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["cursor"], 0);
}

async fn upload(router: &Router, token: &str, bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let hash = hex::encode(Sha256::digest(bytes));
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/v1/objects/{hash}"))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(bytes.to_vec()))
        .unwrap();
    let response = router.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    hash
}
fn put(op: &str, id: &str, path: &str, rev: i64, hash: &str, size: usize) -> Value {
    json!({"operation_id":op,"kind":"put","file_id":id,"path":path,"base_revision":rev,"hash":hash,"size":size})
}
async fn operation(router: &Router, token: &str, data: Value) -> (StatusCode, Value) {
    request(router, "POST", "/v1/operations", token, data).await
}
#[tokio::test]
async fn fault_and_conflict_contract() {
    let _serial = DATABASE_TEST.lock().await;
    // Run serially: this suite intentionally resets one disposable test database.
    let (router, dir) = fixture().await;
    let (_, device) = request(
        &router,
        "POST",
        "/v1/devices",
        ADMIN,
        json!({"name":"phone"}),
    )
    .await;
    let token = device["token"].as_str().unwrap();
    let hash = upload(&router, token, b"one").await;
    let create = put("create", "note", "Folder/note.md", 0, &hash, 3);
    let (status, result) = operation(&router, token, create.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["cursor"], 1);
    assert_eq!(
        std::fs::read(dir.path().join("vault/Folder/note.md")).unwrap(),
        b"one"
    );
    assert_eq!(operation(&router, token, create.clone()).await.1, result);
    assert_eq!(
        request(&router, "GET", "/v1/operations/create", token, Value::Null)
            .await
            .1,
        result
    );
    assert_eq!(
        operation(&router, ADMIN, create).await.1["error"]["code"],
        "OPERATION_REUSED"
    );
    assert_eq!(
        request(&router, "GET", "/v1/operations/create", ADMIN, Value::Null)
            .await
            .1["error"]["code"],
        "OPERATION_REUSED"
    );
    let hash2 = upload(&router, token, b"two").await;
    let a = operation(
        &router,
        token,
        put("writer-a", "note", "Folder/note.md", 1, &hash2, 3),
    );
    let b = operation(
        &router,
        token,
        put("writer-b", "note", "Folder/note.md", 1, &hash, 3),
    );
    let (a, b) = tokio::join!(a, b);
    assert_eq!(
        [a.0, b.0].iter().filter(|&&s| s == StatusCode::OK).count(),
        1
    );
    let stale_delete =
        json!({"operation_id":"stale-delete","kind":"delete","file_id":"note","base_revision":1});
    assert_eq!(
        operation(&router, token, stale_delete).await.1["error"]["code"],
        "REVISION_CONFLICT"
    );
    for (n, path) in [
        "folder/other.md",
        "FOLDER/note.md",
        "Folder",
        "Folder/note.md/child",
        "../escape",
        "/absolute",
        "CON.md",
        "a\\b",
        "x/..",
        "x/aux.txt",
        "bad?.md",
        ".obsidian/x",
        "trail. ",
    ]
    .iter()
    .enumerate()
    {
        let (status, result) = operation(
            &router,
            token,
            put(
                &format!("invalid{n}"),
                &format!("bad{n}"),
                path,
                0,
                &hash,
                3,
            ),
        )
        .await;
        assert!(
            status == StatusCode::CONFLICT || status == StatusCode::UNPROCESSABLE_ENTITY,
            "{path}: {result}"
        );
    }
    let (_, info) = request(&router, "GET", "/v1/info", token, Value::Null).await;
    assert_eq!(info["cursor"], 2);
    let (_, page) = request(
        &router,
        "GET",
        "/v1/changes?after=0&limit=1",
        token,
        Value::Null,
    )
    .await;
    assert_eq!(page["until"], 2);
    assert_eq!(page["cursor"], 1);
    assert_eq!(page["has_more"], true);
    let (_, deleted) = operation(
        &router,
        token,
        json!({"operation_id":"delete","kind":"delete","file_id":"note","base_revision":2}),
    )
    .await;
    assert_eq!(deleted["file"]["deleted"], true);
    assert_eq!(deleted["cursor"], 3);
    assert!(!dir.path().join("vault/Folder/note.md").exists());
    assert_eq!(
        operation(
            &router,
            token,
            put("bad-resurrect", "note", "Folder/note.md", 0, &hash, 3)
        )
        .await
        .1["error"]["code"],
        "REVISION_CONFLICT"
    );
    let (_, page2) = request(
        &router,
        "GET",
        "/v1/changes?after=1&until=2&limit=1",
        token,
        Value::Null,
    )
    .await;
    assert_eq!(page2["cursor"], 2);
    assert_eq!(page2["has_more"], false);
    let (_, restored) = operation(
        &router,
        token,
        put("restore", "note", "Folder/note.md", 3, &hash, 3),
    )
    .await;
    assert_eq!(restored["cursor"], 4);
    assert_eq!(
        request(&router, "GET", "/v1/files/note/history", token, Value::Null)
            .await
            .1["versions"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(operation(&router,token,json!({"operation_id":"rename","kind":"rename","file_id":"note","path":"Folder/NOTE.md","base_revision":4})).await.0,StatusCode::OK);
    let names = std::fs::read_dir(dir.path().join("vault/Folder"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| name == "NOTE.md"));
    assert!(!names.iter().any(|name| name == "note.md"));
    std::fs::write(dir.path().join("vault/Folder/NOTE.md"), b"external edit").unwrap();
    let repaired = app(Config {
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        admin_token: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("vault/Folder/NOTE.md")).unwrap(),
        b"one"
    );
    assert_eq!(
        request(&repaired, "GET", "/health", "", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("vault/unsafe")).unwrap();
    assert_eq!(
        operation(
            &repaired,
            token,
            put("symlink", "symlink", "unsafe/escape.md", 0, &hash, 3)
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert!(!outside.path().join("escape.md").exists());
    std::fs::write(dir.path().join(format!("objects/{hash}")), b"bad").unwrap();
    assert_eq!(
        request(
            &repaired,
            "GET",
            &format!("/v1/objects/{hash}"),
            token,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert!(
        app(Config {
            data: dir.path().canonicalize().unwrap(),
            database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
            admin_token: ADMIN.into(),
            max_file_bytes: 1024
        })
        .await
        .is_err()
    );
    assert_eq!(
        request(
            &repaired,
            "POST",
            "/v1/devices",
            token,
            json!({"name":"not allowed"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &repaired,
            "DELETE",
            &format!("/v1/devices/{}", device["id"].as_str().unwrap()),
            ADMIN,
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&repaired, "GET", "/v1/info", token, Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn bounded_upload_and_projection_crash_recovery() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    assert_eq!(
        request(&router, "GET", "/v1/info", "", Value::Null).await.1["error"]["code"],
        "UNAUTHORIZED"
    );
    assert_eq!(
        request(&router, "POST", "/v1/operations", ADMIN, json!({}))
            .await
            .1["error"]["code"],
        "INVALID_REQUEST"
    );
    for query in [
        "after=-1",
        "after=0&until=99",
        "after=bad",
        "after=0&limit=0",
    ] {
        assert_eq!(
            request(
                &router,
                "GET",
                &format!("/v1/changes?{query}"),
                ADMIN,
                Value::Null
            )
            .await
            .1["error"]["code"],
            "INVALID_REQUEST"
        );
    }
    let hash = upload(&router, ADMIN, b"history").await;
    for id in ["__proto__", "constructor", "prototype"] {
        assert_eq!(
            operation(
                &router,
                ADMIN,
                put("reserved-id", id, "reserved.md", 0, &hash, 7)
            )
            .await
            .1["error"]["code"],
            "INVALID_REQUEST"
        );
    }
    for (bytes, expected) in [
        (b"wrong".to_vec(), "HASH_MISMATCH"),
        (vec![1u8; 1025], "FILE_TOO_LARGE"),
    ] {
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/v1/objects/{hash}"))
            .header("authorization", format!("Bearer {ADMIN}"))
            .body(Body::from(bytes))
            .unwrap();
        let response = router.clone().oneshot(req).await.unwrap();
        let data: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(data["error"]["code"], expected);
    }
    assert_eq!(
        std::fs::read_dir(dir.path().join("tmp")).unwrap().count(),
        0
    );
    let (_, created) = operation(
        &router,
        ADMIN,
        put("original", "one", "notes/a.md", 0, &hash, 7),
    )
    .await;
    assert_eq!(created["cursor"], 1);
    let req = Request::builder()
        .uri(format!("/v1/objects/{hash}"))
        .header("authorization", format!("Bearer {ADMIN}"))
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        b"history"
    );
    for (n, path) in ["Straße.md", "caf\u{e9}.md"].iter().enumerate() {
        assert_eq!(
            operation(
                &router,
                ADMIN,
                put(
                    &format!("unicode{n}"),
                    &format!("unicode{n}"),
                    path,
                    0,
                    &hash,
                    7
                )
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    for (n, path) in ["STRASSE.md", "cafe\u{301}.md"].iter().enumerate() {
        assert_eq!(
            operation(
                &router,
                ADMIN,
                put(
                    &format!("collision{n}"),
                    &format!("collision{n}"),
                    path,
                    0,
                    &hash,
                    7
                )
            )
            .await
            .1["error"]["code"],
            "PATH_CONFLICT"
        );
    }
    std::fs::create_dir(dir.path().join("vault/crash.md")).unwrap();
    std::fs::write(
        dir.path().join("vault/crash.md/obstacle"),
        b"external obstacle",
    )
    .unwrap();
    let candidate = put("response-loss", "crash", "crash.md", 0, &hash, 7);
    let (status, result) = operation(&router, ADMIN, candidate.clone()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{result}");
    // The metadata was already committed. This models death between commit and projection.
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/response-loss",
            ADMIN,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    std::fs::remove_file(dir.path().join("vault/crash.md/obstacle")).unwrap();
    let (_, result) = request(
        &router,
        "GET",
        "/v1/operations/response-loss",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(result["cursor"], 4);
    assert_eq!(
        std::fs::read(dir.path().join("vault/crash.md")).unwrap(),
        b"history"
    );
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("keep"), b"outside").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("vault/foreign")).unwrap();
    let rebuilt = app(Config {
        data: dir.path().canonicalize().unwrap(),
        database_url: std::env::var("TEST_DATABASE_URL").unwrap(),
        admin_token: ADMIN.into(),
        max_file_bytes: 1024,
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("vault/crash.md")).unwrap(),
        b"history"
    );
    assert_eq!(
        std::fs::read(outside.path().join("keep")).unwrap(),
        b"outside"
    );
    assert_eq!(operation(&rebuilt, ADMIN, candidate).await.1, result);
    assert_eq!(
        request(&rebuilt, "GET", "/v1/snapshot", ADMIN, Value::Null)
            .await
            .1["cursor"],
        4
    );
    let (_, empty) = request(
        &rebuilt,
        "GET",
        "/v1/changes?after=4&until=4",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(empty["cursor"], 4);
    assert_eq!(empty["has_more"], false);
    let object_path = dir.path().join(format!("objects/{hash}"));
    std::fs::remove_file(&object_path).unwrap();
    std::os::unix::fs::symlink(outside.path().join("keep"), &object_path).unwrap();
    assert_eq!(
        request(
            &rebuilt,
            "GET",
            &format!("/v1/objects/{hash}"),
            ADMIN,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert_eq!(
        operation(
            &rebuilt,
            ADMIN,
            put("bad-object", "bad-object", "bad.md", 0, &hash, 7)
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert_eq!(
        request(&rebuilt, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["error"]["code"],
        "STORAGE_ERROR"
    );
}

#[tokio::test]
async fn replayed_tombstone_preserves_new_file_at_same_path() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let old = upload(&router, ADMIN, b"old").await;
    let new = upload(&router, ADMIN, b"new").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("old-create", "old-id", "reuse.md", 0, &old, 3)
        )
        .await
        .0,
        StatusCode::OK
    );
    let deletion =
        json!({"operation_id":"old-delete","kind":"delete","file_id":"old-id","base_revision":1});
    let result = operation(&router, ADMIN, deletion.clone()).await.1;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("new-create", "new-id", "reuse.md", 0, &new, 3)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(operation(&router, ADMIN, deletion).await.1, result);
    assert_eq!(
        std::fs::read(dir.path().join("vault/reuse.md")).unwrap(),
        b"new"
    );
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        3
    );
}

#[tokio::test]
async fn storage_health_rejects_symlinks_and_nonregular_objects() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    assert_eq!(
        request(&router, "POST", "/v1/info", ADMIN, Value::Null)
            .await
            .1["error"]["code"],
        "INVALID_REQUEST"
    );
    assert_eq!(
        request(&router, "GET", "/v1/objects/%FF", ADMIN, Value::Null)
            .await
            .1["error"]["code"],
        "INVALID_REQUEST"
    );
    let outside = tempfile::tempdir().unwrap();
    let hash = "0".repeat(64);
    let object =
        std::ffi::CString::new(dir.path().join(format!("objects/{hash}")).to_str().unwrap())
            .unwrap();
    assert_eq!(unsafe { libc::mkfifo(object.as_ptr(), 0o600) }, 0);
    assert_eq!(
        request(
            &router,
            "GET",
            &format!("/v1/objects/{hash}"),
            ADMIN,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    std::fs::rename(dir.path().join("tmp"), dir.path().join("original-tmp")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("tmp")).unwrap();
    assert_eq!(
        request(&router, "GET", "/health", "", Value::Null).await.1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn deleted_nested_folder_can_be_reused_as_file() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"replacement").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "nested-create",
                "nested-id",
                "former/deep/note.md",
                0,
                &hash,
                11
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(operation(&router,ADMIN,json!({"operation_id":"nested-delete","kind":"delete","file_id":"nested-id","base_revision":1})).await.0,StatusCode::OK);
    let (status, result) = operation(
        &router,
        ADMIN,
        put("folder-reuse", "replacement-id", "former", 0, &hash, 11),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        std::fs::read(dir.path().join("vault/former")).unwrap(),
        b"replacement"
    );
    assert_eq!(result["cursor"], 3);
}

#[tokio::test]
async fn operation_lookup_repairs_committed_projection() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"recover").await;
    let (_, result) = operation(
        &router,
        ADMIN,
        put("recover-result", "recover-id", "recover.md", 0, &hash, 7),
    )
    .await;
    std::fs::remove_file(dir.path().join("vault/recover.md")).unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/recover-result",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/recover.md")).unwrap(),
        b"recover"
    );
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        1
    );
}

#[tokio::test]
async fn operation_lookup_removes_stale_historical_projection_safely() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"current").await;
    let replacement = upload(&router, ADMIN, b"replacement").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put("history-create", "history-id", "old.md", 0, &hash, 7)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_,renamed)=operation(&router,ADMIN,json!({"operation_id":"history-rename","kind":"rename","file_id":"history-id","path":"new.md","base_revision":1})).await;
    // Model death after commit but before deleting the former projection.
    std::fs::write(dir.path().join("vault/old.md"), b"stale old projection").unwrap();
    std::fs::remove_file(dir.path().join("vault/new.md")).unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        renamed
    );
    assert!(!dir.path().join("vault/old.md").exists());
    assert_eq!(
        std::fs::read(dir.path().join("vault/new.md")).unwrap(),
        b"current"
    );
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "path-replacement",
                "replacement-id",
                "old.md",
                0,
                &replacement,
                11
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        renamed
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/old.md")).unwrap(),
        b"replacement"
    );
    assert_eq!(operation(&router,ADMIN,json!({"operation_id":"replacement-delete","kind":"delete","file_id":"replacement-id","base_revision":3})).await.0,StatusCode::OK);
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "path-descendant",
                "descendant-id",
                "old.md/child.md",
                0,
                &replacement,
                11
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        renamed
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/old.md/child.md")).unwrap(),
        b"replacement"
    );
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        5
    );
    assert_eq!(operation(&router,ADMIN,json!({"operation_id":"descendant-delete","kind":"delete","file_id":"descendant-id","base_revision":5})).await.0,StatusCode::OK);
    assert!(dir.path().join("vault/old.md").is_dir());
    let (status, recovered) = request(
        &router,
        "GET",
        "/v1/operations/history-rename",
        ADMIN,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{recovered}");
    assert_eq!(recovered, renamed);
    assert!(!dir.path().join("vault/old.md").exists());
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        6
    );
    std::fs::create_dir_all(dir.path().join("vault/old.md/empty/deeper")).unwrap();
    std::fs::write(
        dir.path().join("vault/old.md/untracked.md"),
        b"preserve descendant",
    )
    .unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1["error"]["code"],
        "STORAGE_ERROR"
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/old.md/untracked.md")).unwrap(),
        b"preserve descendant"
    );
    std::fs::remove_file(dir.path().join("vault/old.md/untracked.md")).unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/history-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        renamed
    );
    assert!(!dir.path().join("vault/old.md").exists());
}

#[tokio::test]
async fn same_identity_descendant_to_ancestor_recovery() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"recover ancestor").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "ancestor-create",
                "ancestor-id",
                "folder/note.md",
                0,
                &hash,
                16
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    let rename = json!({"operation_id":"ancestor-rename","kind":"rename","file_id":"ancestor-id","path":"folder","base_revision":1});
    let (status, result) = operation(&router, ADMIN, rename.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    // Recreate the committed-rename crash window: metadata names the ancestor,
    // but its former descendant remains as the only readable projection.
    std::fs::remove_file(dir.path().join("vault/folder")).unwrap();
    std::fs::create_dir(dir.path().join("vault/folder")).unwrap();
    std::fs::write(dir.path().join("vault/folder/note.md"), b"stale descendant").unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/ancestor-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/folder")).unwrap(),
        b"recover ancestor"
    );
    // A second lookup/replay must accept that former descendant paths cannot
    // exist below the now-current regular file.
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/ancestor-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(operation(&router, ADMIN, rename).await.1, result);
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        2
    );
}

#[tokio::test]
async fn same_identity_ancestor_to_descendant_recovery() {
    let _serial = DATABASE_TEST.lock().await;
    let (router, dir) = fixture().await;
    let hash = upload(&router, ADMIN, b"recover descendant").await;
    assert_eq!(
        operation(
            &router,
            ADMIN,
            put(
                "descendant-create",
                "descendant-recovery-id",
                "folder",
                0,
                &hash,
                18
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    let rename = json!({"operation_id":"descendant-rename","kind":"rename","file_id":"descendant-recovery-id","path":"folder/note.md","base_revision":1});
    let (status, result) = operation(&router, ADMIN, rename.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    std::fs::remove_file(dir.path().join("vault/folder/note.md")).unwrap();
    std::fs::remove_dir(dir.path().join("vault/folder")).unwrap();
    std::fs::write(dir.path().join("vault/folder"), b"stale ancestor").unwrap();
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/descendant-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(
        std::fs::read(dir.path().join("vault/folder/note.md")).unwrap(),
        b"recover descendant"
    );
    assert_eq!(
        request(
            &router,
            "GET",
            "/v1/operations/descendant-rename",
            ADMIN,
            Value::Null
        )
        .await
        .1,
        result
    );
    assert_eq!(operation(&router, ADMIN, rename).await.1, result);
    assert_eq!(
        std::fs::read(dir.path().join("vault/folder/note.md")).unwrap(),
        b"recover descendant"
    );
    assert_eq!(
        request(&router, "GET", "/v1/info", ADMIN, Value::Null)
            .await
            .1["cursor"],
        2
    );
}
