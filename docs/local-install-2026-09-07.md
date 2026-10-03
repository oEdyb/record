# Stable local Klippt installation

Use `/Applications/Klippt.app` as the sole user-facing application. Local package builds go under `.local-install.noindex`; do not direct the user to an Electron development process for ordinary use.

Sign the application and nested native helpers with Developer ID Application: Dyberg & Co AB (LF8KF3G42Q). Preserve `com.etiennelescot.openscreen` and native helper identifiers. Verify designated requirements against the installed version before replacement. Apple explains identity continuity in https://developer.apple.com/library/archive/technotes/tn2206/_index.html.

On September 7, System Settings showed Klippt Accessibility already enabled. No permission reset or database modification was performed. Rebuilt Whisper and capture helpers. Created fresh Whisper source/build evidence with the standard provenance script after verifying built upstream revisions. Local workflow ID is 0; this is not a CI release or public update.

Duplicate release applications and old backup applications were unregistered from Launch Services and moved into `/Users/olle/Library/Application Support/Klippt/Archived Apps.noindex`. The `moves-2026-09-07.json` file there records their original locations. Files are preserved. Projects and recordings remain in the existing openscreen user-data directory.

## Installation evidence

The directory package completed successfully. Deep strict code-signature verification passed before and after installation. App designated requirements match the prior installed bundle; the cursor helper designated requirements also match. The previous installed app is preserved as `Archived Apps.noindex/installed-before-20260907.app`.

Launched `/Applications/Klippt.app` and opened Studio. The existing 20.3-second edit loaded with 11 caption timeline items. Selecting a caption seeks to 2.03 seconds and opens the current caption inspector. Existing Geist 92 px styling is preserved. No permission prompt appeared during launch. System Settings still shows Klippt Accessibility enabled. This is not a fresh recording permission validation.

Spotlight application query returns only `/Applications/Klippt.app`. Native helpers and Whisper were rebuilt for this local package. No public update was published.

Release limitation: `verify-packaged-distribution.mjs` stops with `Unapproved application build output: dist/.vite/manifest.json`. The local package signature passes, but the strict distribution audit has not passed. Resolve the manifest packaging policy before a public release; no allowlist or security check was bypassed here.
