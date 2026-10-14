# Remove the MindSync status bar entry

The user explicitly requests removing MindSync from Obsidian's bottom status bar to preserve the host interface. Apply that direction directly: remove the status bar item registration, element, renderer and renderer calls. Preserve synchronization state, the existing ribbon action, settings tab, and command palette status/conflict access. No new visible interface is introduced.

Release plugin 0.3.1; the Rust server remains 0.3.0. Install only main.js, manifest.json and styles.css after private backups. Keep settings, credentials, pause selection and all journals byte-identical. Publish source/assets to the existing authorized GitHub repository.

Acceptance: no addStatusBarItem registration or NAS status-bar text in source/bundle; command/ribbon/settings entries retained; existing single-worker client tests and TypeScript build pass; installed files equal the build. Actual visible removal requires plugin reload. If native UI permissions are unavailable, report that boundary and preserve the running app.
