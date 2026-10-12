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
- Actual Windows/macOS Obsidian UI, Android hardware and external access remain unverified.
- fnOS acceptance (2026-10-12): build on the NAS needs `docker build --network=host` because the container resolver is unreachable from build containers there; containers must run as the data directory's owner because the storage layer denies unknown uids (10001) write access even after chown; the first start needs a longer health start period and a self-polled `/health` instead of `compose up --wait`.
- Libraries: one library equals one compose project plus one data directory plus one admin token. The first library uses unsuffixed names (project `mindsync`, containers `mindsync`/`postgres`); later libraries must be suffixed because container names are host-unique. `backup.sh`/`restore.sh` read the project name from the library env.
