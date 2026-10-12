# Technical findings

- Project: /Users/shiyun/Desktop/MindSync, branch feat/docker-sync.
- User chose TypeScript + Rust/Axum/SQLx + PostgreSQL17; no Python/SQLite application dependencies.
- Plugin uses Obsidian Vault, Adapter and requestUrl without desktop Node/Electron dependencies.
- PostgreSQL and immutable objects live on local NAS disks; database port remains private.
- SHA-256 verified objects are authoritative alongside committed metadata; readable files are rebuildable projections.
- Independent review added regressions for stale tombstones, same-path replacement, casing, initial merge previews and interrupted writes.
- Restore rotates vault identity before accepting clients to separate history branches, including recycled revision numbers.
- Docker uses dedicated mindsync UID/GID10001; image and healthy Compose startup verified.
- Real HTTP sync and PostgreSQL/object backup restoration verified.
- Actual fnOS, Obsidian UI on Windows/macOS, Android hardware and external access remain unverified.
