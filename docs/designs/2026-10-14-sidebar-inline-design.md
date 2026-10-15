# Native typography and inline MindSync pages

The user explicitly revises the approved sidebar design: match the other Obsidian plugins' font size and do not open popups. This replaces the earlier decision to reuse modal dialogs; no further design choice is required from the user.

Use the native --nav-item-size token (falling back to --font-ui-small), interface font and compact headings throughout the sidebar. Scoped hidden-element CSS must override theme button display rules so empty update actions remain hidden.

All MindSync preview, history, configuration selection/publication/review, preserved-copy viewing and status commands render in the existing native panel. Keep toolbar, live status and inline feedback stable above the current page. A Back action returns to overview. Connection settings retain their explicit Save changes workflow in the existing plugin settings page.

Replace MindSync Notice/toast feedback with inline status/error messages. Keep first-sync preview approval, connection identity checks, stale configuration validation, grouped apply/conflict preservation, durable settings, and busy/readiness guards unchanged. No modal or Notice constructor remains in the plugin.

Page sessions use generation checks. Navigating back, opening another page, closing the leaf or unloading prevents stale asynchronous results from changing the new page or reopening the panel. Progress notifications must not rebuild active form drafts. No new network polling or sync scheduling is introduced.

Verify meaningful page-navigation, late-result, no-popup, first-sync/preview identity, history connection identity, grouped configuration and settings-save cases. Run client tests with one worker and the build sequentially; install only the plugin trio after private backups and compare all existing settings/journal bytes. Publish plugin 0.3.4 with audited source and built assets. Actual UI access remains subject to the existing native permissions limitation.
