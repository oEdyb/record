# Recording window regressions

## Studio split disappearance

`StudioSeparator` treated pointer travel below 10% or above 90% as a collapse command.
The outer split then set transient `dockHidden`, removing the entire camera/replay dock;
the inner split saved a single-pane `view`. Neither action controls capture writers.

Resizing now always uses the existing bounded size setters. Home/End also resize instead
of collapsing. Explicit camera/replay view buttons remain available. Saved numeric split
and dock fractions already normalize on load; regression tests cover both extremes.
The old transient hidden dock can be recovered with the header's two-panel button.
No profile edit or restart is needed.

Verification: the new Studio keyboard regression fails against the original implementation
and passes after removing collapse. Studio, preference and Linux HUD unit tests: 63 passed.

## Webcam restore

The preview is frameless and `resizable: false`. On Electron 44.9.1, expanding
with `setBounds` updates Wayland's fixed min/max dimensions, but collapsing with
`setSize` leaves the expanded minimum in force. This reproduced under private
nested niri 26.04: 312×186 → 1200×700 → failed 312×186 request (still 1200×700,
minimum 1200×700, not maximized). Replacing the shrink with `setBounds` returned
312×186 and updated its min/max. Compact grip resizing uses the same correction.
No resizable/maximizable flags or Mac/Windows policies changed.

Reference: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
(`setBounds`, `setSize`, size constraints, Linux maximize flag limitations).
Wayland owns global placement; app bounds requests do not establish real compositor
position restoration. Native compositor maximize/fullscreen remains a separate check.

## Recording bar disappearing during capture

`NiriCaptureWindowGuard` revokes visibility if output/workspace/window isolation becomes
unsafe (including overview), or the event stream fails. Its HUD callback called
`LinuxRecordingHud.conceal`, which hid the bar without pausing the writer. This was
intentional capture privacy, not a timed close. Recovery previously depended on the tray
or recording shortcuts. An unexpected mid-take revocation now retries a pause request, then restores controls
only after writer acknowledgement. Deliberate Hide and Studio transitions do not pause. Startup conceal still stays hidden while recording.

This code path is reproduced by a regression that fails before and passes after the
change. It is a supported cause, not a confirmed diagnosis of the reported incident:
the installed process sent stdout/stderr to `/dev/null`, its journal had no app logs,
and the inspected recent coredump list contained portal crashes but no Klippt crash.
No user recordings were inspected. A renderer crash remains a different path:
`main.ts` calls `stopTakeWithoutPill` to save and open review.

Legacy saved single-pane layouts are migrated to Both on load, because the old split
could save that value when it hid the camera. New layouts carry version 2 and preserve
explicit view choices. This deliberately resets an old intentional single-pane choice
once as well; there is no marker that distinguishes it from an accidental collapse.

Niri placement also needs compositor coordinates: Wayland ignores app global position
requests. The preview now remembers its floating output and position before Expand,
using the existing niri recorder-placement helper with the camera title, then restores
after Collapse. A generation check rejects stale work after another toggle or new window.

The real-window test also reproduced a native HUD maximize regression: KWin sometimes
restored the recording bar at 960 px instead of its requested 472 px. The Linux HUD now
retains content-size reports without resizing a maximized/fullscreen viewport and reapplies its last requested
bounds on `unmaximize`. A unit regression fails before and passes after this correction.

The expanded test also found Hide → Settings recovery waiting for an animation frame
inside the hidden camera window. Visibility IPC now runs directly from the effect;
a hidden page need not paint before asking the main process to show it. The regression
suspends animation frames and fails before/passes after the change.

Normal tests now run unit checks and, where agent-lab is installed on Linux, the private
Electron flow even when unit checks fail. The final exit status still preserves any
failure. Missing private-desktop support is printed as NOT RUN, not treated as desktop
verification. Supply-chain approval tests remain unchanged and require the owner's
valid signature. The desktop flow needs a built native helper (or the explicit
`OPENSCREEN_LINUX_CURSOR_HELPER_EXE` development override), niri, KWin and FFmpeg.

The control sweep reproduced Restart stopping without starting a replacement. Its
continuation called `startRecording` from a render that still captured `recording=true`,
after finalization had already cleared the native handle. Startup now relies on the
synchronous recorder handles and pending-start ref, not that stale UI boolean. Native
restart regressions fail before and pass after on Linux, macOS and Windows fixtures;
the existing duplicate-start guards remain covered. All 69 recorder-hook tests pass.


Opus review follow-up: deliberate unmapping (Hide or Studio) is distinguished from a
revoked visible pill using its native visibility before recovery hides it. Deliberate
hiding ends isolation monitoring without auto-pausing; unexpected revocation requests
pause. Dropped/busy/failed pause requests retry every 500 ms until native capture is
paused, including a revocation during a start/resume transition. Guard-to-HUD tests use
actual niri event shapes and two-output snapshots for both paths. Exact native niri
capture remains unavailable on the private nested backend (no screencast GBM device).

The review also added popup/fullscreen size restoration, preservation of the original
camera placement through overlapping restore/expand, both legacy single-pane migrations,
and an assertion before changing any legacy view. Filtered npm tests run units only;
the runner uses Node's Vitest entry point on Windows and prints spawn errors. Full
private flows acquire the required low-priority flock/scope themselves. When invoking
npm test inside an already-held external lock, set KLIPPT_HEAVY_LOCK_HELD=1 to avoid a
nested lock. Native Restart media is decoded before the test discards that take.

The compositor's native maximize state is also synchronized to the camera's Collapse
control on Linux. Collapse leaves native maximize before restoring compact bounds;
external Unmaximize restores the compact monitor too. The preview connection handshake
resends that state for a late renderer. This covers the separate native maximize path,
not only the app's Expand button. New main/renderer regressions pin one-click restore.

Final review found the initial Record cleanup unconditionally cancelling the active
niri guard. Successful Linux starts now consume preparation without calling Cancel;
the IPC boundary also refuses to cancel HUD isolation while capture is active. New
renderer and IPC regressions fail before and pass after the fix. Failed niri restores
now release their saved placement in a generation-checked finally block. The next
Expand can remember a newly moved window rather than retrying stale placement.

## Source locations and decisions

Original root locations at base `fcc847cea4102d7bf055648e4fb54c3bdac90f99`:

- `src/components/studio/StudioSeparator.tsx:74`: resize extremes called collapse.
  This hides the monitor only; screen/camera/microphone writers continue.
- `electron/windows.ts:350`: fixed webcam shrink used `setSize`, leaving Wayland's
  expanded minimum dimensions in force. Native maximize also lacked control-state sync.
- `electron/recording/linuxRecordingHud.ts:69`: privacy conceal hid the HUD while capture
  continued. Guard revocation now pauses safely and restores Stop; intentional hides remain.
  The original reported disappearance cannot be attributed conclusively from available logs.

No installed application, real profile, physical input device or user take was modified.
The private capture uses the real portal/PipeWire writer against an animated owned fixture,
Chromium's fake camera and a private PulseAudio source. It proves file delivery and replay,
not physical camera timing, microphone quality or real niri screencast behavior. macOS and
Windows receive unit regressions; their native desktops were not exercised here.
Legacy unversioned single-pane choices reset once to Both; explicit version-2 choices remain.
No packaging, installation, dependency-signature generation or gate bypass is included.

## Final private acceptance

On 2026-11-04 UTC, normal `npm test` ran 3,385 passing unit tests, 12 skipped,
and the six pre-existing dependency-approval signature failures (324 passing files,
two failing, four skipped). Overall exit status remains 1; this is not a green full suite.
The integrated private desktop flow nevertheless completed every assertion and cleanup:

- Nested niri 26.04: app Expand/Collapse and rapid toggles restore 312×186 at [90,100].
  Niri declined native maximize for these fixed windows; no native niri maximize claim.
- Private KWin: native maximize/restore for camera and recording bar, popup sizing,
  legacy layout recovery before view changes, every split at both extremes.
- Real window controls: Pause, Continue, Remove, Undo, Restart, Discard, Hide/reopen,
  camera settings/recovery, replay expansion, Studio transitions and Stop.
- Restart replacement screen/camera/mic files fully decode before Discard.
- A subsequent uninterrupted 311,416 ms take keeps both windows visible, Stops into review,
  and fully decodes screen, camera and microphone originals. Mic has non-silent samples.
- Saved replay Play/Pause, mute toggle and seek controls pass. The owned desktop stops cleanly.

Evidence: `~/.cache/klippt-work/webcam-restore/accepted.log` and
`~/.cache/klippt-work/window-flows/run-cz9upI/saved-snapshot.json` (private test media only).
App and test TypeScript checks, lint and documentation checks are recorded alongside the log.
These checks do not establish physical camera/mic quality, real niri screen capture,
or native macOS/Windows behavior. On real niri, still check output/workspace/overview
revocation safely pauses and exposes Stop, then Continue/Stop preserves the take.

## Installed-package test mode

Run `env KLIPPT_TEST_EXECUTABLE=/home/olle/Applications/Klippt/klippt node scripts/recording-window-flow.mjs`.
The same default flow targets that executable on private nested niri and private KWin.
It skips the dev build and passes no development FFmpeg, capture-helper or compositor overrides.
The fixture still uses development Electron; Klippt itself runs its installed ASAR and bundled helpers.

The hardened package disables the Node inspector, so this mode attaches Playwright to a
loopback renderer debugging endpoint instead. It uses production preload commands and
private KWin scripting for native window state and maximize/restore. It checks the actual
process executable through `/proc`, requires a private desktop/profile, and quits via the
production Quit command with exit 0. No installed fuse or security policy is changed.
The compositor must acknowledge a reset size before the maximize baseline is measured.

The PC package uses `OPENSCREEN_SYMBOL_FLOOR=host`, pinned Electron 44.9.1, and checksum-verified
patchelf 0.18.0. The previous Whisper artifact names the old source commit; exact provenance
checks correctly reject it. Whisper was rebuilt from pinned source for this commit with four
CPU affinity slots, a local provenance run ID of 0, then verified through the normal staging step.
The Vulkan build used SPIRV-Headers `496543121ce6419f23d6fa5d7194ba66c36212d2`, matching host SDK
1.4.363.0, staged only in the work cache. This is a local PC install, not a portable release.

Installed acceptance on 2026-11-04 UTC: `6a9b3c9c393787d0be55ba0f1f43d6192671cb57`
at `~/Applications/Klippt`, backup `~/Applications/Klippt-backup-20261105-002437`.
Installed binary, ASAR and helper manifest hashes match the staged package; launcher paths remain valid.
The installed-package flow exited 0: split extremes and legacy recovery, camera Expand/Collapse
and original niri placement, all recording controls, decoded Restart replacement media, then
302,333 ms uninterrupted capture with both windows visible. Stop opened review; all three
screen/camera/mic originals decoded completely, mic was non-silent, and replay controls passed.
The production Quit command returned exit 0 and the private desktop stopped cleanly.
Two package-isolation unit tests, lint and documentation checks passed. The Studio screenshot
was inspected. Logs and hashes: `~/.cache/klippt-work/webcam-restore/installed-flow.log`,
`installed.json`; private fixture media: `~/.cache/klippt-work/window-flows/run-2qgAru/`.

The installed package's fixed windows declined compositor maximize in nested niri and KWin;
those round trips preserve compact bounds, but do not prove a native maximized state transition.
The dev-build native maximize tests remain separately recorded above. Electron's hardened
package does not expose Chromium's Browser window-bounds protocol or the Node inspector;
neither protection was relaxed for testing. App Expand/Collapse and bar replay expansion
were exercised through the actual installed controls. Real niri screencast isolation/revocation,
physical devices and native macOS/Windows behavior remain outside this private proof.
