# Linux candidate acceptance — October 26, 2026

This is the current engineering acceptance record. The
[implementation log](linux-port-2026-10-26.md) preserves historical measurements.
The goal is the shared Klippt creator workflow on Linux, with source integrity
and responsive native capture/review/export. Windows remains later work.

## Candidate

Branch follow-up: remembered Linux source grants and an explicit idle Source chooser
are implemented and verified in private KWin. See [focused evidence](../artifacts/linux-port-2026-10-26/remembered-source/README.md).
These changes are newer than the portable runtime below; Niri persistence remains
a separate check. No repeated full suite or packaging checkpoint was run for this slice.

- Branch: `feat/linux-port`; draft PR: https://github.com/oEdyb/record/pull/1.
- Latest portable runtime: `6bdd95af9f76b79a9b2674ed9a9f1df8c9db5edb`.
- Inventory: `release/linux-port-20261026-6bdd95af/` (`SOURCE_SHA`, `SHA256SUMS`).
- All four Ubuntu-floor formats pass package policy. The normal-FUSE AppImage
  exports the real project using its packaged addon, without an override.
- The corrected render reports 871 frames/14.516 s, fully decodes, preserves the
  original hashes and expected audio levels, and exits 0.
- Supported evidence configuration: CachyOS, NVIDIA RTX 4070, private KWin/KDE
  portal, PipeWire and synthetic camera/audio. This is a development candidate,
  not a claim that every Linux configuration or physical device is verified.

## Critical journeys and evidence

| Requirement | Current evidence | State |
| --- | --- | --- |
| Record, Pause/Continue, Stop and review | Real packaged portal flows; `global-shortcuts/`, `audio-peer-admission/` | Passed on private KWin |
| Remove/Undo and recovery persistence | Shared lifecycle/journal regressions and earlier desktop recovery checks in implementation log | Retain unchanged evidence |
| Paused source/cursor/audio changes preserve earlier clips | Transactional replacement, cancellation and source hashes; `audio-peer-admission/`, `cursor-preview/` | Passed in scoped checks |
| Reopen media and camera associations | Packaged restart and original hashes; `active-camera-quit/` | Passed with synthetic camera |
| Separate takes preserves all originals | Two clips × four sources, eight identical hashes, full decoding; `four-source-export/` | Passed on latest package |
| OTIO/FCPXML preserve roles/order/offsets | Four 871-frame tracks; camera's two-frame tail gap; video-only screen references; zero warnings | Passed |
| One video preserves screen tail and audio | Packaged correction restores 871 frames/14.516 s, correct 440/660 Hz levels; full decode and unchanged originals | Passed on final candidate |
| Quit and interruptions preserve recoverable work | Real active capture close and restart; scoped failure/recovery checks; `active-camera-quit/` | Passed within documented crash limits |
| Responsive capture/preview and actual encoder | NVENC selection, bounded packaged preview and earlier hour run | Encouraging bounded evidence; no universal parity claim |

Artifact directories above are under `artifacts/linux-port-2026-10-26/`.
Unchanged evidence stays valid for its stated scope; a new candidate does not
require rerunning every previous check. Repeat a check when changed code or a
new observed failure invalidates its coverage. Only affected tests run.

## Explicit remaining gates

- One bounded, user-driven real Niri session with Olle's microphone/system audio,
  recording controls, review and both exports. Physical automation needs explicit
  authorization; routine private-lab work must not drive the visible desktop.
- Physical webcam and hardware clock/timing; exact Niri portal/focus integration.
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
