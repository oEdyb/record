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
- Strict helper Clippy remains blocked by eight diagnostics in generated FFmpeg
  bindings (acronym/type complexity/transmute); no new owned-source diagnostics,
  generated-file edits or lint suppression were added.
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
  Camera WebM streams are attached after drain; a hard crash or quit timeout can
  leave an unfinished/unassociated camera sidecar. Native screen/audio journaling
  does not repair such an unregistered camera file.
- 30/60-minute endurance, sample-clock A/V drift, AMD/Intel encode hardware and other
  desktop portal backends remain unverified. The five-minute NVIDIA result and
  short export benchmark cannot establish Mac-equivalent performance universally.
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
- A portable AppImage/deb/pacman/rpm build on the pinned CI runner has not been
  validated here. Do not publish the host-mode development artifact as a release.

Additional primary contracts used:
[PipeWire DMA-BUF negotiation](https://docs.pipewire.org/page_dma_buf.html),
[kernel DMA-BUF layouts](https://docs.kernel.org/userspace-api/dma-buf-alloc-exchange.html),
[niri screencasting](https://niri-wm.github.io/niri/Screencasting.html),
[Electron 44 global shortcuts](https://raw.githubusercontent.com/electron/electron/v44.9.1/docs/api/global-shortcut.md),
[Electron 44 BrowserWindow](https://raw.githubusercontent.com/electron/electron/v44.9.1/docs/api/browser-window.md).
