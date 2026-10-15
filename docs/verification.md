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

# Plugin 0.3.1 status bar removal — 2026-10-14

User requested removal of MindSync's bottom status bar entry. Removed registration, element, renderer and renderer calls. Existing command palette status/conflict access, live progress within the status modal, ribbon action, settings tab and synchronization state remain.

Single-worker plugin regression suite: 99 passed. TypeScript/esbuild build passed. Source and compiled bundle no longer register a status bar item. Main/test vault installations match the 0.3.1 build; all prior settings/credentials/journals were verified byte-identical. Private pre-update backups remain under backups/obsidian-main-plugin-pre-0.3.1-20261014 and backups/obsidian-test-plugin-pre-0.3.1-20261014.

Computer Use still reports permissions are not granted. No actual plugin reload or visual disappearance was observed; reload Obsidian or toggle MindSync off/on to activate the installed build. Rust/NAS runtime remains 0.3.0 and requires no restart.

# Plugin 0.3.2 settings cleanup — 2026-10-14

The user requested centered connection controls, Save changes, retained token visibility, and removal of explanatory small text. Native setting rows use scoped center alignment/wrapping. Static helper descriptions and instructional paragraphs were removed while actual status, errors, file/revision details remain. Tokens stay masked with an accessible Show/Hide button.

Connection fields and configuration selection now use drafts and explicit Save changes. Writes are serialized and persist before activating a new settings object. Changed fields check their baseline; untouched values merge with the latest saved state. Failed writes do not switch the in-memory connection. Registration checks its captured server before installing returned credentials. Device-name changes apply to the active engine's subsequent conflict metadata. Unsaved forms disable dependent connection/publication actions.

Read-only configuration inventory works before enabling the feature and does not initialize/modify its journal, flush a durable candidate or upload/apply content. Regression coverage uses an actual pending upload to verify that boundary.

Single-worker suite: 109 passed; TypeScript/esbuild build passed. New tests cover draft isolation, durable-before-active settings, failed saves, concurrent writes, updated token preservation, stale credential edits, server changes during registration, staged configuration selection, read-only inventory, and live device-name application. The first device-name test incorrectly assumed filenames retain the full name; existing filename tags are limited to 12 characters. The corrected assertion verifies full conflict metadata without changing filename behavior.

Both local vaults installed 0.3.2 after private backups; existing data.json and all journals verified byte-identical. Both current tokens remain 64 characters, match all pre-update backups and authenticate with HTTP 200. No token values were printed. Native UI permissions remain unavailable: reload and actual host layout/keyboard/theme confirmation remain user-side. Rust/NAS stays 0.3.0.

# Plugin 0.3.3 native sidebar — 2026-10-14

Added a native MindSync ItemView alongside existing right-sidebar tabs. Startup creates a separate tab without replacing other views, revealing the sidebar, or requesting active focus. Explicit ribbon/command opening reveals the view. Restored/deferred leaves are reused without accessing their unloaded view; simultaneous opens share a single creation promise. Failed opens can be retried.

The native toolbar delegates sync, preview, pause/resume, history and settings/plugin management to existing operations. Local snapshots and state-change subscriptions provide progress, last-success time, pending operations, configuration updates and conflict actions without new polling or network requests. Busy/readiness guards apply both when rendering and at click time. A running manual transfer takes precedence over paused automatic sync and old errors. Toolbar identity survives progress updates. View close/component unload unsubscribes, late failures do not touch a closed view, and subscriber exceptions cannot break durable settings saves.

Single-worker suite: 125 passed, including 16 sidebar/state/plugin integration cases. TypeScript/esbuild build passed. English source/bundle, release version 0.3.3, native view registration, Save changes retention and bottom-status-bar exclusion checks passed. The previous 109-test baseline also passed before implementation. Server/network behavior is unchanged; no Rust, Docker or NAS rebuild is needed.

Main/test vault plugin trios match the 0.3.3 build. All existing non-build files, including credentials, data.json and journals, remained byte-identical. Complete private plugin backups were verified before installing under backups/obsidian-main-plugin-pre-0.3.3-20261014 and backups/obsidian-test-plugin-pre-0.3.3-20261014, with mode-700 roots.

Actual Obsidian access again returned "Computer Use permissions are not granted". Tests use a minimal native-API runtime fixture and verify behavior rather than actual host rendering. Sidebar visual placement, theme/keyboard/mobile appearance and the running-session reload are not confirmed; reload the installed plugin to activate it.

# Plugin 0.3.4 native typography and inline pages — 2026-10-14

The user's actual screenshot showed inherited document-sized text, an oversized default h3 and a visible empty review button. The previous sidebar CSS did not set native navigation typography. Reading the installed Obsidian 1.14.4 stylesheet confirmed --nav-item-size uses native UI font-size tokens. The sidebar now uses that token with --font-ui-small fallback, the interface font and inherited compact headings/form text. Scoped [hidden] display suppression prevents theme button display rules from showing empty actions.

Removed all MindSync Modal and Notice usage. Preview, history/restore, configuration selection/publication/review, preserved-copy viewing and status use the existing native panel. Success/error feedback is inline, including the plugin settings page. The toolbar and live status remain stable while pages and unsaved configuration drafts are open. Back returns to overview; generation/session checks discard late results after navigation, close or unload without reopening stale pages.

First-sync approval remains explicit. Preview and history restore check the captured connection identity before applying actions. Configuration grouping, keep-local/use-remote, staged selection Save changes and existing engine concurrency/journals are preserved. No extra polling, server change or NAS rebuild is introduced.

134 single-worker client tests passed, including 25 sidebar/UI/plugin integration cases. New coverage checks inline navigation/session invalidation, draft/control preservation during progress, explicit preview approval and changed credentials, late preview/review results, history server changes, selection Save changes, complete configuration-group selection and inline manual-sync success. The runtime fixture makes Modal/Notice construction throw. TypeScript/esbuild passed; English source/bundle, no-popup constructors/imports, native typography/hidden CSS, unchanged dependency entries and bottom-status-bar exclusion audits passed.

Current main vault installed 0.3.4 after a complete verified private backup under backups/obsidian-main-plugin-pre-0.3.4-20261014 (mode 700). All existing non-build plugin files, including credentials, settings and journals, remained byte-identical. The previous test vault directory no longer exists and was not recreated. Installation initially reached that missing directory after successfully updating the main vault; a subsequent read-only audit confirmed main installation and preservation. Actual native rendering, keyboard/theme/mobile behavior and running-session reload remain unverified because native UI permissions were unavailable earlier in this task; reload the installed plugin to activate it.

# Plugin 0.3.5 path-error feedback and supplied icon — 2026-10-14

The user screenshot's INVALID_PATH comes from a colon in a local directory name. Client and server both reject Windows-incompatible characters. A read-only path inventory found 10 markdown paths in two such directories. Existing sync still completes unrelated transfers before reporting errors; preview aborts on its first invalid path. User-authored paths/content and the existing validation/exclusion policy remain unchanged while a path-handling choice is pending.

Fixed preview/history failure cleanup: loading nodes are removed in finally when the page session is active; inline errors remain and no approval/restore controls are offered after a failed load. Two new regressions verify those boundaries. Full single-worker suite: 136 passed; TypeScript/esbuild passed.

The user-supplied brain-circuit SVG is stored byte-identically in plugin/assets/brain-circuit.svg and bundled as text. The installed Obsidian runtime confirms its custom-icon viewport is 100 units; the 28-unit path is scaled without altering shape and uses currentColor. Native registration precedes view/ribbon creation. An executable compiled-icon check verified the real registered ID, supplied path data, scale and theme color. Sidebar tab and ribbon use the new icon; the Sync now action keeps its refresh icon.

English source/bundle, no-popup/status-bar exclusion, unchanged dependency entries and original SVG identity passed. Current main vault installed 0.3.5 with byte-identical existing non-build files after a verified private backup under backups/obsidian-main-plugin-pre-0.3.5-20261014 (mode 700). The deleted test vault was not recreated. Actual Obsidian icon rendering/reload remains unverified; reload the installed plugin to activate it. No Rust/NAS changes or production content operations were performed.

# Plugin 0.3.6 community-directory readiness — 2026-10-15

The user asked why MindSync cannot be found in the in-app Community plugins browser. Verified cause: the plugin was never submitted to the community directory. `community-plugins.json` in `obsidianmd/obsidian-releases` contains no `mindsync` entry, and a GitHub release alone does not add a plugin to the directory. Four repository-side gaps were identified against the published submission requirements and developer policies: no `LICENSE`, no `manifest.json` at the repository root, release tags prefixed with `v` while `manifest.version` is unprefixed, and no explicit README network-use disclosure.

0.3.6 addresses the repository-side gaps without changing sync behavior. Added `LICENSE` (MIT, "MindSync contributors"). Added a repository-root `manifest.json` that is a byte-identical copy of `plugin/manifest.json`, produced by the new `scripts/sync-manifest.mjs`; `scripts/package.mjs` now runs it before packaging and exits non-zero on drift, and the source archive additionally carries `LICENSE` and the root `manifest.json`. Added the README section "网络访问与隐私" with a Chinese description and an English summary disclosing that the plugin contacts only the user-supplied self-hosted server under `/v1/*`, with no hardcoded third-party endpoints, telemetry, ads, self-update or remotely loaded code. Future releases use a tag equal to the manifest version, starting with `0.3.6`.

Client verification: 136 single-worker tests passed, including the configuration, sidebar and chunk suites; TypeScript and esbuild build passed. Package audits: the ZIP contains exactly `mindsync/main.js`, `mindsync/manifest.json` and `mindsync/styles.css`; the bundled `main.js` is byte-identical to `plugin/main.js` (sha256 9310e8e6b6c426e1f16d21586b7b68492537948272d86c12da1992d7b89726de); ZIP and root manifest report version 0.3.6; the source archive contains `LICENSE` and `manifest.json` and no `.env`, `.git`, `node_modules`, `main.js`, `dist/` or AppleDouble entries; `plugin/main.js`, `styles.css`, both manifests and all tracked plugin sources contain no Han characters; and no `Modal`, `Notice` or `addStatusBarItem` constructor remains in the bundle. Checksums: `a67c2430daf6658dfee28dc0a1758d68ede6a072b1f532a3078c3bb57a4f9a7a` for the plugin ZIP and `24f891f89e757d566a9a81f8915456eb682a72fcabfd86c9b74bd972cafa6215` for the source archive.

Not covered: submission to community.obsidian.md itself requires the owner's Obsidian account, so it remains a manual user step after the release is published; directory review feedback and any resulting policy changes are unknown; `versions.json` is intentionally not added because the current directory flow resolves releases by manifest version; and no installed vault was modified, so the installed 0.3.5 plugin trio is unchanged and still needs a reload to show 0.3.6.
