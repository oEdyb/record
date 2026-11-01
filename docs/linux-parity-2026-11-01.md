# Linux parity pass — November 1, 2026 (overnight)

Goal: make the Linux build match the Mac recording workflow — Record, Pause/Continue,
Stop, review, the Studio window, device selection, separate-source export, and recorder
windows kept out of the captured output.

- Branch `linux/parity-2026-11-01`, worktree `~/dev/klippt-linux-parity`, based on the
  PR #1 head `44da1b78` (`feat/linux-port`). Nothing was pushed or merged.
- Method: audit of the Mac code paths and the Linux paths against
  [product behavior](../technical-documentation/product-behavior.md), fresh targeted
  test runs, and the retained October 26–28 desktop evidence. **No capture was run
  tonight**: the rules for this pass forbade GPU work (NVENC, the lab compositor), so
  nothing below claims new end-to-end recording evidence. "Works" rows cite the
  existing artifact or the unit coverage that pins them.
- Platform-conditional tests pin `process.platform`; CI is Linux.

## Checklist

Status: **Works** (with evidence), **Fixed** (broken, repaired tonight), **Blocked**
(written blocker below).

| # | Item (Mac behavior) | Linux status | Evidence |
| --- | --- | --- | --- |
| 1 | Record starts immediately; "Starting recording…" until first frame; reuses the portal grant | Works | `artifacts/linux-port-2026-10-26/remembered-source/`, `niri-everyday/`; request-adapter bug fixed, see F1 |
| 2 | Quality High/Standard applies to the next clip (136/68 Mbps, 60 fps) | Works | `capturePolicy.test.ts` pins the Linux request; helper honors `video.bitrate` (`request.rs::bitrate`) |
| 3 | Pause/Continue repeat; paused setup change applies to the next clip only | Works | `niri-everyday/` (two clips), `paused-audio/`, `source-replacement/`, `recording-controls/` (three clips) |
| 4 | Pause finalizes fast (target p95 < 300 ms) | Works, p95 not measured | `docs/linux-port-2026-10-26.md:120` — about 130 ms Pause, one two-clip run; no p95 study |
| 5 | Stop ends capture and opens compact review | Works | `niri-everyday/`; `recording-controls/` (Stop opened populated review) |
| 6 | Quit during a take stops it first; recovery journal covers the rest | Works | `active-camera-quit/`, `preview-quit/`; guard has no platform gate |
| 7 | Remove previous clip, Undo, crash recovery | Works | shared lifecycle/journal regressions (`nativeMacRecoveryJournal.test.ts`, service tests); startup recovery enabled for Linux (`handlers.ts` startup recovery gate) |
| 8 | Replay of kept clips from the pill | Works, unit level | `HudClipPeek*.test.ts(x)`; no retained Linux desktop run |
| 9 | Display stays awake while a take records | **Fixed** (F2) | `recordingWakeLock.test.ts`, `handlers.startup.test.ts`, `artifacts/linux-parity-2026-11-01/wake-lock/` |
| 10 | Auto-pause on suspend and low disk | Works | `handlers.startup.test.ts` ("routes Linux suspend…"), shared `disk-low` path with `freeDiskBytes` wired on Linux |
| 11 | Auto-pause when the recorded window closes | **Blocked** (B1) | helper treats a disconnected stream as fatal |
| 12 | Auto-pause when the screen locks | **Blocked** (B2) | Electron `lock-screen` is darwin/win32 only |
| 13 | Review: play, scrub, Add clip, Original files, Record, Save video | Works | `niri-everyday/`; `src/components/ai-edition` suites (73 files pass) |
| 14 | Separate takes: untouched originals, OTIO/FCPXML, remembered choice | Works | `four-source-export/` (eight identical hashes), `ExportDialog.flow.test.tsx` (default + remembered choice) |
| 15 | One video: normal MP4 through the save picker | Works | `niri-everyday/` (740 frames / 12.333 s, full decode), `four-source-export/` |
| 16 | Microphone: pick device, default sentinel, change while paused | Works | `recording-readiness/` (Easy Effects Source, default sentinel fix), `audio-peer-admission/`, `nativeLinuxRecording.test.ts` |
| 17 | System audio toggle | Works | `niri-everyday/`, `four-source-export/` (isolated 440 Hz track) |
| 18 | Camera: pick device and format, per-clip file, confidence monitor | Works, synthetic + short OBSBOT | `camera-virtual-audio/`, `second-monitor-preview/`, `active-camera-quit/` |
| 19 | Cursor mode tile (baked vs editable) | Works | `cursor-preview/`, `cursor-grant/` |
| 20 | Saved device that disappeared falls back safely | Works | `useCameraDevices.test.ts`, `useScreenRecorder.nativeStopFailure.test.tsx` ("falls back to an available camera…") |
| 21 | HUD kept out of footage | Works, by concealment | monitor/unknown capture unmaps the pill first; 3,259 decoded frames, zero pill pixels (`recording-controls/`); window capture keeps it |
| 22 | Camera monitor kept out of footage | Works, conditional | hidden with the pill; Niri exemption only for a verified off-capture output |
| 23 | Notes and Transcript excluded from capture | **Fixed** (F3), see decision D1 | `linuxCaptureConcealment.test.ts`, `windows.captureConcealment.test.ts` |
| 24 | Compositor-level own-window exclusion; second-monitor exemption on any compositor | **Blocked** (B3) | Wayland offers neither through Electron |
| 25 | "Open Studio" / Recordings button opens the library and review window | Works | `LaunchWindow.test.tsx` (`launch-open-studio-button`), shared `switch-to-editor` |
| 26 | The new Studio window (`electron/studio/*`) | **Blocked** (B4) | absent from PR #1; present on `feat/studio-linux` |
| 27 | Live transcript from the Setup panel | **Blocked** (B5) | Mac-only helper; footer hidden on the Linux HUD |
| 28 | Startup recovery of an interrupted take | Works | `handlers.startup.test.ts` (Linux gate), `active-camera-quit/` |

Counts over the 28 rows: **Works 21** (1–8, 10, 13–22, 25, 28), **Fixed tonight 2**
(9, 23), **Blocked 5** (11, 12, 24, 26, 27). Rows 21 and 22 work by concealment, not by
compositor exclusion (B3).

## Fixes

Each has tests in the same package; `npx tsc --noEmit` and the test typecheck were
clean after each.

- **F1 — `bfbe61b4` Linux request without an audio block.** `e0659bff` made
  `linuxClipRecordingRequest` dereference `request.audio.microphone`, so a request with no
  audio block threw inside the IPC handler instead of reaching the service. Two
  `handlers.startup.test.ts` cases ("waits for startup recovery before
  prepare/start-native-linux-recording…") had been failing on the PR head since then.
  The adapter now passes such a request through. Test: `nativeLinuxRecording.test.ts`.
- **F2 — `2af9b074` display stays awake.** The macOS helper holds a `ProcessInfo`
  activity with `.idleDisplaySleepDisabled` for the whole take
  (`RecordingProcessActivity.swift`); nothing on Linux did, so an idle timeout could
  blank or lock the session mid-take. `RecordingWakeLock` holds Electron's
  `prevent-display-sleep` blocker from recording start to stop, Linux only, and never fails
  the take if the inhibit service is missing. Wired into the one place every recording
  state change passes through (`notifyRecordingStateChange`). Tests: unit
  (`recordingWakeLock.test.ts`) and IPC-level, pinned to Linux and Darwin
  (`handlers.startup.test.ts`). Primary-source check: an isolated private D-Bus session
  with a mock `org.freedesktop.ScreenSaver` saw Electron 44.9.1 call `Inhibit` on start and
  `UnInhibit` on stop. Olle's Niri session owns that same interface, so the call has a
  receiver there; actual Niri idle behavior over a long take was not measured.
- **F3 — `9535ce6e` Notes and Transcript out of Linux monitor captures.**
  `setContentProtection` is macOS/Windows only (Electron typings), so on Linux these windows
  were captured like any other while the spec says they stay excluded. They now unmap at the
  moments the pill and camera monitor already do (`setCameraPreviewCaptureHidden`) and come
  back unfocused at Pause; a window that finishes loading mid-take waits for Pause. Window-only
  capture never conceals. Tests: `linuxCaptureConcealment.test.ts` (policy),
  `windows.captureConcealment.test.ts` (the real `windows.ts` wiring, Linux vs
  Darwin/Windows). **Honest scope:** the Linux HUD currently hides the Notes and
  Transcript buttons (`LaunchWindow.tsx`, `isLinuxHud ? null`, since upstream `f695b4c7`),
  so nothing opens these windows on Linux today. F3 is a safeguard that makes
  re-enabling Notes safe; it does not change what a user sees now. See D1.

Product-behavior text for F3 is in `technical-documentation/product-behavior.md`.

## Blockers

- **B1 — Recorded window closes mid-take.** On macOS 15.2+ the take pauses with a toast
  and Continue works after reselection. The Linux helper's main loop
  (`electron/native/pipewire-capture/src/main.rs`, the `StreamEvent::State` arm) treats an
  `unconnected` stream as fatal: `clips.fail`, `capture-stopped-with-error`, exit 1. The
  renderer then pauses, toasts "…Saving completed clips now." and finalizes to review, so
  earlier clips and the salvaged tail are kept, but the take cannot continue. The TypeScript
  side already maps a `source-inactive` warning to the Mac pause-and-toast flow. Design for
  parity: on stream loss while a clip-native take is recording or paused, emit
  `Warning{source-inactive}` and stay alive; reject `Resume` with `clip-resume-rejected`
  until `SelectSource` adopts a replacement. Not done tonight: it changes the native
  recording loop and can only be verified with a real portal stream and NVENC, which this
  pass was not allowed to run. Needs a daylight session with the lab.
- **B2 — Screen lock.** Electron's `powerMonitor` `lock-screen` is `@platform darwin,win32`;
  the Linux build correctly registers only `suspend` (a test asserts `lock-screen` is not
  listened to). Parity would need a logind `Lock`/`Unlock` D-Bus subscription (new
  dependency or helper work). F2 reduces idle-triggered locks; a manual lock still records
  the lock screen.
- **B3 — Compositor-level exclusion.** Wayland gives Electron no capture-exclusion hint and
  no reliable window position, so the conservative unmap stays; no second-monitor exemption
  is inferred except the verified Niri cast/geometry case. Unchanged from the acceptance
  record.
- **B4 — The new Studio window.** `electron/studio/*` (controller, IPC, Niri placement,
  Studio camera relay) lives on `feat/studio-mac` and Olle's `feat/studio-linux`
  (13 commits ahead of PR #1, ending at `5c31d612` "Fix Studio recording controls and
  camera previews on Linux"). It is not part of PR #1. Merging it is a scope decision for
  Olle, not a parity fix, so I did not do it. Facts for that decision: a trial merge of
  `feat/studio-linux` onto this branch in a throwaway worktree (since removed) conflicted
  only in `product-behavior.md`; `npx tsc --noEmit` was clean; the Studio, wake-lock,
  concealment, adapter and handler suites (81 tests) passed. The Studio controller does its
  own capture handling (`hiddenForCapture`, `moveOffCapture`), which is separate from F3.
- **B5 — Live transcript.** The Core ML Parakeet helper is Apple Silicon only
  (`resolveParakeetBinaryPath`); on Linux the footer button is hidden. A Linux path
  (Parakeet through sherpa-onnx) exists on `feat/studio-linux` (`d59b8665`) and comes
  with B4.

## Decisions for Olle

- **D1 — Notes on the Linux HUD.** The button is hidden. With F3 it could be shown, but on
  monitor capture the notes would vanish when Record starts (the same price the pill pays),
  so a teleprompter is only useful there with window capture or while paused. I left the UI
  alone.
- **D2 — Merge scope for the Studio window** (B4).

## Observed, not changed

- `assertHandoffSpace` (`electron/export/sourceHandoff.ts`) assumes only APFS clones; on
  Linux it demands the full source size plus margin even where `copyFile` would reflink
  (same Btrfs filesystem, `copyOriginalFile.ts` already passes `COPYFILE_FICLONE`). On a
  nearly full disk that can refuse a Separate takes export that would succeed. Not fixed:
  recognizing which Linux filesystems and subvolume layouts really reflink needs a measured
  check, and `/home` has 73 GB free.
- Linux still has no standby capture helper; Record does not need the Mac warm-up because
  the portal grant is reused.
- Linux keeps the logo as a native drag region and offers no click-to-fold (documented in
  product behavior).

## Verification run tonight

- Serial, low priority, one process at a time: recording/HUD/capture-policy/hook suites
  (42 files, 442 tests) and launch/review/export/IPC suites (73 files + 3 skipped,
  714 tests + 8 skipped) passed at the PR head plus these commits.
- `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit` and `biome check electron`
  clean after F3.
- The full suite result is in the final section below.

## Full unit suite

`npm run test`, once, at the end, `nice -n 19`: 309 files passed (6 skipped), 3,194 tests
passed (13 skipped), 0 failed. The two `check-docs` problem lines in its output come from
the doc checker's own probe cases, not from failures. `npx tsc --noEmit` and
`npx tsc -p tsconfig.test.json --noEmit` clean. The full suite includes the two handler
tests that failed on the PR head before F1.
