# Linux port — execution and evidence

Date: 2026-10-26. Source: `oEdyb/record`, `main`. Working branch: `feat/linux-port`.

## Outcome

Run the existing Klippt recording product on Linux with the same shared interface,
clip lifecycle, source handoff and durable project model. Preserve macOS behavior.
Keep Windows behind the same native-helper boundary for its later implementation.
The older dirty `~/dev/screenrec` checkout belongs to `oEdyb/screen`; leave it untouched.

## Architecture and implementation order

1. Keep Electron/React and the existing review/export engine. Do not redesign UI,
   restore archived editing features, or replace native recording with browser capture.
2. Extend the Linux Rust/PipeWire helper to the existing structured clip protocol.
   Keep one portal/PipeWire session across Pause/Continue; finalize files at Pause;
   start a new file on the first accepted frame after Continue. Acknowledgements
   must follow actual writer state. Preserve the legacy cursor-only helper mode.
3. Reuse the tested recording service, protocol client and recovery journal for Linux.
   Keep existing IPC names compatible. Use the current shared HUD clip flow, including
   Backspace/Undo, storage monitoring, fatal-error reporting and quit finalization.
4. Write separate microphone and system-audio originals during capture, retaining
   the compatibility mix used for review. Keep renderer camera capture per clip
   until native camera capture can prove a practical benefit.
5. Add direct NVIDIA NVENC to the encoder ladder, retain VAAPI/Vulkan and explicit
   software fallback diagnostics. Use fragmented MP4 for recoverable in-progress files.
6. Build Linux helper, native compositor and local app. Fix concrete launch and package
   failures. Never weaken dependency/signing/provenance checks to produce a package.
7. Exercise affected tests and native file/decode checks. Run static validation and one
   final unit suite. Attempt real isolated desktop capture and inspect media. Record
   any consent/hardware/desktop limitation as unverified rather than claiming parity.

Each implementation slice names its owned files in the delegated brief. Native helper
work and Electron integration may proceed independently against the established protocol.

## Verification

- Rust: helper tests, formatter, clippy; real encoder/file/decode checks.
- TypeScript: app and test typechecks; targeted recording/helper/IPC/HUD tests.
- Product: real Record → Pause → Continue → Backspace/Undo → Stop, readable clips,
  originals handoff with byte comparison, review, and helper-failure recovery.
- Packaging: build and launch the Linux app in an isolated data directory, inspect UI;
  report selected encoder, timings and dropped/repeated frames separately.
- Run repository lint and relevant documentation/design checks. Avoid repeated full suites.

## Primary sources

- [XDG ScreenCast lifecycle and cursor modes](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [Electron desktopCapturer Linux caveat](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [FFmpeg fragmented MOV/MP4](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)
- [FFmpeg NVENC contract](https://github.com/FFmpeg/FFmpeg/blob/master/doc/encoders.texi)
- [NVIDIA Video Codec SDK](https://developer.nvidia.com/video-codec-sdk)
- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)

Use the pinned FFmpeg SDK headers/source and installed library capabilities to verify
specific APIs. The October 15 cross-platform plan is historical; this request prioritizes
Linux first. No portable Wayland API excludes our own windows from a full-display capture.

## Progress

- [x] Current private repo identified and cloned; existing dirty checkout preserved.
- [x] Existing product, capture architecture, protocol and cross-platform plan inspected.
- [x] Primary platform documentation consulted; independent code/docs research started.
- [x] Native Linux clip protocol and source files.
- [x] Shared service/HUD integration and recovery.
- [x] NVIDIA performance path and Linux build.
- [x] Focused validation, real smoke, handoff and project-card update.

## Evidence and remaining limitations

The following evidence comes from this checkout on CachyOS, niri 26.04, RTX 4070,
Ryzen 5 9600X and 64 GiB RAM. Local artifacts are under
`artifacts/linux-port-2026-10-26/` (ignored media, not release assets).

### Capture and product behavior

- The packaged Electron 44.9.1 app launched with isolated user data. Actual OS mouse
  and keyboard input exercised Record → portal window selection → Pause → Continue
  → Pause → Backspace through zero → Continue → Pause → Backspace/Undo → Stop.
  The committed session retained both removal flags and the restored third clip.
- The portal picker hides the HUD and restores the surviving window afterwards.
  Linux uses a compact input-enabled HUD; settings/popovers grow its bounds and
  dismissal shrinks them. Screenshots cover the HUD, settings and actual review.
- Review loaded and played the recorded clip. Testing playback through its final
  GOP exposed a decoder EOF-drain bug. The Linux seek path now reuses the existing
  sequential pump, drains frame-thread buffers at EOF, and retains the final frame.
  A small generated fragmented H.264 fixture reproduces the bug without desktop access.
- Separate files exported from the UI with screen, OTIO, FCPXML and handoff manifest.
  The screen original SHA-256 matched byte for byte. UI One video export fully decoded
  as H.264/AAC at 1262 × 1374. Neither removed clip was exported.
- SIGKILL of the owned active helper stopped the HUD and opened review with an
  interrupted, playable screen clip. All completed video fragments decoded without
  errors. The recovered session records `capture-helper-exited` and provisional timing.
- Chromium's synthetic camera exercised real renderer recording through two clips,
  Pause/Continue and native window-manager close while recording. Both camera paths
  and offsets were persisted in the session and journal before quit; all four screen
  and camera files fully decoded. The initial run caught registry-only camera
  attachment; attachment now durably updates the canonical manifest. This verifies
  the recording/persistence plumbing, not physical-device support or camera A/V sync.
  Reopening without a camera device restored both clips and camera overlays, played
  through the end without an error, and exported all four originals byte for byte.
- Both HUD creation paths intercept normal window-manager close while a take or
  renderer save is pending. Ordinary Stop → Quit joins the same save job; no second
  camera drain runs. Repeated quit, errors, expiry and logout are covered.
- Shared service tests cover rejected reconfiguration/retry, failed Pause preserving
  camera footage, Pause/Stop overlap, renderer fatal errors and quit handoff. The
  old uncalled `LinuxNativeCaptureSession` and its tests were removed after the real
  workflow passed; cursor-only helper compatibility remains in use.

### Native media and performance

| Measurement | Result | Scope |
| --- | --- | --- |
| Five-minute actual portal capture | 300.05 s first clip, 2.066 s second clip, 60 Hz video | Animated owned fixture, negotiated 1262 × 1374; its text label says 1280 × 720 but niri tiled it larger |
| Pause / Continue / Stop | About 130 / 200 / 130 ms | Two-clip helper run; not a p95 latency study |
| Capture encoder | NVENC, no rejected backend | Logged actual encoder selection |
| Steady capture CPU | 106% of one CPU core | 236 s sampled interval, includes video and two audio writers |
| Capture memory | Median 359.7 MiB, peak 367.1 MiB | Same sampled interval; not whole-app RSS |
| Source readiness | Screen acknowledged only after a muxed H.264 packet; audio after an AAC packet | Native readiness/error regression tests and live events |
| Separate audio | 48 kHz stereo AAC microphone and system originals | Both clips; microphone carries the virtual 660 Hz source, system original is silent because the actual default sink was silent |
| Five-minute file decoding | All six source files fully decode without errors | Screen compatibility mix plus two originals per clip |
| Native rendered export | 120 frames at 1080p60 in 0.450 s, 266.7 fps | Short synthetic terminal-like input, Vulkan compositor, software decode, NVENC hardware encode, no fallback |
| Export total JS call | 2.807 s including verification | Same short export, verified opening and tail |

The first long clip's standalone audio durations were 300.053 s (microphone) and
300.075 s (system); video was 300.071 s. These container-duration differences are
small but do **not** prove sub-frame synchronization. Offsets are estimated from
capture drain boundaries; timestamps from the PipeWire audio graph remain a parity
gate. A late source no longer inserts startup silence twice in the compatibility
mix: decoded-AAC onset regressions cover original offsets of 900 and 950 ms.

DMA-BUF pixels use a private Wayland EGL connection on the compositor's GPU,
queried explicit single-plane RGB modifiers and bounded RGBA readback. Native GPU
checks cover all four admitted RGB formats, channels, row order, import and teardown.
An implicit modifier was insufficient on this NVIDIA/niri combination: niri could
not render to the allocated buffer. Production negotiation advertises only queried,
single-plane modifiers; corrupt buffers remain rejected. SHM remains negotiable.
This is GPU import plus CPU readback/conversion and hardware encoding, **not** a
zero-copy recording path.

RGB conversion uses full-range RGB → limited-range BT.709 matching the container
and codec tags. A decoded red-frame regression checks the matrix, not just metadata.
Colorspace setup runs only after swscale allocation/initialization for every backend;
it no longer dereferences a null context during VAAPI/Vulkan setup.

### Build and checks

- Repository-pinned Node 22.22.1 / npm 10.9.4 used for final build and checks.
- One full unit run: 3,035 passed, 13 skipped before removal of the obsolete Linux
  client. Subsequent changes use focused suites only. Latest recording/quit/hook
  run: 180 tests; policy/metadata/portal run: 73 tests.
- Native helper: 81 passed, one existing live-PipeWire test ignored. C capability,
  modifier admission and actual EGL GPU tests passed. Native decoder regression
  and supplied real-media tail probes passed.
- App/test typechecks, Biome, documentation, design and all locale checks passed.
  Biome retains the existing oversized Cargo evidence warning.
- Strict helper Clippy now passes with `-D warnings`. SDK codec field access moved
  behind the existing C shim; codec/index objects remain opaque in Rust, and
  unused stdio dump bindings are excluded. No generated files, dependency versions
  or lint suppressions were changed. Native helper: 83 passed, one existing live
  PipeWire test ignored.
- Native helper and symbol-isolated compositor build and load. Opaque FFmpeg
  structs are accessed through compiled C shims, including duration/IO accessors.
- Local unpacked package built and launched with the existing explicit
  `OPENSCREEN_SYMBOL_FLOOR=host` mode. It is a CachyOS development artifact, not a
  portable Linux release. CI remains pinned to Ubuntu 22.04 and retains the symbol,
  provenance, license and packaged-distribution gates. No signing or provenance
  checks were disabled. The local Whisper manifest truthfully identifies workflow
  zero as a local build, with actual source SHA, upstream pins and binary hashes.
- Desktop identity is `co.dyberg.klippt.desktop` with electron-builder desktop-name
  synchronization. No obsolete portal feature flags were added to Electron 44.

### Remaining platform gates

- Renderer camera originals retain their Matroska/WebM container. Source handoff
  warns that some video editors require conversion; it preserves those originals.
- A physical webcam is unavailable (`/dev/video*` absent). Per-clip camera and quit
  races have regression coverage and a synthetic-device desktop pass, but physical Linux camera capture remains unverified.
  Camera WebM streams now journal their path after first disk append. A real
  synthetic-camera SIGKILL/reopen pass restored both sources and the saved project;
  all 615 decoded camera-frame hashes survived container repair. The last unwritten
  MediaRecorder chunk can still be lost in a hard crash.
- The two-clip NVIDIA hour repeat completed; exact measurements and binary provenance
  are below. Physical-device sample-clock parity, AMD/Intel encode hardware and other
  desktop portal backends remain unverified. This host result and short export
  benchmark cannot establish Mac-equivalent performance universally.
- A real macOS hardware regression pass is still required for the shared lifecycle
  changes. Windows helper/lifecycle parity remains the next port, not a delivered
  Windows implementation from this branch.
- Unchanged Continue reuses one portal session. Paused source and cursor-mode changes use a transactional replacement
  portal session; cancellation preserves the previous paused grant. Wayland has no portable own-window exclusion.
- Electron reported global shortcut registration on niri, but Ctrl+Shift+Space
  with the fixture focused did not activate Pause. Portal identity is now correct;
  actual compositor/backend activation is still a desktop integration gate. No
  user compositor configuration or global environment was changed.
- Ubuntu 22.04 baseline builds and bare distro loader checks passed locally; the
  final AppImage also passed the actual desktop recording/export flow. GitHub CI
  has not executed because of account billing. These are private test candidates.

Additional primary contracts used:
[PipeWire DMA-BUF negotiation](https://docs.pipewire.org/page_dma_buf.html),
[kernel DMA-BUF layouts](https://docs.kernel.org/userspace-api/dma-buf-alloc-exchange.html),
[niri screencasting](https://niri-wm.github.io/niri/Screencasting.html),
[Electron 44 global shortcuts](https://raw.githubusercontent.com/electron/electron/v44.9.1/docs/api/global-shortcut.md),
[Electron 44 BrowserWindow](https://raw.githubusercontent.com/electron/electron/v44.9.1/docs/api/browser-window.md).

### Follow-up: renderer camera crash journal

Renderer camera streams now register their canonical path and captured offset after
first successful disk append, authenticated by the take token and owning WebContents.
The existing recovery journal commits that metadata before further chunks. Startup
recovery can reindex unfinished WebM through the native remuxer; live Stop never
replaces an open camera file. Prepare/Start wait for startup recovery to finish,
so a new take cannot be mistaken for crashed media. Native MOV/audio originals
still require validated finalization or recovery; the renderer merge is WebM-only.

Validation: 169 focused tests; both TypeScript checks and Biome pass. Three Start/
Prepare regressions fail without the startup barrier, and unreadable native-source
regressions fail when all provisional originals are blindly merged into Stop.
Fresh review found no remaining P1/P2 issues after those corrections. The actual
hard-crash desktop pass passed after the first attempt was interrupted by driver
allocation failures. Both sources fully decode after reopen; the recovered project
contains its camera, the review renders the overlay, and 615 decoded camera-frame
hashes match before/after repair. The camera container changes; decoded pictures
are unchanged. Evidence: `artifacts/linux-port-2026-10-26/camera-hard-crash/`.
The concurrent hour test completed with audio-drop warnings in clip two and is
retained for diagnosis, not counted as an endurance pass.

Linux packaging now refuses a missing pinned Electron Chromium notice before
building. The bare-install loader script uses the current Klippt layout and requires
all three expected executables instead of silently skipping missing ones.

### Follow-up: stalled audio and portable package policy

The first half-hour source fully decoded (108,005 frames, no decoder errors or
reported output drops); audio/video marker medians were 9.688 ms both initially
and near minute 30. The full hour was not a pass: clip two lost about 67.8 seconds
of PCM while the host logged NVIDIA GSP allocation errors. Ring overflow discarded
samples without preserving their time. Missing intervals now become silence in
both the source original and compatibility mix. A segmented queue represents gaps
without allocating the whole missing duration; encoding uses blocks of 8,192
samples. AAC regressions cover overflow, a source already advanced with silence,
and an established microphone disappearing and returning. Ring loss is corrected;
this does not add PipeWire graph timestamps or prove physical-device clock parity.

EGL still unbinds the context after each read but releases per-thread driver state
once at worker retirement. The PipeWire loop disconnects the producer, releases
that state, and joins before owner teardown. This avoids rebuilding thread state
at frame cadence. Native format/channel/admission tests and strict C compilation
pass; the fresh visible 1920x1080/60 two-clip hour result is recorded below. Do not
attribute the original host driver failure conclusively to this cleanup pattern.

Ubuntu 22.04 baseline builds produced AppImage/deb/pacman/rpm with the strict symbol
floor. Bare Ubuntu/Arch/Fedora installations resolve every shipped ELF and reach
all three expected executables. The verifier now recognizes root `resources/`
paths for reviewed cursors, WebAssembly and Chromium notices. Generated Linux
package markers must match the known values, and AppArmor content must match the
pinned electron-builder template exactly; casing cannot bypass validation, and
macOS rejects those Linux extras. The local Whisper manifest includes the actual
pinned build's Parakeet sidecars. Linux maintainer metadata is Dyberg & Co AB.
Final package regeneration and artifact verification passed at runtime `d7b0dafc`;
older host-mode/first-build artifacts are superseded.

Source contracts: pinned SDK `AVCodecContext` and `ffmpeg_shim.c`; pinned
`app-builder-lib/templates/linux/apparmor-profile.tpl` and `FpmTarget.js`;
[Khronos EGL thread cleanup](https://registry.khronos.org/EGL/sdk/docs/man/html/eglReleaseThread.xhtml)
and [PipeWire loop invocation](https://docs.pipewire.org/group__pw__loop.html).

### Portable artifact verification

All four Ubuntu-baseline formats were regenerated from runtime source
`d7b0dafc2e1f3c47c9a4f3089b9e91eda51d3bdf`, with the strict symbol floor and
complete local provenance manifest. Clean installation/loader checks passed again
for the preceding `575c432b` native payload, unchanged by the final suspend-only
JavaScript change: 27 ELFs resolve; Klippt, Whisper and the capture
helper reach main. The installed package marker matches each format, and the deb
maintainer is Dyberg & Co AB. The floor-built addon also remuxed the real crashed
camera on Ubuntu: 615 packets, 30.75-second result, no GPU required.

The extracted AppImage contains additional icons outside `resources/`. Its policy
now maps only the exact expected paths to the matching branded PNG bytes, including
`.DirIcon`, the root icon and each hicolor size. Unrecognized locations and changed
bytes remain rejected. Actual extracted-artifact policy passes; 43 focused policy
tests include replacing `.DirIcon` with another reviewed but incorrect-size image.
This verification-only change does not alter the immutable runtime artifacts.

Artifacts and SHA-256 inventory are under
`artifacts/linux-port-2026-10-26/portable-build/output/`, with user-facing copies
and SHA-256 inventory at `release/linux-port-20261026-d7b0dafc/`. The actual final
AppImage desktop result is below.
GitHub's latest CI jobs still executed zero steps; the check annotations identify
failed account payments or the spending limit as the reason.

### Linux suspend parity

Linux now forwards Electron's supported `suspend` event through the shared recording
interruption path. The renderer pauses the active clip and drains its camera,
allowing explicit Continue after wake. macOS keeps its existing lock/suspend
handling; Linux does not register the unsupported lock-screen event. The actual
machine was not suspended during validation. A real-handler simulated event
regression fails before the wiring and passes after; the final combined focused
run passed 213 tests on Node 22.22.1/npm 10.9.4, with both TypeScript checks clean.
Contract: [Electron 44.9.1 powerMonitor](https://raw.githubusercontent.com/electron/electron/v44.9.1/docs/api/power-monitor.md).


### Completed hour repeat and final packaged desktop pass

The repeat recorded two 1,800.083-second clips in one portal session, separated by
Pause/Continue. Both selected NVENC. All six screen/microphone/system originals
fully decode; each screen has 108,005 output frames. No audio-overflow warnings
occurred. Complete microphone pulse scans found 1,801 and 1,800 pulses, with no gap
over 1.01 seconds. Initial/late A/V marker medians were −23.313/−39.979 ms for clip
one and −42.313/−42.313 ms for clip two. The settled clip-one measurement was also
−39.979 ms. These signed offsets include fixture rendering/audio latency; they are
not calibrated physical-device offsets. Encoded source-clock barcodes changed by
about ±6 ms between the settled minute-four and minute-29 windows, excluding a
frozen source or whole-second marker alias.

Pause finalized in about 80 ms; Stop in 81 ms. The helper reported 81 captured
frames superseded before encoding, which is separate from decoder output cadence.
From minute one, CPU averaged 61.3% of one core and RSS rose from 391.0 to 476.0 MiB;
this is not a flat-memory claim. No new NVIDIA allocation/Xid errors occurred during
the repeat, including a fresh AppImage/camera launch near its end. The first failed
hour remains retained. This does not conclusively attribute its host driver failure
to any one code path.

The endurance binary includes the audio-ring loss fix and EGL worker cleanup but
predates the final returning-source/atomic-clear and opaque-codec refinements.
`soak-60m-rerun/binary-source.json` and `native-source.diff` preserve its exact
provenance. Subsequent decoded-media regressions, strict Clippy and the final
packaged NVENC smoke cover those later changes; the exact final bits did not run
for an additional hour. Evidence is in
`artifacts/linux-port-2026-10-26/soak-60m-rerun/`.

The immutable `d7b0dafc` AppImage launched through extract-and-run with isolated
user data. Real OS keyboard/mouse and native accessibility actions drove the owned
fixture picker, Record, Pause, Continue, Stop, playback and Separate files export.
CDP supplied inspection only. The test driver's absolute mouse reset touched niri's
overview hot corner; dismissing overview before clicking corrected the harness.
The app used its extracted bundled helper and Vulkan addon, verified by process
arguments/maps. Both clips selected NVENC. The synthetic camera produced separate
3840×2160 H.264 WebM files. All four media files fully decode; review renders the
camera and plays through 15.982 seconds without a compositor error. Source export
produced OTIO/FCPXML and all four original hashes match. The two handoff warnings
identify WebM editor compatibility. Capture reported 53 superseded source frames
during this short flow; physical camera and zero-drop claims are not established.
Evidence: `artifacts/linux-port-2026-10-26/portable-final-smoke/`.

All owned test apps, fixture and private audio jobs exited; the build container is
stopped. No user compositor configuration, default audio device, installed Mac app,
public release, production branch or existing recordings were changed.

### Producer-cycle audio gaps

A decoded regression confirmed a remaining source-timeline defect: a two-second
microphone timeline with a 900 ms outage became an approximately 1.1-second original.
Ring-overflow accounting alone could not represent time when no callbacks arrived.
PipeWire audio header metadata was absent even when requested on this host. The
per-buffer cycle timestamp is available from PipeWire 1.0.5 and is assigned before
deferred callback execution. C forwards that clock with each PCM block, guarded by
the loaded runtime version so older, shorter `pw_buffer` allocations are never read
past their end. Older runtimes retain the untimed behavior. Initial source offsets
remain estimated; physical-device latency and whole-clock rate correction remain
gates. Contracts: [pw_buffer timing](https://docs.pipewire.org/structpw__buffer.html)
and [the pinned implementation](https://raw.githubusercontent.com/PipeWire/pipewire/1.0.5/src/pipewire/stream.c).

The bounded ring now restores producer-clock gaps larger than two milliseconds
with silence at their original positions. A cumulative PCM-frame cursor tolerates
smaller clock jitter without repeatedly moving its anchor and stretching continuous
audio. Long gaps consume only the normal ring capacity, with the omitted prefix
preserved by existing missing-sample accounting. Pause clears the clock history;
retained-writer Continue also rebases every input at the emitted mix position.
The ring also reports a new clock anchor to the mixer, which places the first
fresh block after a delayed return on the current timeline. This keeps a source
starved before or after Pause audible after Continue.

Focused regressions cover a 60-second stream with alternating 100 μs clock jitter,
a timed microphone returning after legacy Pause/Continue, a measured gap in both
original and compatibility AAC, delayed post-Continue return, multiple queued
blocks, long gaps/overflow, unavailable timestamps and Pause clearing. The independent review found jitter, legacy Continue and delayed-return defects;
all were corrected and cleared by fresh reviews. Native helper tests: 95 pass,
one existing live test ignored; strict Clippy and formatting pass.
The C ABI review passed 13 runtime-version cases and protected-page tests with
24-byte/32-byte older buffers plus current 64-bit timestamps.

A live NVENC capture deliberately stopped the helper for 500 ms. Video and source
AAC remained about 7.09/7.08 seconds, fully decodable; pulse-to-flash offsets before
and after the stall stayed within one output frame. Missing captured content during
the stall remains missing; its time is preserved as silence/held video. This first
live pass preceded the jitter refinement. Evidence and binary provenance are under
`artifacts/linux-port-2026-10-26/audio-cycle-time/`. The older immutable `d7b0dafc`
candidate does not contain this follow-up; `f7ca5dfd` below supersedes it.


A regressing capture-cycle clock is now rejected before admitting its PCM. The
cycle uses PipeWire's monotonic clock; guessing a new epoch could reorder queued
originals or compress an outage while the compatibility mix looked correct. That
condition therefore follows the existing visible writer-failure/recovery path,
while ordinary forward-clock outages and post-Continue delays recover automatically.
An integration regression verifies the error, rejects the bad clip, retains the
previous committed clip and fully decodes its original. Pause clears the failed
clock state for a new clip. This supersedes the initial attempted backward-clock
reanchor behavior; no source timing recovery from an invalid backward clock is claimed.


Audio drain, source readiness and the video grid now share one clip clock that
freezes during Pause and excludes completed pauses. A real 500 ms pause regression
covers `advance`, close-boundary and final drain; before correction it decoded
34,816 mono frames where only approximately 200 ms of source audio belonged.
Continue gets a fresh watchdog deadline and is acknowledged only after a new
encoded packet. A real 2.1-second legacy Pause/Continue regression reproduces the
old stale watchdog failure; fresh-packet readiness has a separate regression.
These preserve the legacy single-file request while canonical recordings continue
to create fresh clip writers. Fresh review and package generation pass.


### Current candidate: f7ca5dfd

Runtime source `f7ca5dfd2f10cca67f6440089260d075f7523397` includes the producer-cycle
correction, invalid-clock failure boundary, shared active clip clock and Continue
readiness/watchdog fixes. Final independent review passed. Native tests: 95 passed,
one existing live test ignored; strict Clippy, formatting and whitespace checks
pass. No full JS rerun was needed for this native-only follow-up.

All four package formats were rebuilt on the Ubuntu 22.04 baseline with strict
symbol checks and complete local provenance. Unpacked policy and extracted
AppImage policy pass against the original container build outputs; comparing with
a different host build correctly rejects its mismatched JavaScript output hashes.
Fresh bare Ubuntu/Arch/Fedora installations of the final deb/pacman/rpm pass:
27 ELFs resolve and all three expected executables reach main. Candidates and
SHA-256 inventory: `release/linux-port-20261026-f7ca5dfd/`. Reproducible output:
`artifacts/linux-port-2026-10-26/portable-build/output/audio-cycle-f7ca5dfd/`.
The earlier `3960aa8c`/`705357d9` intermediate builds are superseded.

The actual AppImage passed OS-driven Record/Pause/Continue/Stop with two synthetic
camera clips, bundled Vulkan preview through the last frame, and Separate files
export. All four screen/camera originals fully decode and their exported hashes
match; both OTIO and FCPXML are present. The WebM compatibility warnings remain.
A separate ordinary FUSE launch also opened its HUD; extract-and-run is not
required on this host. Test user data stayed isolated from normal recordings.

The exact packaged helper hash matches the floor-built helper used in a separate
private-audio live test. It retained NVENC through a 500 ms process SIGSTOP and a
three-second legacy Pause/Continue. The resulting file has 484 video frames,
8.088 seconds total and 8.085 seconds of audio; it fully decodes. Initial/late
pulse-to-flash differences stayed within one 60 Hz frame (approximately −31 ms
initially and −40 to −23 ms after Continue). This is relative alignment evidence,
not calibrated physical-device latency. The helper reported 23 superseded source
frames during the deliberate stall. A prior canonical two-clip floor capture also
fully decoded its four screen/audio files. The newer full-hour claim is unchanged:
its exact earlier binary provenance is recorded; these final bits did not run for
an additional hour.

Evidence, logs, source-copy hashes and helper hash matching are under
`artifacts/linux-port-2026-10-26/audio-cycle-time/`, especially
`appimage-f7ca5dfd/` and `legacy-floor-capture-f7ca5dfd/`. All owned apps, fixtures
and private audio jobs exited, and the build container is stopped. GitHub CI still
requires the external account billing/spending-limit gate to be resolved. Physical
camera, other hardware/desktops, Mac regression, older untimed PipeWire and initial
offset/rate calibration remain unverified; Windows remains the later port.

### Follow-up: fragmented MP4 camera originals

Linux renderer cameras now prefer `video/mp4;codecs=avc1` when supported. Other
platforms and unsupported runtimes retain their existing WebM selection. The
camera filename travels with its recorder into the clip ledger; main derives the
same canonical path from the validated container enum and existing HUD ownership
token. Registered renderer paths have explicit provenance at Stop, so native
originals omitted after failed finalization still require media validation.
MP4 bypasses Matroska remux and WebM duration patching, including the memory
fallback. Recovery validates canonical MP4 camera fragments without rewriting
them; header-only files remain on disk and are not attached as readable media.

The pinned Chromium muxer only considers a fragment flush at a video keyframe:
[Chromium 152 MP4 muxer](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.167/media/muxers/mp4_muxer.cc).
The [MediaRecorder options definition](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.167/third_party/blink/renderer/modules/mediarecorder/media_recorder_options.idl)
exposes a duration-based keyframe interval. A hidden, isolated Electron 44.9.1 /
Chromium 152.0.7977.167 fake-camera probe falsified the default: ordinary 1-second
chunks held all MP4 payload until Stop. Using 500 ms keyframes and a 250 ms
timeslice produced the first readable 4K/20 fps payload at 1,111 ms. That prefix
fully decodes 21 frames; a later prefix decodes 42; the complete 4.944-second file
decodes all 99 frames, reports finite duration and seeks near the end. No physical
camera, camera CPU parity, or universal first-fragment deadline is established.
More frequent keyframes increase file size; the probe's simple synthetic picture
is not a compression benchmark. Evidence: `artifacts/linux-port-2026-10-26/camera-container-probe/`.

Validation before desktop packaging: 194 affected-area tests pass, both typechecks
and lint pass (one existing oversized evidence-file warning). Two independent
fresh-context reviews found no concrete P1/P2 regressions. Current React Doctor
reports 75 on both the unchanged baseline and this slice, with the same existing
HUD cleanup finding; no camera-change finding. The earlier score of 82 used an
older tool revision and is not a directly comparable baseline.


The exact Ubuntu-baseline candidate at runtime `af35b212` launches normally through
FUSE and passes extracted-AppImage provenance/policy. Fresh deb/pacman/rpm installs
resolve all 27 ELFs and reach the three expected executables. Its bundled capture
helper is byte-identical to the verified `f7ca5dfd` floor helper
(`3445c0b1ce5f9f33393c372b5d7e2904ff38ae28735de09d722615b8cb4cff70`);
this slice changes renderer recording and orchestration, not native capture.

OS-driven recording produced two screen/camera pairs. After Pause/Continue, all
owned app processes and the helper were frozen and killed during the second clip.
Restart recovered both clips and cameras into a saved project. All four media
files retain exactly their crash-time SHA-256 hashes and fully decode: 1,922/2,310
screen frames and 641/774 camera frames. The interrupted camera's readable duration
is 38.700 seconds versus the recovered screen's 38.500 seconds; recovery retains
the complete original and review uses the screen clip boundary. The saved project
contains both camera paths and offsets. Preview played through 70.533 seconds with
the camera overlay and no compositor error. Separate files exported four identical
originals plus OTIO/FCPXML with MP4 camera paths and zero handoff warnings.

One video completed with `h264_nvenc` (`hardware=true`, `fallback=false`), producing
4,231 video frames and a 70.533-second AAC stream. Full decoding passes; the final
rendered frame contains the screen and camera. All audio settings were disabled
in this synthetic-camera run; this does not replace the earlier isolated-audio
checks. Logs, crash snapshots, project, timelines, hashes and inspected final-frame
images: `artifacts/linux-port-2026-10-26/camera-container-probe/packaged-crash/`.
The private package inventory is `release/linux-port-20261026-af35b212/`, with source
commit, helper manifest and SHA-256 sums. Build output is
`artifacts/linux-port-2026-10-26/portable-build/output/camera-mp4-af35b212/`.
No physical webcam or additional endurance run was performed. The initial MP4
header alone has no recoverable pictures; the first usable fragment and any
unwritten tail remain subject to recorder/encoder timing. Owned apps/fixture and
the build container are stopped.


### Paused source replacement

Linux now exposes one **Source** action in paused settings. It opens the native
portal, retains the current paused source until the candidate supplies a usable
frame, and applies the replacement only to the next clip. Normal Continue stays
picker-free. Mac and Windows keep their existing controls.

A new portal session is required because
[SelectSources is once per session](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html).
The pinned ashpd 0.9.3 provides `Session::close` but does not close on Drop.
Explicit leases therefore cover each PipeWire consumer and close abandoned or
replaced grants. Generation-tagged events keep old callbacks out of the adopted
source. Adoption resets geometry, frame timestamps and cursor assets; cached
cursor sprites retain their bitmap across position updates and replay before
newer queued updates. Completed clips remain untouched.

Picker consent has no human timeout. The candidate gets an eight-second usable
frame deadline after connection. Cancellation and candidate failure retain the
old paused source. Selection commands are serialized and deduplicated; Stop
cancels both queued and active selection before joining that queue. IPC requires
the recording owner's WebContents, recording ID and take token. The HUD hides
for consent; clicking its existing tray icon restores it, allowing Stop while
the dialog is still pending. No global shortcut availability is assumed.

Focused tests cover candidate crop/deadline, independent PTS origins and output
sizes, preserved first-clip bytes, cursor cache/order, normal cancellation/retry,
immediate Stop, duplicate selection, owner rejection and paused settings.
The first real desktop pass selected two owned fixture windows, continued into
900×600 media from a 1262×1374 source, cancelled another picker and continued,
then restored the HUD from its tray and stopped with another picker pending.
That Stop cancelled selection in 9 ms and returned in 36 ms. The three files
fully decode; the first clip hash is unchanged. Continue acknowledgements were
117 and 119 ms. Preview crossed the replacement boundary without a compositor
error. Evidence: `artifacts/linux-port-2026-10-26/source-replacement/`.
The first pass preceded the final cursor replay ordering correction. The final
helper (`a2be969280b06fe04fef8f41f663907c5983a72d4495abdc7569aaa7059613f0`)
then passed another actual two-source desktop capture, full decoding and preview
boundary crossing. Continue returned in 141 ms. Final affected checks: 316 JS
tests, 103 offline native tests (one existing ignored, two live tests filtered),
both typechecks, strict Clippy, lint/docs/design/i18n. The changed-file React
Doctor scan has no findings. All four Ubuntu 22.04 packages at runtime `b6c90b0a` pass strict policy;
extracted AppImage and fresh Ubuntu/Arch/Fedora loader checks pass. Inventory:
`release/linux-port-20261026-b6c90b0a/`. The normal FUSE AppImage passed actual
OS-input source replacement with its bundled helper (`dd002d51e5283bc2b4f1c6facacc18a3913f44cb51dd04450ca3d4da3efbe31a`),
retained the same helper PID, preserved the first clip hash and fully decoded
both clips. Closing the old fixture after adoption did not interrupt capture.
Final-host One video uses NVENC without fallback: 1,352 frames, 22.55 seconds,
fully decoded, with the replacement fixture visible at the tail. The earlier
`af35b212` packages do not include replacement.
At that source-replacement checkpoint, changing the portal-fixed cursor mode
while paused was still rejected; the cursor-grant follow-up below removes that gap.

Source-replacement inspection also exposed an incorrect existing setup diagnostic:
it recommended the GTK fallback backend for ScreenCast. The helper now names only
ScreenCast-capable backend choices and explicitly maps niri to GNOME. The official
[GTK backend descriptor](https://raw.githubusercontent.com/flatpak/xdg-desktop-portal-gtk/main/data/gtk.portal.in)
has no ScreenCast interface; [niri's setup contract](https://niri-wm.github.io/niri/Important-Software.html)
requires the GNOME backend for screencasting. Installed descriptors agree.
A focused regression fails before and passes after the correction; an actual debug
helper probe with a deliberately nonexistent child-only D-Bus address emits the
corrected error and exits without opening a picker. Strict Clippy and formatting
pass. Probe evidence: `artifacts/linux-port-2026-10-26/portal-diagnostic/`.
This diagnostic-only follow-up is not in the earlier `af35b212` candidate packages.


### Invisible routine Linux testing

Olle's October 26 instruction moves routine GUI, browser, input, audio and portal
tests into `agent-lab`, with no host pointer, focus, clipboard, tones or picker
interaction. The installed tool and commands are documented in
`~/.local/share/agent-lab/README.md`. It uses a private 1920×1080 KWin 6.8.1 display,
D-Bus, profiles and PipeWire/Pulse graph with a null sink/monitor. All named
instances share a low-priority two-core/6 GiB cgroup, with no login service.
Stopping a core stops its bound test applications. Input refuses the host
environment; screenshots verify the compositor belongs to that lab. Startup
serializes callers and matches published readiness to the current systemd unit
generation. A live paused-start regression and independent re-review pass.

The lab passed real portal capture with NVENC (183 1080p frames), separate audio,
six matching visual/audio markers and full decode. Constant relative offset was
about 37 ms in this six-second smoke; this is not calibrated device latency or
performance parity. The actual packaged app also passed Record, Pause, source
replacement, Continue, Stop and review, with two fully decodable clips whose
background colors identify the two owned sources. Private typing/Unicode,
Ctrl+A and Alt-Tab pass. No fixture/picker appeared on the host; the owning lab
was stopped afterwards. Evidence: `artifacts/linux-port-2026-10-26/agent-lab/`.
A final background JS run passed 3,100 tests, with 12 platform skips.

The lab shares the host GPU, UID and project filesystem and is not a hostile-code
sandbox. Stock [Niri's nested backend](https://github.com/YaLTeR/niri/blob/8ed0da4/src/backend/mod.rs)
returns no GBM device, which [its screencast path requires](https://github.com/YaLTeR/niri/blob/8ed0da4/src/screencasting/mod.rs).
Nested Niri UI can run invisibly, but media checks use the installed
[KWin virtual backend](https://github.com/KDE/kwin/blob/v6.8.1/src/backends/virtual/virtual_backend.cpp).
Do not report these as exact Niri capture, physical webcam, hotplug or suspend
coverage; visible physical-session checks require explicit authorization.


### Paused cursor grant replacement — October 26

The paused Editable cursor toggle now asks for a replacement ScreenCast grant with
the requested cursor mode. The old grant stays live until the replacement supplies
a usable frame. Cancellation or admission failure preserves the paused source,
cursor mode and kept clips. Only adoption commits the native request, service
configuration and renderer preference. Unchanged Continue remains picker-free;
Stop uses the existing cancellation path outside the serialized helper queue.

This uses the [official ScreenCast contract](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html):
SelectSources is once per session, and cursor mode belongs to that selection. It
does not pretend an in-place reconfigure can change compositor cursor pixels.

Cursor telemetry is retained through paused grant changes, then released after
the terminal snapshot. Independent review caught a cross-recording accumulator
leak; the regression fails before the cleanup correction and passes after it.
Fresh review reports no remaining P1/P2. Focused validation: 317 JS tests, 104 native
tests (one existing ignored, two live filtered), both typechecks, strict Clippy,
formatting and local policy checks pass. React Doctor reports no findings in the
changed slice; its branch-wide scan reports an existing HUD cleanup diagnostic.

Private desktop evidence and final runtime provenance are recorded in
`artifacts/linux-port-2026-10-26/cursor-grant/`. Earlier `b6c90b0a` portable packages
remain historical source-replacement candidates and do not contain this follow-up. The Mac
hardware regression and broader platform/performance gates above remain open.

Final production-bundle lab pass: two consecutive recordings in one Electron
process produced four fully decoded clips. The second recording changed
editable → system → editable across three clips, retaining the same helper PID
and the first finalized clip hash. The stationary cursor region contained up to
48 white cursor pixels in the system clip and zero in the editable clip; its
editable cursor sidecar contains a matching sprite and bounded samples. Both
recordings have independent telemetry origins. A single full JS run passes
3,105 tests with 12 platform skips. The lab was stopped after verification.

All four Ubuntu-floor formats now contain runtime `fcf6b7dd`; immutable private
inventory: `release/linux-port-20261026-fcf6b7dd/`. Strict normal/extracted package
policy and clean Ubuntu/Arch/Fedora loaders pass (27 ELFs, three executables).
The exact normal-FUSE AppImage passes system → editable cursor replacement:
1,290 and 813 fully decoded frames, preserved acknowledged first-clip hash, same
helper PID, 48 versus zero white cursor pixels in the tested region, and 358
bounded editable samples with a resolved sprite. Bundled helper SHA-256:
`7aabc4a2c18bde4e7765cf8e399dc0902cf6b2f2c1aaa6fd78635e1d5b859c54`.
An initial proof sampled before Pause acknowledgement; its hash assertion was
invalid. The repeat waits for the acknowledged Resume control before hashing.
Both lab and build container are stopped. No further full suite was run for
this package/documentation verification.


### Explicit microphone target loss — October 26

Private graph testing found a real device-selection failure: after the selected
440 Hz microphone disappeared, PipeWire silently linked its capture stream to
the 880 Hz default microphone. Existing label-to-node resolution was correct;
the session manager's fallback/reconnection policy changed the actual source.

Explicit targets now set `node.dont-fallback` and `node.dont-reconnect`. Untargeted
default capture keeps its existing policy. Rust reports an unexpected
`unconnected` state as an audio failure even when PipeWire supplies no error
string, while an atomic stopping marker suppresses normal teardown. The callback
regression fails before the correction and passes after it, including native
error preservation. No C ABI, dependencies or shared public API changed.

The private 48 kHz stereo PCM probe uses the actual helper C archive. Before:
440/880/880 Hz at 1/5/7 seconds after selecting A and removing it at three seconds.
After: 440 Hz, then no new PCM; the stream reports target failure at about 3.03
seconds. Default capture still yields 440/880/880 Hz. The production Electron
HUD selected the real private Chromium device `LabMicrophoneA`, resolved it to
`lab_mic_source_a`, recorded two clips, and opened interruption review on loss.
Both screens and microphone originals fully decode, measured microphone windows
contain only 440 Hz, and committed files retain their pre-failure hashes. The
partial tail remains provisional until review probes it; review shows 57 seconds
and two clips. This resource-capped run reports drops and is not a performance
or physical-device timing benchmark. Lab stopped after verification.

Checks: 105 native tests pass (one existing ignored, two live filtered), 168
affected JS tests pass, strict Clippy/formatting/lint pass, independent review
reports no introduced P1/P2. No full JS suite rerun for this native-only slice.
Evidence: `artifacts/linux-port-2026-10-26/audio-target-loss/`. The fcf6b7dd
portable candidates predate this correction; rebuild verification follows.

Contracts: [PipeWire target and reconnection properties](https://docs.pipewire.org/page_man_pipewire-props_7.html),
[stream target identity](https://docs.pipewire.org/group__pw__stream.html), and
[WirePlumber 0.5.18 policy](https://raw.githubusercontent.com/PipeWire/wireplumber/0.5.18/src/scripts/linking/prepare-link.lua).
[WirePlumber 0.4.8](https://raw.githubusercontent.com/PipeWire/wireplumber/0.4.8/src/scripts/policy-node.lua)
recognizes no-reconnect after a first link but lacks no-fallback handling. Its
initial target-disappearance race is not proven safe by this current-host pass
and remains an older-session-manager integration gate.

The new portable runtime is `aeae26ec` (fix `17fadc25`, probe formatting follow-up).
All four Ubuntu-floor formats pass strict policy; extracted AppImage policy and
clean Ubuntu/Arch/Fedora loaders pass (27 ELFs, three executables). The exact
normal-FUSE AppImage selects A through the real device list, commits one clip,
continues, loses A and opens interruption review with seven seconds / two clips.
All four screen/microphone sources fully decode; microphone windows contain only
440 Hz and committed sources retain their hashes. Bundled helper SHA-256:
`5008f7f29e78b9a542cfa44123f31c27701e297a3d708f9b521d65415ef18567`.
Inventory: `release/linux-port-20261026-aeae26ec/`. Both lab and build container
are stopped. Subsequent local checks should cover paused microphone loss and
reconfiguration as well as the older-session-manager initial-link race; this
active-capture test does not establish those paths.

### Recoverable paused microphone loss — October 26

An acknowledged Pause has already committed its clip. Losing an input while
paused now preserves that take and portal, emits a warning, and lets Continue
retry or the user choose another microphone or disable it. Active-recording
loss still follows fatal recovery. A missing input rejects Continue with the
existing correlated `clip-resume-rejected` contract; it does not start a writer
or end the take.

Replacement audio opens on a worker. Its two-second preparation deadline starts
before opening, and acknowledgment requires PCM from every requested stream
(valid silence counts). Failed or cancelled candidates cannot replace active
configuration. Stop cancels pending preparation before joining shared command
serialization; queued Continue and delayed permission completion cannot start a
new clip after Stop. Ready candidates yield to queued Cancel/Stop. Registry
enumeration has a one-second timer and core-error exit, so a stalled daemon
cannot hold the command loop indefinitely. Session transfer retains boxed
callback addresses; teardown stops and joins the owned PipeWire thread before
freeing callback state.

The private native pass produces four fully decodable clips: microphone A,
restored A after two rejected attempts, microphone B, then video without audio.
Measured originals contain 440/440/880 Hz. One helper/portal survives throughout,
and committed first-clip hashes remain unchanged. Freezing only the private
daemon makes enumeration fail at 1.002 seconds; Cancel/Stop exits the helper in
22.92 ms while the daemon is still frozen, preserving one clip and creating no
tail. The daemon is always resumed. These bounded native tests do not establish
renderer, physical-device or long-run timing parity.

115 native tests, 173 affected JS tests, both typechecks, strict Clippy and lint
pass. One final full JS run passes 3,110 tests with 12 existing platform/opt-in
skips. Fresh native control-flow and ownership reviews pass. Evidence:
`artifacts/linux-port-2026-10-26/paused-audio/`. Portable packages and the actual
Electron pass are recorded below; `aeae26ec` packages predate this slice.

Contracts: [PipeWire thread-loop ownership](https://docs.pipewire.org/group__pw__thread__loop.html),
[loop timer/update/destroy API](https://docs.pipewire.org/group__pw__loop.html),
and [explicit-target policy](https://docs.pipewire.org/page_man_pipewire-props_7.html).

Runtime `81805667` now builds all four Ubuntu-floor formats, with strict normal
and extracted AppImage policy and clean Ubuntu/Arch/Fedora loaders passing
(27 ELFs, three executables). Inventory: `release/linux-port-20261026-81805667/`.
The exact normal-FUSE AppImage passes paused microphone loss, rejected Continue
without leaving the take, restored-input retry, unchanged Pause/Continue,
real settings selection of B, and Stop/review. Its four clips total 1:42; all
eight screen/microphone files fully decode, originals measure 440/440/440/880 Hz,
and the first committed source hashes remain unchanged. The mounted helper
matches the floor build at SHA-256
`4ea2dd0f8de78ef72ee090ab592e15551838d3ebecc414add86feb26f5e54dd3`.
Review plays the owned fixture. Lab and build container stopped. This run
reports 40 superseded frames and does not establish performance parity. The
generic rejected-Continue toast still suggests Stop despite recoverable retry;
correct that copy in a follow-up.

### Recoverable Continue guidance — October 26

When the shared service explicitly returns `paused: true` on a rejected
Continue, the renderer now says “Still paused. Check settings and try Continue
again.” The existing fatal-failure instruction stays separate. All 13 locale
files carry the new key. A regression fails on the old instruction and verifies
that the take stays paused without Stop, then successfully retries. The affected
hook suite passes 53 tests; both typechecks, i18n validation and touched-file
Biome pass. React Doctor reports no findings for this slice against HEAD; its
branch-wide existing HUD effect diagnostic is outside the change. No native
helper change or new packaged verification yet.

Reference: [W3C error suggestion guidance](https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html):
provide a known corrective action when an input is rejected.
