# Verification record — 2026-10-12

## Verified locally

- Plugin TypeScript check and esbuild bundle: passed.
- Plugin Vitest tests: 53 passed, including operation-scoped connection isolation.
- Rust PostgreSQL integration scenarios: 10 passed against a dedicated PostgreSQL17 database.
- Rust build, clippy with warnings denied and formatting check: passed.
- Docker Compose configuration, release image build, nonroot runtime UID/GID10001 and both service health checks: passed.
- Real HTTP clients against Docker/Rust/PostgreSQL: 9 scenarios passed: note transfer, binary attachments, simultaneous edits, stable-ID rename, multi-file case-only directory rename, edit/delete conflict, response-loss recovery after client restart, same-ID history restoration and device revocation.
- Server restart retained the database and objects; projections rebuilt successfully.
- Scripted pg_dump plus immutable-object backup and empty-volume restoration: passed with empty and note-containing backups.
- Restored notes, history and readable projection matched; restore rotated vault identity before accepting clients. Running restore target was refused.
- Shell syntax, Compose validation and diff whitespace checks: passed.
- Independent spec and quality reviews: passed after connection-isolation and historical-projection recovery corrections.
- Plugin ZIP contents match the compiled plugin, manifest and stylesheet. Source archive excludes credentials, local data and build caches.

Client regression coverage includes initial nonempty library preview, snapshot tombstone ordering, old identity replaced at the same path, optimistic editor checks, invalid paths, corrupted downloads, cursor pagination, durable response-loss candidates, size/error isolation, conflict destination collisions, rollback detection, history restoration, state-slot corruption, attachment replacement failures and directory casing recovery.

## Verified on the user's fnOS NAS (2026-10-12)

- Release image built on the NAS itself. The build must use `--network=host`: the container DNS resolver configured on this NAS is unreachable from build containers (`Could not resolve host: deb.debian.org`), while the host resolves normally. Unrelated to registry mirrors.
- Library deployment through `scripts/add-library.sh` completed end to end: data directory created, credentials written by the operator (never generated or printed), stack started, `/health` reached.
- Disk permissions resolved: the container runs as the **owner of the data directory**. On this fnOS storage layer an unknown uid (`10001`, the image default) is treated as "other" and cannot write even when the directory is chown'd to it; a known user (uid 1000, `admin`) can. `MINDSYNC_RUN_UID/GID` carries the owner into the container.
- First start on this NAS exceeds the image's default health-check start period (database migration plus readable-tree rebuild), so `compose.yaml` now overrides it (120 s, 5 retries) and `add-library.sh` polls `/health` itself instead of using `compose up --wait`.
- Real HTTP against the deployed service: device registration, object upload, `put` operation commit, `/v1/snapshot` listing and object re-download checksum all passed.
- Readable file tree is present on the NAS disk (`<data dir>/vault/...`) and readable by the `admin` account.
- Two libraries ran side by side: separate ports, data directories and database volumes, and `docker compose -p … down -v` on one left the other healthy.
- Backup and restore on the NAS: `MINDSYNC_LIBRARY=<name> sh scripts/backup.sh` produced `database.dump`, `objects.tar.gz`, `checksums.sha256` and `COMPLETE`; restoring into a freshly prepared empty library (`add-library.sh --no-start` + `restore.sh`) came back healthy with the readable tree rebuilt and the file content byte-identical (sha256 match).
- Naming requirement applied: the first library uses the unsuffixed names (project `mindsync`, containers `mindsync` and `postgres`); later libraries get suffixed names automatically.

## Pending actual environment acceptance

- Installing and using the plugin inside Obsidian on macOS and Windows. A prepared test vault exists on the macOS machine with the plugin installed and a device already registered, but no client-side sync round trip has been observed yet.
- Android phone and tablet Vault/Adapter/requestUrl behavior, foreground transitions and system suspension.
- External network entry point, DNS, valid HTTPS certificate and reverse-proxy upload limits.
- Storage capacity under real note and attachment load (only an empty library has run so far).

Memory clients and mocked Obsidian APIs verify the synchronization state machine and failure recovery. They do not establish real-device compatibility.
