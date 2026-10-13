# Configuration sync implementation plan

Approved design: ../specs/2026-10-13-configuration-sync-design.md.

Implement in the existing clean feat/docker-sync checkout. Interfaces are coupled across backend and plugin, so execute sequentially. Reuse installed dependencies and build caches. No parallel compilation or test groups.

1. Add scope migration, validated configuration paths, scoped endpoints, projection separation and capability flag. Verify notes fingerprint compatibility, cross-scope isolation, pagination, rename/delete/history and restart projections with the disposable PostgreSQL suite.
2. Add configuration selection, independent checksum journal, immutable publish candidates, staged remote updates, conflict preservation and group apply/rollback. Exercise custom configDir, selection changes, stale previews, write failures, interrupted apply, manifest/platform checks and credential exclusions using a realistic DataAdapter fixture.
3. Add English selection/preview/apply/conflict UI and lifecycle scheduling. Serialize connection context with note sync, respect pause/disable/unload and retain existing note journals. Verify typecheck/build and existing tests.
4. Run real HTTP two-device configuration round trip on a disposable service. Build the NAS image with one job, run isolated acceptance, back up the production library, deploy, then install the updated plugin disabled-by-default in both local vaults without touching real configuration contents.
5. Update protocol/deployment/verification docs, package and audit credentials/language/checksums, review the final diff and commit. Report hardware/UI boundaries accurately.

Verification status: steps 1–4 complete (99 client tests, 18 server tests, local/NAS HTTP and actual SIGKILL recovery; production backed up/upgraded; both vault installations preserve settings/journals). Documentation/package audit and cleanup complete at final delivery. Actual Obsidian UI/mobile hardware acceptance remains separate because Computer Use permissions are not granted.
