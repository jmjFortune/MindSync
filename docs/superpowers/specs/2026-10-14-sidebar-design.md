# MindSync right sidebar

## User request and proposed design

Add a MindSync tab to the native right sidebar alongside Git, Calendar, and other views, as shown in the user's screenshot. Preserve the compact native Obsidian appearance. All interface text remains English; omit explanatory helper copy. The user approved this design on 2026-10-14.

## Options

1. **Recommended: compact status and action panel.** Native toolbar with sync, preview, pause/resume, history, and settings/plugin management. Below it, show the current state, last successful note sync, pending note operations, configuration review count, and conflict copies. Uses existing operations and exposes useful results without repeating connection forms.
2. **Actions only.** Smaller implementation, but users still need to open a modal to see progress, errors, or conflicts.
3. **Full settings dashboard.** More controls in one place, but duplicates connection forms and makes a narrow sidebar crowded. Not selected.

## Placement and entry points

- Register an ItemView with a stable MindSync view type, display title MindSync, and a native synchronization icon.
- When workspace layout is ready, reuse any restored MindSync leaf; otherwise create a separate right-sidebar tab. Do not replace Git or another existing view, reveal a collapsed sidebar, or steal focus during startup.
- Add an Open MindSync command. Change the existing MindSync ribbon click to reveal this panel. Keep the Sync now command available.
- Repeated open requests reuse the existing leaf, including a deferred/restored leaf. Explicit opening reveals it through the public workspace API.
- Native dragging, tab closing, sidebar resizing, and workspace persistence remain under Obsidian's control.

## Layout and behavior

- Top: a compact native toolbar. Icon actions have English tooltips and accessible names; pause/resume exposes its current state.
- Status: show actual readiness, pause state, running transfer, or error. A running manual sync remains visibly running even if automatic sync is paused. Errors are real operational messages rather than helper copy.
- Summary: Last sync, Pending operations, Settings and plugins, and Updates awaiting review. The last-success value comes from the existing engine journal; do not invent timestamps for connection tests or configuration checks.
- Conflict list: show the tracked conflict path with existing Open conflict copy and Open both versions actions. Use a concise No conflicts empty state.
- Configuration review: reuse the existing staged review dialog; do not auto-apply settings or plugins.
- History and preview continue to use their existing dialogs. Server URL, device token, registration, and Save changes remain in the existing settings page.
- Actions that initiate network work are disabled while another operation is active or connection/engine readiness is missing. Pausing persists through the existing serialized settings store; report any save failure and preserve the current state.
- Opening or refreshing the view only reads local state. Do not add network polling, storage queries, scanning, or extra synchronization jobs.

## Architecture and lifecycle

Keep the view in a focused sidebar module. The plugin supplies a small local status snapshot and delegates actions to existing methods. Refresh from plugin state-change notifications rather than a new network loop. Update text and disabled states without rebuilding focused controls during chunk progress. Grouped conflict/configuration rows can rerender when their underlying data changes.

Subscribe when the view opens and dispose on close/unload. Registration and view resources use the normal Obsidian component lifecycle. Pending asynchronous operations must not update a closed view. Preserve workspace state rather than forcibly detaching saved leaves on plugin unload.

## Styling and compatibility

Use native Obsidian components, icons, color variables, keyboard focus behavior, and theme typography. Scope CSS to the MindSync view. Allow toolbar wrapping and long-path wrapping in narrow sidebars. Avoid external UI libraries, fixed colors, decorative cards, and explanatory small print.

The implementation follows the public ItemView and workspace APIs. References: [Workspace](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Workspace.md), [Deferred views](https://docs.obsidian.md/plugins/guides/defer-views), and [Lifecycle management](https://docs.obsidian.md/plugins/guides/lifecycle-management).

## Verification and delivery

- Meaningful regression coverage: leaf reuse without replacing an existing tab, local-only panel opening, busy/readiness action guards, state notifications and unsubscribe behavior, progress/error/pause state precedence.
- Run client tests sequentially with one worker and TypeScript/esbuild at low priority. No server or Docker rebuild is required.
- Bump the plugin patch version, package and audit release contents, install the plugin trio in both existing vaults after private backup, and verify credentials/settings/journals byte-for-byte.
- Publish source and built assets using the previously authorized GitHub workflow. Never publish private vault configuration or credentials.
- Verify the actual sidebar visually when permitted native UI access is available. If unavailable, explicitly separate build/regression evidence from running Obsidian visual verification and tell the user to reload the plugin.

## Scope boundaries

No changes to synchronization scheduling, server data layout, conflict resolution policy, history retention, user files, credentials, or existing journals. The bottom status bar stays free of MindSync UI per the user's prior request.
