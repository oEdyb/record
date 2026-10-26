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
- Unchanged Continue reuses one portal session. A paused source or portal-fixed
  cursor-mode change is rejected visibly and retryably; source replacement needs
  another portal session. Wayland has no portable own-window exclusion.
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
all were corrected, with a final fresh review pending. Native helper tests: 92 pass,
one existing live test ignored; strict Clippy and formatting pass.
The C ABI review passed 13 runtime-version cases and protected-page tests with
24-byte/32-byte older buffers plus current 64-bit timestamps.

A live NVENC capture deliberately stopped the helper for 500 ms. Video and source
AAC remained about 7.09/7.08 seconds, fully decodable; pulse-to-flash offsets before
and after the stall stayed within one output frame. Missing captured content during
the stall remains missing; its time is preserved as silence/held video. This first
live pass preceded the jitter refinement. Evidence and binary provenance are under
`artifacts/linux-port-2026-10-26/audio-cycle-time/`. Updated package generation is
pending final review and checks; the immutable `d7b0dafc` candidate above does not
contain this follow-up.


A regressing capture-cycle clock is now rejected before admitting its PCM. The
cycle uses PipeWire's monotonic clock; guessing a new epoch could reorder queued
originals or compress an outage while the compatibility mix looked correct. That
condition therefore follows the existing visible writer-failure/recovery path,
while ordinary forward-clock outages and post-Continue delays recover automatically.
An integration regression verifies the error, rejects the bad clip, retains the
previous committed clip and fully decodes its original. Pause clears the failed
clock state for a new clip. This supersedes the initial attempted backward-clock
reanchor behavior; no source timing recovery from an invalid backward clock is claimed.
