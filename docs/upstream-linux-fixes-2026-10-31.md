# Linux upstream capture fixes — October 31, 2026

Branch: `fix/upstream-linux`. Fresh worktree: `/home/olle/dev/klippt-upstream-linux`.
Base: `origin/feat/studio-mac`, `3f317e3361af48d767753b0afa2a1703c02d1407`.
No merge, installation, release, or visible-host-desktop operation.

## Item results

### (4) DONE — still KWin windows start without repainting

[OpenScreen #1351](https://github.com/getopenscreen/openscreen/pull/1351),
[#1353](https://github.com/getopenscreen/openscreen/pull/1353),
[issue #1101](https://github.com/getopenscreen/openscreen/issues/1101).

- `electron/native/pipewire-capture/src/crop_wait.rs:4`: retain the newest crop-less window frame for 500 ms. A real crop wins immediately; newer crop-less frames do not restart the deadline.
- `electron/native/pipewire-capture/src/main.rs:821`: replay a retained frame when the deadline expires, even if PipeWire sends no more frames.
- `electron/native/pipewire-capture/src/main.rs:637`: apply the same policy during paused source replacement. The independent eight-second no-frame timeout remains.
- Four Rust regressions exercise single-frame expiry, late crop, repeated crop-less frames and immediate monitor admission.

Real private KWin reproduction: the baseline helper from the earlier Studio Linux worktree received exactly **one frame**, discarded it, and failed after eight seconds with `PipeWire supplied no usable screen frame within eight seconds`. The rebuilt final helper received exactly **one frame**, reported the missing crop about **530 ms** after its first buffer, and recorded **93 decoded H.264 frames / 3.100 seconds / 960×676**, with zero dropped input frames. The 500 ms hold is measured by unit tests; live buffer-to-warning time includes loop scheduling. First-frame text was inspected and the entire clip decoded successfully. NVENC, no audio.

Final helper SHA-256: `0ad4b9fe9ffdc1e409b124193411fad7d3dd285c00e35dcf0dae554d293973cf`.
Final test clip SHA-256 before deletion: `de1b0961ad565e9a5000bae12e3f847ead4b243c1afd450993f7c664930cdd1b`.

### (5) DONE — system cursor falls back to metadata

[OpenScreen #1363](https://github.com/getopenscreen/openscreen/pull/1363).

- `electron/native/pipewire-capture/src/portal.rs:72`: Embedded falls back only when Embedded is absent and Metadata is offered. Other unsupported modes retain explicit refusal.
- `electron/native/pipewire-capture/src/request.rs:195`: normalize the effective request before capture, reconfiguration and replacement selection, so the portal grant, remembered-grant key, telemetry and native clip metadata agree.
- `electron/native/pipewire-capture/src/main.rs:145`: publish the resolved mode in `ready`; replacement adoption publishes it in `source-reselected`.
- `electron/recording/nativeMacHelperClient.ts:98`: expose the actual Linux mode, with compatibility for older helpers that omit it.
- `electron/recording/nativeMacRecordingService.ts:1243`: retain editable cursor mode and finalize the existing Linux cursor sidecar across deferred start, Pause, source selection, Continue, Stop and webcam attachment. macOS ignores Linux negotiation fields.

Rust tests cover portal mode selection and reconfiguration. TypeScript tests cover helper events, per-clip and session modes, cursor finalization/media registration and unchanged Mac behavior. Real KDE metadata recording yielded **105 cursor samples**, including cursor sprites. A second real take passed **Pause → select the same still window → Continue → Stop**, producing fully decoded **33-frame / 1.100-second** and **63-frame / 2.100-second** clips, both `editable-overlay`; 983 cursor samples were observed across recording and the human-paced picker wait. Those are raw native samples, not a claim about final sidecar length. This KDE portal offers Embedded, so a real Metadata-only portal fallback and the full application sidecar path remain physical/integration gates; the fallback and service persistence are regression-tested.

### (10) DONE — inhibit Linux display sleep during a take

[OpenScreen #939](https://github.com/getopenscreen/openscreen/pull/939).

- `electron/recording/displaySleepBlocker.ts:6`: one idempotent `prevent-display-sleep` blocker, Linux only, including pauses.
- `electron/main.ts:1248`: drive it from recording-state notifications; `electron/main.ts:1028` releases it on final quit.
- `electron/recording/nativeMacRecordingService.ts:1238`: a fatal Linux helper/writer/recovery failure reports stopped immediately, releasing the blocker without depending on renderer recovery.

Six platform-pinned unit cases cover duplicate start/stop, consecutive takes and untouched Mac/Windows power management; the service regression covers writer-failure release. Real Electron 44.9.1 in the private lab returned one started blocker for two start notifications, and `isStarted(id)` became false after Stop. Physical display blanking/suspend was not triggered.

### (13) DONE — cap VA-API qmax at 30

[OpenScreen #1269](https://github.com/getopenscreen/openscreen/pull/1269).

- `electron/native/pipewire-capture/src/encoder.rs:50`: only VA-API chooses qmax 30; NVENC, Vulkan and software retain FFmpeg defaults.
- `electron/native/pipewire-capture/src/encoder.rs:328` and `electron/native/pipewire-capture/csrc/ffmpeg_shim.c:27`: pass the cap across the existing C layout boundary before codec open. No guessed Rust FFmpeg structure offsets.

A Rust regression calls the real compiled C shim for every encoder backend and reads qmax back through FFmpeg's AVOption API: 30 for VA-API, the original default for the other three. Live capture used this machine's NVIDIA GPU. AMD VA-API keyframe readability, bitrate and driver behavior remain unverified.

### (14) DONE — respect explicit X11/Xwayland launches

[OpenScreen #1081](https://github.com/getopenscreen/openscreen/pull/1081).

- `electron/wayland.ts:9`: append the Wayland Ozone default only when no explicit `ozone-platform` switch exists. Keep the session's PipeWire capture features.
- `electron/main.ts:132`: invoke this configuration only on Linux; the Mac startup block is unchanged.

Seven unit cases cover both session indicators, explicit x11/wayland/auto and non-Wayland sessions. A real Electron command-line probe in the private lab retained `ozone-platform=x11` and `WaylandWindowDrag,WebRTCPipeWireCapturer`. Full Xwayland capture was not exercised.

### (16) DONE — Hide/Open remaps the Linux recording bar

[OpenScreen #1272](https://github.com/getopenscreen/openscreen/pull/1272).

- `electron/windows.ts:502`: hide the Linux HUD instead of minimizing it. Preserve minimization on Mac/Windows.
- `electron/main.ts:216`: existing Open calls show/focus, so a hidden Wayland toplevel is remapped. Existing Niri activation and active-monitor capture privacy remain intact.

Three platform-pinned IPC tests cover Linux/Mac/Windows behavior. Real Electron, the bundled production windows module and its trusted `hud-overlay-hide` IPC handler passed visible → hidden (not minimized) → visible (not minimized) on private KWin. A compositor screenshot was inspected after remapping. This exercised the actual window module with a minimal fixture renderer and Open's show/focus sequence, not the entire tray UI. GNOME tray Open and physical Niri placement/activation remain unverified. The unrelated vertical-bar sizing part of #1272 was not ported.

### Issue #1415 — SKIPPED, no merged upstream fallback

[Issue #1415](https://github.com/getopenscreen/openscreen/issues/1415) points to
[PR #1416](https://github.com/getopenscreen/openscreen/pull/1416), still **OPEN / unmerged** when inspected on October 31.

A separate implementation would need X11-only capture admission when ScreenCast source types are empty, an actual X11 video capture path, normalized window/display coordinates, timestamped pointer and click sampling, per-clip sidecars and lifecycle tests, with Wayland refusal preserved. Sampling the pointer alone cannot repair an unusable ScreenCast grant. No fork or AGPL Recordly implementation was copied.

### Issue #1445 — SKIPPED under the small-safe-change condition

[Issue #1445](https://github.com/getopenscreen/openscreen/issues/1445) now links to
[PR #1446](https://github.com/getopenscreen/openscreen/pull/1446), still **OPEN / unmerged** when inspected. Its diff was read.

Upstream drops every modifier-bearing EnumFormat object on its existing shared-memory retry. This checkpoint's `electron/native/pipewire-capture/csrc/pw_shim.c:1371` already offers SHM first and constrains DMA-BUF to explicit importable modifiers, but it has **no allocation-failure reconnect path** in `src/main.rs:1380`. Adding a reconnect would require another owned PipeWire remote, stream-generation isolation, bounded retry, source replacement/deferred-start handling and negotiation tests. Merely advertising MemFd beside a modifier can produce black COSMIC frames, as the issue demonstrates. No speculative negotiation change was made. A COSMIC/AMD machine is needed for validation.

## Gates and evidence

Completed on CachyOS, isolated KWin 6.8.1 / PipeWire 1.6.10 / Electron 44.9.1 / NVIDIA RTX 4070. No host input, focus, clipboard, audio devices or installed application were changed. The lab fixture contains no audio source, and recorded streams are video only.

- `npm run build:native:linux`: PASS, both capture and Parakeet helpers built and staged. Rebuilt again after the final native source edit; the final single-frame recording used that staged helper.
- `npx tsc --noEmit`: PASS.
- `npx tsc -p tsconfig.test.json --noEmit`: PASS.
- Targeted Vitest: **168 passed**, 7 files (`wayland`, `displaySleepBlocker`, `windows.hudInput`, `nativeMacHelperClient`, `nativeMacRecordingService`, `linuxClipCaptureMetadata`, `linuxRecordingHud`).
- `cargo test --manifest-path electron/native/pipewire-capture/Cargo.toml`: **128 passed, 1 pre-existing ignored integration test**.
- Strict helper Clippy (`--all-targets --locked -- -D warnings`), rustfmt, changed TypeScript Biome checks and `git diff --check`: PASS.
- `npm run test`: run **once**, **3299 passed, 10 failed, 12 skipped**. Eight failures are the known approval/Cargo-graph/release-inventory policy failures. Two additional media failures were caused by the new worktree missing the companion `ffprobe` executable. After staging a system ffprobe link only in the ignored native-bin directory, the exact two affected files passed: **2 passed, 1 skipped**. No source tests were changed to accommodate these failures. The full suite was not rerun and is not reported green.

Local evidence: `artifacts/upstream-linux/capture-summary.json`, sanitized NDJSON event logs, `window-power.json` and `final-static-probe.json`. Gate logs: `/tmp/klippt-upstream-*.log`. Test MP4s, extracted frames and screenshots were deleted after inspection/decoding. The owned lab was stopped.

All requested PRs were read with `gh pr diff N -R getopenscreen/openscreen`; only MIT OpenScreen sources were consulted. Existing upstream license notices remain. Exact Electron API contracts were checked against [44.9.1 powerSaveBlocker](https://github.com/electron/electron/blob/v44.9.1/docs/api/power-save-blocker.md) and [44.9.1 commandLine](https://github.com/electron/electron/blob/v44.9.1/docs/api/command-line.md).

## Remaining physical verification

- Niri: real Metadata-only system-cursor fallback, saved sidecars/review/export, tray Open, multi-monitor placement and actual Xwayland capture.
- KDE: another physical KWin/AMD system reproducing #1101; private KWin's still-window and replacement checks pass, but do not certify every KDE/GPU combination.
- GNOME: Hide recording bar → tray Open, late crop arrival and physical display sleep inhibition.
- AMD: qmax 30 surviving VA-API encoder open and improving the first keyframe at representative resolutions/bitrates.
- COSMIC: negotiate genuine SHM-only buffers, reconnect correctly after allocation failure and reject black-frame success.
- macOS: platform regression tests pass; no physical Mac recording was run for this Linux-only port.
