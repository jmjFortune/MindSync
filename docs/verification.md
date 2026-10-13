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

# Protocol v2 verification — 2026-10-13

The user initially requested low load while sleeping, then explicitly permitted verification with limited concurrency. Plugin tests ran with one worker and Rust with CARGO_BUILD_JOBS=1 under nice; PostgreSQL used an isolated loopback test container. Production data was never used by schema-reset tests.

## Verified locally

- Plugin Vitest: 73 passed. Large-buffer assertions use native binary equality, avoiding costly generic deep comparison; the 10 MiB restart case runs in about 1.8 seconds.
- Plugin TypeScript check and esbuild bundle: passed, version 0.2.0.
- Dedicated PostgreSQL API suite: 15 passed, including missing-chunk transaction rollback, ordered manifests, rename/delete references, startup projection rebuild, history restore, reconstructed v1 schema/ledger upgrade and concurrent upload/GC.
- Rust build, all-targets clippy with warnings denied and rustfmt check: passed.
- Original real HTTP integration: 9 scenario groups passed, covering note/binary transfer, conflict copies, renames including directory casing, delete/edit conflict, committed response loss, historical restore and token revocation.
- Real HTTP v2: identical 2 MiB content at a second file identity generated zero additional chunk PUT requests; downloaded SHA-256 matched. A 10 MiB simulated restart resumed 1,950,374 bytes. Exit before commit resumed with zero repeated PUTs.
- Genuine SIGKILL acceptance with actual ObsidianLocal checksum-protected state slots and a disk-backed headless Vault adapter: 6,304,119 bytes acknowledged before termination, 4,026,105 bytes resumed (< 5 MiB). The small difference from total size represents in-flight chunks persisted without client acknowledgement. SHA-256 matched after restart; terminating before commit led to zero additional PUTs. A simulated 30-second transport outage recovered automatically after 36,878 ms.
- Synthetic binary three-version fixture: physical increment 2,520,212 bytes / logical increment 6,291,456 bytes = 0.4005769.
- Valid deterministic PDF fixture (2,690,787 bytes, one readable/rendered page) with three trailing-comment versions: physical increment 2,890,946 bytes / logical increment 8,072,460 bytes = 0.3581245. This is a generated fixture, not a claim about all PDFs or compressed incremental edits.
- Manual GC HTTP verification on disposable data: dry-run preserved objects; actual collection reclaimed one 61-byte unreferenced object; logical bytes unchanged; pending object preserved after grace renewal. All object timestamps were aged in the PDF fixture library to exercise reference retention; all 7 nondeleted historical versions remained hash-verifiable afterward.
- Original fnOS notes backup downloaded, checksum verified and restored into a separate local database; v1 schema migrated to v2 and service health passed. The current production notes backup is empty (0 objects); nonempty legacy object/history compatibility is separately covered by the v1 migration integration scenario.
- Plugin ZIP contains exactly main.js, manifest.json, styles.css and matches built files. Source archive excludes credentials, local data, build caches, Finder metadata and Mac extended attributes. Archive SHA-256 checksums verified.

The SIGKILL/outage fixture executes the real journal and sync engine but substitutes a headless disk Vault adapter and a test retry loop. It does not establish actual Obsidian UI lifecycle, Android requestUrl behavior, application suspension or hardware acceptance.

## Reproduce using disposable libraries

Rust fixtures drop the database public schema; never point them at a production database. Run one test/compiler worker to limit load:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/mindsync_test CARGO_BUILD_JOBS=1 cargo test --manifest-path server/Cargo.toml --locked -- --test-threads=1
npm test --prefix plugin -- --maxWorkers=1 --no-file-parallelism
npm run build --prefix plugin
CARGO_BUILD_JOBS=1 cargo clippy --manifest-path server/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt --manifest-path server/Cargo.toml -- --check
```

Start fresh disposable loopback v2 services, set their MINDSYNC_TEST_URL and MINDSYNC_ADMIN_TOKEN privately, then use:

```sh
npm exec --prefix plugin -- esbuild scripts/chunk-acceptance.ts --bundle --platform=node --format=esm --outfile=plugin/dist/chunk-acceptance.mjs
node plugin/dist/chunk-acceptance.mjs
# To measure the PDF case, create a valid deterministic fixture (reportlab/Pillow):
python3 scripts/make-test-pdf.py
# Set MINDSYNC_TEST_PDF=/absolute/path/to/nas-data/dedup-fixture.pdf, use another fresh library.
node plugin/dist/chunk-acceptance.mjs

npm exec --prefix plugin -- esbuild scripts/process-acceptance.ts --bundle --platform=node --format=esm --alias:obsidian=./scripts/obsidian-test-runtime.mjs --outfile=plugin/dist/process-acceptance.mjs
# Use another fresh library; subprocesses really receive SIGKILL.
node plugin/dist/process-acceptance.mjs

npm exec --prefix plugin -- esbuild scripts/gc-acceptance.ts --bundle --platform=node --format=esm --outfile=plugin/dist/gc-acceptance.mjs
# Set MINDSYNC_TEST_DATA to the corresponding local nas-data fixture directory.
node plugin/dist/gc-acceptance.mjs
```

GC acceptance ages objects and performs collection, and is deliberately restricted to fixture data. Do not point it at notes or other user libraries. The three transfer/kill fixtures require a fresh empty service; original integration may run afterwards. Packaging: `node scripts/package.mjs`.

## fnOS v2 status

Release image `mindsync:v0.2.0` built successfully on the NAS with one Cargo job and host networking (16m57s). The first build failed because an older Mac archive contained an AppleDouble SQL sidecar; clean tar packaging and Docker context exclusions fixed this. Image digest: `sha256:eff8f04cb5980774d4cdead95d071a3e859db31e7b19e2cf454685165914f3bc`.

Dedicated NAS loopback HTTP acceptance ran with Node v24.15.0, nice priority, an application CPU limit of 0.5 and PostgreSQL limit of 0.25. SSH port forwarding was denied by sshd, so tests ran on the NAS itself without changing SSH settings.

- Identical 2 MiB upload: zero additional PUTs; hash round trip passed.
- 10 MiB memory-client restart: 1,950,374 bytes resumed; before-commit restart: zero repeated PUTs.
- Valid PDF three-version physical/logical ratio: 2,890,946 / 8,072,460 = 0.358124537.
- All 9 original HTTP scenario groups passed, including concurrent conflict copies, directory casing rename, committed response loss, history restoration and device revocation.
- Manual GC on fixture data with all objects aged eight days reclaimed only one 61-byte orphan. Logical bytes stayed unchanged, all 7 historical versions remained readable and pending blocks stayed present after grace renewal.
- Genuine process SIGKILL/headless journal recovery: 6,304,119 acknowledged bytes; 4,092,761 resumed bytes (< 5 MiB); before-commit restart caused zero PUTs. A simulated 30-second outage recovered automatically after 46,297 ms.

Production notes was healthy with cursor 0 before upgrade. Upgrade-before backup is at `/vol1/1000/docker/mindsync/backups/pre-v2-20261013`; an additional final backup is at `/vol1/1000/docker/mindsync/backups/pre-v2-final-20261013`, with its local copy checksum-verified. The previous image is retained as `mindsync:pre-v2-20261013`. Production notes is running the verified 0.2.0 image as uid/gid 1000:1001 and is healthy. `/v1/info` reports protocol 2 with the same vault identity, cursor 0 and storage size 0 as before upgrade; migrations 0001 and 0002 both succeeded. The existing Mac device token still authenticates. No GC has been run against production, and no LiveSync data or deployment is touched. Dedicated NAS test containers, network and data directories were removed after acceptance. The macOS test vault plugin files match version 0.2.0; configuration and journal slots were retained, and the application needs a plugin reload.

## Remaining hardware checks and limits

Real Obsidian lifecycle/foreground behavior on macOS/Windows/Android, mobile requestUrl and storage memory under real attachments still require hardware acceptance. Manual GC never deletes retained history; it only reclaims unreferenced objects after the grace period. The plugin retains complete-file Vault reads, Web Crypto hashes, base64 journal candidates and complete-file replacement, so the default 50 MiB limit remains. Whole-file streaming and read caching belong to optional phase 4.

# English plugin release — 2026-10-13

Plugin 0.2.1 uses English for settings, commands, notices, sync plans, status/history/conflict dialogs, error messages, and date formatting. CLI output, source/configuration comments, and package descriptions are English. Documentation may remain Chinese; AGENTS.md records the project language rule. Unicode filename tests retain the same values through escapes.

Verification: all 73 plugin tests passed with one worker; TypeScript/esbuild build passed; shell syntax, English CLI usage, Compose configuration and non-document source language audit passed. Both the main Obsidian Vault and the separate test vault contain byte-identical 0.2.1 plugin files, with original credentials, pause settings and journal slots preserved. Their existing device tokens authenticate against protocol 2. Reload the plugin to load the updated UI; actual GUI rendering has not been observed. The unchanged Rust backend remains 0.2.0.

# Configuration sync 0.3.0 — 2026-10-13

## Local evidence

- Plugin single-worker suite: 99 passed (25 configuration scenarios, one additional scoped API route case, all existing regressions). TypeScript/esbuild build passed.
- Disposable PostgreSQL API suite: 18 passed, covering scope isolation/projection restart/history/rename/delete/auth, forbidden private paths, package descriptor validation, and old notes fingerprint replay across migrations 1–3.
- Rust debug build, all-targets clippy with warnings denied, rustfmt and diff whitespace checks passed.
- Actual loopback HTTP/disk acceptance: 8 selected JSON/theme/snippet/plugin files round-tripped into a custom configDir, staged without early target writes, note/configuration app.json paths stayed isolated, private workspace/MindSync files excluded, and stale local previews rejected.
- A committed reply was discarded, then actual disk journal reloaded: zero repeated PUTs.
- Real child process received SIGKILL after writing the first JSON of a group. Reloading ConfigurationLocal rolled both files back to their original bytes and cleared the intent. This uses a disk-backed DataAdapter fixture rather than Obsidian itself.
- Original notes HTTP suite: 9 scenario groups passed after configuration acceptance.

Additional regressions cover local/remote changes after preview, atomic candidate journaling, partial remote package markers, changed-group approval, interrupted uploads, whole-group rollback, concurrent editor preservation, incompatible/invalid plugin manifests, enabled-list filtering, feature disable, corrupted content and journal fallback. Plugin code groups publish with matching descriptors; data.json is independently publishable but grouped with code for local apply. Missing optional local files retain remote files; plugin uninstall propagation is deferred.

## Reproduction

Use a fresh disposable service on loopback and the public fixture admin credential, never a production library:

```sh
npm exec --prefix plugin -- esbuild scripts/configuration-acceptance.ts --bundle --platform=node --format=esm --outfile=plugin/dist/configuration-acceptance.mjs
# Set MINDSYNC_TEST_URL and MINDSYNC_ADMIN_TOKEN for the disposable service.
node plugin/dist/configuration-acceptance.mjs
```

Results: nas-data/configuration-acceptance.json. Existing integration.mjs may run afterwards. The acceptance script actually kills its child process and cleans its own temporary vaults.

## Device/UI boundary

Computer Use still reports that macOS permissions are not granted. No new settings-selection/preview/apply UI has been visually observed inside Obsidian. Native Obsidian Settings/Modal controls, mobile API signatures, and platform/version checks are present, but actual macOS/Windows/Android configuration loading, restart behavior, keyboard/dark/mobile layout and lifecycle require separate hardware/UI acceptance. No real user configuration was published or imported during fixtures.

## NAS and installation evidence

- Final NAS image built with one Cargo job, host networking and cached dependencies; application release compilation took 2m25s. Image SHA-256: fb20548134f86f702c4eb0ebb498da1fe1adfa5ae445f2a776344d50a3072573.
- Disposable NAS loopback configuration/disk/SIGKILL acceptance passed with the same 8 selected files, exclusions, scope separation, stale-preview rejection and zero repeated PUTs. Original notes HTTP 9 scenario groups passed afterwards. App CPU limit 0.5, PG 0.25, Node nice priority; no production fixture writes.
- Fixture startup check initially exited during PostgreSQL's temporary initialization server shutdown. Requiring TCP readiness waited for the final database process; application acceptance then passed.
- Before production upgrade, backup.sh completed a database/object backup under backups/pre-configuration-20261013. NAS checksums and downloaded local copy backups/pre-configuration-nas-20261013 both passed. Previous production image retained as mindsync:pre-configuration-20261013.
- Production notes library upgraded to 0.3.0 after isolated acceptance. Same vault identity and cursor 0, storage/logical bytes 0 before/after; configuration_sync/configuration_groups available. Migration versions 1/2/3 successful, uid/gid 1000:1001; notes.env remains mode 600. Empty production backup does not establish nonempty upgrade recovery; the dedicated legacy-history migration tests cover that separately.
- Main vault /Users/shiyun/Documents/Obsidian Vault and test vault /Users/shiyun/Documents/MindSync 测试 installed plugin 0.3.0. All three installed files match the build, credentials/settings/journals remain byte-identical. Both original device tokens authenticated against upgraded production. Main vault remains paused, test vault keeps its previous unpaused setting, and configuration sync remains disabled by default.
- Private pre-install plugin backups retained under backups/obsidian-main-plugin-pre-configuration-20261013 and backups/obsidian-test-plugin-pre-configuration-20261013. No real configuration was automatically published/applied. Reloading Obsidian is still required for the running session to load new code.
- Final ZIP/source contents matched current files; original device credentials excluded, caches/local data/Finder metadata excluded, SHA-256 checksums and English bundle audit passed. Disposable local/NAS services, network and staging were removed; production remains healthy and private backups/previous image remain.

# Rename notes library to obsidian — 2026-10-13

User explicitly requested the existing notes library be named obsidian. Actual data root moved in place from /vol1/1000/libraries/notes to /vol1/1000/libraries/obsidian. Docker /data points to the new root, environment definition is libraries/obsidian.env, and .mindsync-library is obsidian. Compose project/container/database/image/port remain unchanged; no rebuild or data migration.

Before starting the renamed service, complete file/history/operation/device metadata digests matched and the immutable objects directory retained its inode. Post-start metadata matched exactly: revision 24 and 24 file records, same library identity/history/operation ledger/device hashes. Both installed vaults authenticated using their original URL/token. Production health is healthy; new environment file is mode 600; old directory/environment file are absent.

Initial permission verification failed because fnOS ignored Node creation mode and inherited 755; the recovery guard restored the original directory/mount. A nonsecret isolated file reproduced creation as 755, and explicit chmod set it to 600. Final retry explicitly sets/checks private directory/file modes before stopping the service and succeeded. Private original configuration and metadata checkpoints remain in backups/pre-rename-notes-to-obsidian-20261013-final (directory mode 700). No real file contents or credentials were printed.
