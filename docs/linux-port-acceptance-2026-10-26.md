# Linux candidate acceptance — October 26, 2026

This is the current engineering acceptance record. The
[implementation log](linux-port-2026-10-26.md) preserves historical measurements.
The goal is the shared Klippt creator workflow on Linux, with source integrity
and responsive native capture/review/export. Windows remains later work.

## Candidate

Current candidate follow-up: remembered Linux source grants and an explicit idle Source chooser
are implemented and verified in private KWin. See [focused evidence](../artifacts/linux-port-2026-10-26/remembered-source/README.md).
The exact normal AppImage passed OS-driven Source → Record without another picker
→ Stop/review in the private lab, with a fully decodable 2.35-second clip. The
exact packaged helper also restored an owned-window grant on actual Niri without
a second chooser after the missing user desktop registration was installed. Both
2.1-second NVENC clips fully decode. A subsequent authorized actual-Niri workflow
with the default microphone and system output passed two clips, review, both
exports and normal Quit; see [everyday evidence](../artifacts/linux-port-2026-10-26/niri-everyday/README.md).
Microphone PCM was nearly silent, so spoken-voice quality remains unverified.
Affected suites and one packaging checkpoint
were used; no repeated full suite or hour soak.

- Branch: `feat/linux-port`; draft PR: https://github.com/oEdyb/record/pull/1.
- Latest AppImage: `c5cd55658fc1a0172d5e2842b3aa82911d1276e6`.
  Inventory `release/linux-port-20261027-c5cd5565/`. Conditional Niri preview on an
  uncaptured output, conservative invalidation and exact source matching pass 58
  affected tests and real socket/CLI checks. Normal packaged actual OBSBOT capture
  passes two clips with separate originals; the positive physical two-monitor
  preview path remains user-driven. This is not atomic compositor exclusion.
  [Evidence](../artifacts/linux-port-2026-10-27/second-monitor-preview/README.md).
- Previous AppImage: `cde7e19b5a74fb3b5c4bbf22cfaeab66e27d3ffa`.
  Inventory `release/linux-port-20261027-cde7e19b/`. Linux confidence monitor
  creation, monitor preview hiding and explicit processed-microphone matching
  pass scoped checks; normal AppImage camera workflow passes with synthetic
  frames. Physical OBSBOT probe was busy in the user's running app.
  [Evidence](../artifacts/linux-port-2026-10-27/camera-virtual-audio/README.md).
- Previous AppImage: `7cfe5453559965211849fdc3ea8b6ae143d39d44`.
- Inventory: `release/linux-port-20261027-7cfe5453/` (`SOURCE_SHA`, `SHA256SUMS`).
  Monitor/unknown-source HUD hides before capture; confirmed Pause restores it.
  Niri Ctrl+Alt+R/S/O controls coexist with Koett Ctrl+Shift+Space. Actual private
  shared-microphone dictation/capture and packaged three-clip binding path pass;
  3,259 decoded frames contain no red pill indicator. Settings opening preserves
  the pill's desktop position. All 33 regular ELFs match a4f92422. Affected tests,
  both typechecks, lint, build and package policy pass; no full suite.
  [Control evidence](../artifacts/linux-port-2026-10-27/recording-controls/README.md).
  Includes earlier dragging/Source and compact toast fixes. Launcher and validated
  Niri bindings installed; a running older app must fully quit/reopen.
- Previous four-format inventory: `release/linux-port-20261026-a4f92422/`.
- All four Ubuntu-floor formats pass package policy. Its normal-FUSE AppImage
  passed source-grant reuse with the packaged helper, without an override.
- The compositor addon is byte-identical to `6bdd95af`; retain its 871-frame/14.516 s
  export, original-hash and audio-level evidence. Only the capture helper changed
  among 27 regular ELFs.
- Supported evidence configuration: CachyOS, NVIDIA RTX 4070, private KWin/KDE
  portal, PipeWire and synthetic camera/audio. This is a development candidate,
  not a claim that every Linux configuration or physical device is verified.

## Critical journeys and evidence

| Requirement | Current evidence | State |
| --- | --- | --- |
| Record, Pause/Continue, Stop and review | Actual Niri two-clip workflow plus private portal flows; `niri-everyday/` | Passed within stated audio limits |
| Remove/Undo and recovery persistence | Shared lifecycle/journal regressions and earlier desktop recovery checks in implementation log | Retain unchanged evidence |
| Paused source/cursor/audio changes preserve earlier clips | Transactional replacement, cancellation and source hashes; `audio-peer-admission/`, `cursor-preview/` | Passed in scoped checks |
| Reopen media and camera associations | Packaged restart and original hashes; `active-camera-quit/` | Passed with synthetic camera |
| Separate takes preserves all originals | Two clips × four sources, eight identical hashes, full decoding; `four-source-export/` | Passed on latest package |
| OTIO/FCPXML preserve roles/order/offsets | Four 871-frame tracks; camera's two-frame tail gap; video-only screen references; zero warnings | Passed |
| One video preserves screen tail and audio | Packaged correction restores 871 frames/14.516 s, correct 440/660 Hz levels; full decode and unchanged originals | Retain identical-addon evidence |
| Quit and interruptions preserve recoverable work | Real active capture close and restart; scoped failure/recovery checks; `active-camera-quit/` | Passed within documented crash limits |
| Responsive capture/preview and actual encoder | NVENC selection, bounded packaged preview and earlier hour run | Encouraging bounded evidence; no universal parity claim |

Artifact directories above are under `artifacts/linux-port-2026-10-26/`.
Unchanged evidence stays valid for its stated scope; a new candidate does not
require rerunning every previous check. Repeat a check when changed code or a
new observed failure invalidates its coverage. Only affected tests run.

## Explicit remaining gates

- Monitor auto-hide now passes scoped packaged private checks. Exact physical
  Niri keyboard/focus behavior still needs user confirmation after reopening.
  No second-monitor exemption or compositor-level own-window exclusion is claimed.
  User confirms the cursor is present; no missing-cursor fix is pending.

- Spoken microphone quality/balance: the authorized actual-Niri check captured
  the default input, but the room/processed signal was nearly silent. Its GUI
  workflow, system audio, review and both exports passed. Future physical
  automation still requires explicit authorization.
- Short physical OBSBOT recording now passes. Calibrated hardware clock/timing
  and the positive physical two-monitor preview path remain unverified.
- Wayland own-window exclusion; global shortcut activation/focus/backend reuse.
  Independent Electron reproduction exists; no speculative Klippt rewrite.
- Representative responsiveness/resource use on the intended session. The hour
  test predates later refinements and its RSS grew 391→476 MiB. A new endurance
  test needs a specific unresolved risk, not another package hash alone.
- Mac regression for shared native changes; AMD/Intel/other desktops before
  expanding compatibility claims. Windows is a separate future implementation.
- External CI/release clearance: CI, Diagnostic artifact and Supply chain are
  currently disabled at Olle’s request; earlier jobs hit billing/spending limits.
  Workflows are not re-enabled by this port. Public release and merge are separate.

Known crash limit: camera recovery can lose its last unwritten MediaRecorder
chunk. Audio initial offsets are estimated; synthetic frequency checks do not
prove physical A/V clock parity.

## Verification discipline

The confirmed tail correction and its packaged check are complete. The candidate
and hashes above are the handoff. Private lab and build container are stopped.
Do not continue rebuilding four formats, investigating platform focus behavior
or running synthetic permutations without a new issue that blocks the critical
workflow. Existing compositor strict-Clippy findings remain visible; they are
not suppressed or reported as clean.
