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

## Pending actual environment acceptance

- Installing and using the plugin inside Obsidian on macOS and Windows.
- Android phone and tablet Vault/Adapter/requestUrl behavior, foreground transitions and system suspension.
- Building/deploying on the user's fnOS NAS hardware and checking disk permissions and storage capacity.
- External network entry point, DNS, valid HTTPS certificate and reverse-proxy upload limits.

Memory clients and mocked Obsidian APIs verify the synchronization state machine and failure recovery. They do not establish real-device compatibility. Docker tests ran on the local macOS Docker environment rather than the user's NAS.
