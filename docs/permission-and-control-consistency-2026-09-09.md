# Accessibility repair and consistent inspector controls — September 9

## Permission failure and repair

The installed `/Applications/Klippt.app` was signed by Developer ID Application: Dyberg & Co AB
(LF8KF3G42Q), as was its native cursor helper. Deep strict verification passed. System Settings
showed Accessibility enabled, but Record displayed the editable-cursor permission warning.

The macOS `tccd` log isolated the cause: the grant for `com.etiennelescot.openscreen` still required
an Apple Development certificate. Validating the installed Developer ID app against that stored
requirement returned `-67050`. The helper was correctly attributed to Klippt, with matching team IDs.
This was a stale Accessibility grant from the signing migration, not a missing toggle or helper.

With Olle's explicit approval, removed the old entry and added the exact installed application.
The file picker initially selected Blender; that unintended grant was removed and verified absent
before adding Klippt by its full path. Other permission entries were preserved. No TCC database
was modified directly and no broad permission reset was used.

A real installed-app recording then saved 42.862 seconds of 3420×2214 H.264 video, AAC audio,
and native cursor telemetry (906 samples, one cursor asset). The editor showed Saved, the expected
42.9-second duration, and playback advanced past eight seconds. Test media remains recoverable:
`~/Library/Application Support/openscreen/recordings/recording-1788928028606-clip-0001.mp4`.

## Keep the signing identity stable

`after-sign.cjs` runs through electron-builder's `afterSign` hook. It verifies the app and each
packaged cursor helper against the existing bundle/helper identifiers, Apple's Developer ID
certificate OIDs and team LF8KF3G42Q. Apple Development, ad-hoc or another team fails before
packaging completes. The installed app passes the same executable check.

The pinned electron-builder implementation can run `afterSign` despite skipping certificate
signing. Explicitly unsigned GitHub CI builds remain allowed only with auto-discovery disabled,
no certificate environment settings, and no explicit signing configuration. Those artifacts must
never replace the permission-granted local app. This guard protects the standard packaging path;
manually replacing or resigning an app outside it can still change identity.

Keep `/Applications/Klippt.app` as the sole user-facing app. Keep Developer ID signing and the
legacy identifiers stable. Do not switch back to Apple Development for local installations.

Primary contracts:
- [Apple TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html),
  designated requirements and identity tracking across updates.
- Installed `app-builder-lib` configuration and platform/Mac packager source: `afterSign` runs
  after signing and before distributable artifacts, including the intentional unsigned CI case.

## Inspector direction and implementation

Use Klippt's existing graphite/light surfaces, body font and numeric font. Make related control
rows follow the same spacing system. Keep switches compact and legible in both states. No new
font, palette, dependency or media behavior is needed.

Searched the new local UI library. Selected the MIT shadcn switch reference at revision
`3ba91b1cc83e1bbe4ab35a422ff2a694849c5048`, which shares Klippt's existing Radix foundation.
Used it as an interaction/layout reference; retained the project component and original token-based
CSS. The Coss candidate was excluded because its cached repository notice is AGPL.
[Radix Switch](https://www.radix-ui.com/primitives/docs/components/switch) documents controlled
state, thumb state attributes and keyboard behavior. No unstable API or dependency upgrade is used.

All inspector switches now have one 36×20 track inside a fixed 36×24 click area, with a centered
16px thumb. Off-state thumbs remain visible in dark mode; on-state tracks use the product's
monochrome emphasis. Audio, pause and caption rows use the shared row-height token. GIF Loop
now uses the same Radix switch instead of the remaining custom pseudo-element toggle. The
export dialog's general button height explicitly excludes switches.

Acceptance evidence: compare control/thumbnail bounds across Video Effects, Layout subtasks,
Cursor, Audio subtasks and Captions at 768/1280px in light/dark themes; keyboard-toggle Cursor
and preserve focus; check GIF Loop inside the actual export dialog; inspect rendered screenshots.
This applies similarity, target size, proximity and familiar behavior from the frontend skill.

## Verification

Initial full suite: 285 files, 2,949 passed and one skipped. Both TypeScript checks passed.
Repository lint passed with its existing oversized Cargo-Evidence.json warning after formatting
the task's diagnostic scripts. The native Mac helper build and production Vite build passed.
The initial four rendered cross-pane checks passed; the expanded GIF checks and final signed
installation are recorded below when complete. Independent review found unsigned-CI handling
and the GIF-dialog sizing override; both were corrected and given regression coverage.

Final checks after review corrections: 285 unit files, 2,950 passed and one skipped; six signing
guard tests; four production-rendered browser cases including GIF Loop; both TypeScript checks;
repository lint (one pre-existing oversized evidence-file warning). Dark desktop and light narrow
screenshots were visually inspected. Vault validation reports eight unrelated unregistered
directories; none was changed.

## Local delivery

Packaged and installed `/Applications/Klippt.app` with Developer ID Application: Dyberg & Co AB
(LF8KF3G42Q). The app and cursor helper designated requirements exactly match the prior installed
version. The package hook, staged signature, replacement signature and installed identity guard
all passed. The previous app is preserved at
`~/Library/Application Support/Klippt/Archived Apps.noindex/installed-before-permission-panels-20260909.bundle-backup`.
This is a local update; notarization and public release were not attempted.

After installation, screen selection worked and a second recording started with the editable
cursor enabled, without another permission change or prompt. It saved 11.650 seconds of
3420×2214 video with audio and native cursor data (248 samples, one cursor asset), and opened
as Saved in the updated editor. The installed Audio panel was visually inspected with real
recorded media; screenshot: `artifacts/panel-consistency-2026-09-09/installed-audio.jpg`.
Second test recording: `recording-1788928759280-clip-0001.mp4` in the existing recordings directory.
The app is left open on Audio. Test recordings and prior projects remain intact.

## October 20, 2026: bundle identity moves to co.dyberg.klippt

The app is now signed as `co.dyberg.klippt`. The helpers are renamed `klippt-screencapturekit-helper`
and `klippt-cursor-helper`. Each embeds an Info.plist (`electron/native/screencapturekit/Support/`,
linked into `__TEXT,__info_plist`), so codesign signs them as `co.dyberg.klippt.screencapturekit-helper`
and `co.dyberg.klippt.cursor-helper` instead of their file names. `after-sign.cjs` pins all three
identifiers, the Developer ID OIDs, and team LF8KF3G42Q, and requires both helpers.

What stays the same:
- User data stays in `~/Library/Application Support/openscreen`. `electron/bootstrap.ts` pins it by
  path, not by bundle ID. Projects hold absolute paths into it, so no copy or remap is needed.
- `OPENSCREEN_*` environment variables are still read.
- The safeStorage Keychain item is still named "Klippt Safe Storage". Its access list trusts the
  old signature, so macOS may ask once to allow the new app. If the key can't be decrypted, Klippt
  keeps the trial date and the license's offline grace, asks for the license key once, and retries
  the decrypt on each refresh. Projects stay viewable throughout.

What changes once per Mac that crosses the change:
- TCC grants belong to the old ID. Grant Screen Recording, Accessibility, Camera and Microphone to
  the new `/Applications/Klippt.app` once. The old rows can be cleared with
  `tccutil reset All com.etiennelescot.openscreen` (owner's action).
- In-app update cannot cross the change. Squirrel.Mac accepts an update only if it satisfies the
  running app's designated requirement, which names `com.etiennelescot.openscreen`. Install the first
  `co.dyberg.klippt` build by hand from the DMG. After that, builds update each other through
  `updates.dyberg.co/klippt` as before.

Rollback: reinstall the previous build from `.local-install.noindex/backup-installed-*`. It still
carries the old ID, so its old TCC grants apply again, and the user-data folder is the same.
