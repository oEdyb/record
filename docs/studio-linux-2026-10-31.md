# Studio on Linux — October 31, 2026

Branch: `feat/studio-linux`, based on `3794cef1fc457fa558dca29f03326e158b5774cd`
from `feat/studio-mac`. Worktree: `/home/olle/dev/klippt-studio-linux`.
The original checkout and installed app were left alone. No merge or release.

## Acceptance

Evidence below is local to `artifacts/studio-linux/` in this worktree. GUI tests
used agent-lab's private KWin/Wayland desktop, PipeWire graph, portal, synthetic
camera and synthetic microphone meter. No host input, focus, clipboard or speakers
were used. KWin evidence does not establish physical Niri parity.

1. **PASS — Setup.** Source now opens the Linux native chooser through the pill's
   existing `choose-source` command. The shared SourcePicker remains unchanged on
   Mac; it cannot enumerate Linux portal sources. Microphone, Camera and System
   audio show different pressed/off states. A changing microphone meter was
   observed (sample value 25). Notes opened the existing editor window.
   Evidence: `source-portal-ready.png`, `setup-meter-660.png`, `notes.png`,
   `ui-results.json`. Physical microphone capture was not tested; early private
   microphone graph attempts failed visibly with no samples and are not passes.
2. **PASS — Devices.** Mic, camera, quality and editable cursor remain under the
   idle camera at 660px width. At the 560px minimum height the dock now scrolls so
   every control is reachable. Quality menus render above other panes; a long
   synthetic camera label uses a measured ellipsis inside its trigger.
   Evidence: `devices-scroll-660.png`, `quality-menu-fixed-660.png`,
   `long-device-name-660.png`, `ui-results.json`.
3. **PASS — Camera off.** No camera dock remains; notes/document occupy the full
   660px body. Evidence: `camera-off-fixed-660.png`, `ui-results.json`.
4. **PASS within KWin — Live modes and exclusion.** Real window capture kept the
   Studio visible. M cycled both → notes → mirror → nothing with asserted pressed
   states and real live camera frames. Evidence: `live-mode-{0,1,2,3}.png`,
   `live-modes.json`. Real monitor capture hid Studio before both Start and
   Continue; its active snapshot says `shown=false`, `hiddenForCapture=true`.
   Screen files were fully decoded and every frame was checked against the owned
   blue/yellow fixture; Studio and camera preview pixels were absent.
   Evidence: `monitor-final-active.json`, `monitor-final-state.json`,
   `media-results.json`, `verification-summary.json`. Example checked paths were
   `user-data/recordings/recording-1793466583653-clip-0001.mp4` and
   `recording-1793466583653-clip-0002.mp4`. Test media was deleted after checking.
   **SKIPPED:** actual Niri output relocation, physical two-monitor exclusion,
   hotplug and forced movement. Nested Niri has no screencast GBM device in this
   lab; the host desktop was not driven. Existing Niri guard tests passed.
5. **PASS — Pause/replay.** Screen and recorded camera decode and seek together.
   Real pointer events moved and resized the recorded camera tile. Mute sets the
   replay video muted; Home/Right seek worked. Remove previous clip removed the
   kept clip; Undo restored it. Continue added a second clip.
   Evidence: `replay-results.json`, `replay-camera-moved-resized.png`,
   `removed-clip.png`, `undo-restored.png`, `final-capture-state.json`.
6. **PASS for the final bounded workflow — Finish.** Three consecutive final-build
   Record → Pause → Stop → Finish → open Studio → Record cycles passed. Each review
   eventually had exactly the Studio's bounds, after Wayland's configure event.
   The ready review offered Save video and New recording.
   Evidence: `finish-cycles.json`, `finish-review-{0,1,2}.png`,
   `finish-review-ready.png`. An initial immediate bounds assertion sampled the
   old window size before configuration; waiting for the actual size passed.
   An earlier rapid handoff also produced one Electron main-process SIGSEGV in
   GLib (`g_mutex_unlock`). Its cause is unconfirmed; it did not recur in the
   three final cycles. **This crash is not claimed fixed.** `crash-stack.txt`
   retains the evidence.
7. **PASS — Shortcuts.** The dialog shows the enable switch and 25 keycaps with
   action labels. Unit tests also cover shortcut opt-out and focused controls.
   Evidence: `shortcuts-fixed-660.png`, `ui-results.json`.
8. **PASS — Agent socket.** The repository CLI drove `studio`, `studio-state`,
   `studio-do`, `controls`, `click`, `key` and `screenshot` through
   `/run/user/1000/agent-lab/studio/klippt/agent.sock`, the lab's
   `$XDG_RUNTIME_DIR/klippt/agent.sock`. Browser inspection and pointer gestures
   attached only to this test app's private CDP endpoint. Harness scripts and JSON
   results are retained beside the screenshots.

## Fixed Linux bugs

- `src/components/studio/StudioSetup.tsx:158`: the Source button previously opened
  an empty shared picker. Linux now asks the pill for its native portal; the Mac
  dialog has a pinned platform regression.
- `src/hooks/useCameraPreviewFrameBridge.ts:175`: a hidden Wayland pill receives no
  compositor frame callbacks, so Studio's live camera froze. Linux now polls the
  existing camera video at a bounded 24Hz, preserves one outstanding bitmap per
  consumer, skips unchanged media time and cancels its timer on cleanup. Mac keeps
  its frame callback path. Runtime probes saw zero rAF/rVFC callbacks in a hidden
  pill while timer-driven draws still changed.
- `electron/ipc/handlers.ts:2597`: the shared Start/Continue IPC used by the Linux
  renderer discarded the PipeWire node and source kind. Both shared and Linux-only
  endpoints now use the same platform-aware capture context. A real-handler test
  fails with the old context and pins Mac to its previous context.
- `src/components/studio/StudioWindow.module.css:371`: idle devices were clipped
  below the minimum-height window. A Linux-only scroll boundary exposes them.
- `electron/recording/linuxRecordingHud.ts:98` and `electron/main.ts:1262`: source
  selection/Stop restored the pill over Studio. Both restoration paths now honor
  Studio control ownership. Tests cover restoring the pill once ownership returns.
- `electron/studio/studioController.ts:118`: reopening Studio after Finish could
  offer Record before the replacement pill subscribed. Linux holds controls locked
  until that pill reports its first state; Mac behavior is pinned unchanged.
- `src/hooks/useScreenRecorder.ts:1668`: startup awaited rAF after the pill was
  hidden, leaving countdown/startup locks stuck despite a running native writer.
  Linux uses the existing writer acknowledgement and skips that paint wait. The
  regression freezes rAF, fails before the fix and passes afterwards.

## Verification

- Rebuilt PipeWire and Parakeet helpers with `npm run build:native:linux`, and the
  compositor addon with `npm run build:native:compositor:linux` before capture.
  Runtime used this worktree's rebuilt helper. Native hashes and full media
  results: `verification-summary.json` and `media-results.json`.
- `npx tsc --noEmit`: pass.
- `npx tsc -p tsconfig.test.json --noEmit`: pass.
- Targeted Vitest: **183 passed in 14 files**, including recorder startup/failure,
  Studio renderer/controller/IPC, Linux HUD, capture metadata and Niri guards.
- `npm run test`: ran once; **3,275 passed, 12 skipped, 10 failed**. Eight failures
  are the supplied pre-existing dependency/Cargo/inventory failures. Two additional
  media failures came from the local staged ffmpeg lacking its adjacent ffprobe.
  Those two tests passed when rerun with
  `OPENSCREEN_FFMPEG_PATH=/usr/bin/ffmpeg`; no test or runtime source was weakened.
  This full run preceded the final readiness/hidden-rAF regressions; all affected
  tests and both type checks were rerun after those fixes. No second full run.
- `npm run build-vite`: pass. `npm run lint`: pass, one existing oversized evidence
  warning. `git diff --check`: pass.
- React Doctor with `--diff HEAD`: 74/100, one cleanup finding in the relay effect.
  Its returned cleanup explicitly cancels both callback/timer paths, and the new
  Linux timer regression asserts zero timers after unmount. No suppression added.
- No Mac hardware run, physical device timing test, portable package build or
  installed-app replacement. The build is development evidence on this PC.

## Source contracts

The implementation retains the existing platform APIs and dependency versions.

- [Electron 44.9.1 BrowserWindow visibility and Wayland limits](https://raw.githubusercontent.com/electron/electron/v44.9.1/docs/api/browser-window.md).
- [XDG ScreenCast consent/session lifecycle](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html).
- [Chromium video callbacks run during rendering steps](https://chromium.googlesource.com/chromium/src/+/052831f0220b79fe0c3343b49f6d2863ea6de05d/third_party/blink/renderer/modules/video_rvfc/video_frame_callback_requester_impl.h).

## Cleanup and remaining scope

The lab is stopped. All test recording media and the isolated test profile were
removed after collecting hashes, full-decode results and screenshots. The checked
recording paths above are historical paths; JSON evidence remains. No production
recordings, host configuration, installed app or another checkout was changed.
The unexplained earlier GLib crash and physical Niri/device checks remain open.
