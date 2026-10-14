# Clean settings and explicit save

The user requests centered connection controls, an explicit Save changes action, confirmation that the device token is retained, and removal of explanatory small text.

Keep native Obsidian Setting components. Scope vertical alignment and wrapping to MindSync settings only. Remove static descriptions and instructional paragraphs; retain actionable errors, actual state and file/revision details. Display the existing token masked by default with a Show/Hide button.

Connection fields and configuration selections use isolated drafts. Editing or closing the editor does not save. Save changes persists a patch before activating it, with serialized writes, stale edited-field checks and success/failure feedback. Untouched credentials and configuration choices retain their latest values. Registration and command actions remain explicit operations; registration verifies the server before installing its returned token. Save a changed device name into the active engine without reloading. Disable connection/publication actions while their draft is unsaved.

Selection inventory is read-only even before the enable draft is saved: it must not initialize the journal, flush candidates, upload or apply files. Publish/apply continue to require the saved enabled selection.

Release plugin 0.3.2, preserve both local vault settings/credentials/journals, and publish to the authorized GitHub repository. Server stays 0.3.0. Native UI permissions remain unavailable, so actual host layout/reload must be confirmed after installation.
