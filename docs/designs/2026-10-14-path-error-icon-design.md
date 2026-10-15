# Path error feedback and supplied icon

The user asks why synchronization reports a path error and requests replacing the plugin icon with their supplied brain-circuit SVG. The invalid local paths contain a colon in two directory names. Both client and server intentionally reject Windows-incompatible characters; sync already continues unrelated upload/download operations before reporting the failure. Preview currently throws on the first invalid path. The actual UI bug is that failed preview/history requests leave their loading indicator visible.

Preserve all user-authored paths and content. Do not weaken server path validation or silently rename/exclude files. A question about preserving names versus user-approved renaming remains pending. Complete the independently authorized icon change and loading-state repair first.

Use the supplied SVG unchanged as an English-named project asset. Bundle it as SVG text, register a namespaced native Obsidian icon before views/ribbon registration, and normalize its 28-unit coordinates to Obsidian's 100-unit icon viewport. Keep currentColor and the original filled path. Use it for the MindSync sidebar tab and ribbon; retain the standard refresh symbol for the actual Sync now action.

Remove preview/history loading nodes in finally when the current page session is still active. Preserve actual inline errors, Back navigation and busy cleanup; never add popup dialogs, offer approval after a failed preview or reopen a page the user left. Verify error-state regressions, single-worker client tests/build and exact SVG source/compiled content. Install/publish 0.3.5 with private backups and byte-identical settings/journals.
