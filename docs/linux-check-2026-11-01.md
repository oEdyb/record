# Linux Studio verification — November 1, 2026

Tested base: `origin/feat/studio-mac`,
`c7de7141df6d2486e60fcb8eda2aea804fed9a89` (all ten commits after the
October 31 Linux check). Fresh worktree:
`/home/olle/dev/klippt-linux-check-1101`, branch `fix/linux-check-1101`.
Linux handoff fix: `6fbb45ae` — Keep Linux Studio handoffs instant without opacity calls.
No installation, release, merge or changes to another checkout.

## Numbered checks

1. **PASS — native rebuild, preview publication and recovery.** Rebuilt with
   `node scripts/build-linux-compositor-addon.mjs` and
   `npm run build:native:linux`. The addon has no unprefixed FFmpeg imports;
   `ldd` resolves all six staged FFmpeg libraries. An actual addon probe publishes
   nothing before screen decode, publishes generation 1 after transport sync,
   survives an unavailable video overlay and publishes generation 3 after that
   overlay is removed. The actual Studio/review preview and native export work.
   The missing-overlay path handles its error internally; this does **not** force
   the exact `paused recompose failed` catch branch. That branch remains a code
   inspection result, not fault-injection evidence.

2. **PASS after fix — instant Studio/pill handoff.** On the base, disabling
   animation still called `setOpacity`; the controller also reset opacity directly.
   `WindowFade` now completes immediately on Linux and centralizes opacity resets
   behind the platform guard. A regression covers motion both enabled and disabled,
   Studio open and native close, visibility, zero timers and zero opacity calls.
   Mac animation tests explicitly pin Darwin and still pass. Built-app Open Studio
   → Switch to pill → Open Studio and Finish passed. Main-process instrumentation
   recorded **zero `setOpacity` calls** throughout the GUI run.

3. **PASS — real recording revealed and bounded cover.** In the built app, an
   owned animated fixture was selected through the real private KDE portal.
   Studio Record → Pause → Continue → Stop → Finish produced two clips:
   **5.966 s + 5.150 s = 11.116 s**. System audio was enabled; microphone and
   camera were disabled. Seventeen renderer screencast frames were captured
   around Finish, including prewarm. Inspected transition frames show the actual
   fixture underneath the fading cover; no wallpaper-only reveal was observed.
   The first captured post-Finish window frame was covered at about 1.637 s;
   recording pixels were already visible under the cover by 1.646 s.
   A focused fake-clock probe of the real review component, with video ready and
   no settled native frame, keeps the cover at 1,499 ms and releases it at 1,500 ms.
   This is the screen-paint fallback; missing HTML-video readiness has its separate
   existing 6-second fallback. Direct pill Stop without Studio Finish was not
   separately recorded in this run.

4. **PASS for Linux native dragging; dock transition not applicable to its UI.**
   Private compositor input dragged the real pill from window position
   **(724, 283) to (976, 428)**. Linux deliberately uses a native drag region and
   disables folding/edge docking (`canMinimize = !isLinuxHud`). Therefore a native
   Linux dock-to-free transition cannot be reached through this product UI.
   The existing shared regression, “keeps dragging a top pill after the drag pulls
   it off its edge”, passes and verifies continued window-level moves after grip
   capture is lost, followed by one drag-end. No physical Niri drag was tested.

5. **PASS — named mic listing, focus cleanup and CSS contract.** A synthetic
   `LinuxCheckMic` was created only in the private PipeWire graph. Named device
   enumeration and a `devicechange` reload made **zero `getUserMedia` calls**.
   The existing unnamed-device permission/track-stop regression also passes.
   Focusing Open Studio and hiding the pill changes its active element to `BODY`.
   In a forced DOM style state, both top-dock wings settle to opacity 0,
   visibility hidden and pointer-events none. This verifies the actual stylesheet;
   top docking is disabled in the native Linux UI, so no natural tuck animation
   was observed there. Physical microphone/camera recording was not validated.

## Gates

- **PASS** `npx tsc --noEmit`, including final fixed source.
- **PASS** `npx tsc -p tsconfig.test.json --noEmit`, including final fixed tests.
- **PASS** `npm run lint`; one existing oversized
  `third-party-licenses/Cargo-Evidence.json` warning, no errors.
- **PASS** `npm run build-vite`; built app launched from this worktree's
  `dist-electron/bootstrap.js`, using Electron 44.9.1.
- **PASS** `cargo test --locked` in `crates/compositor`:
  **264 passed, 0 failed, 1 ignored** across test binaries; run once.
- **PASS** `cargo clippy --all-targets --locked` in `crates/compositor`:
  exit 0; existing warnings remain (82 in lib-test); run once.
- **FAIL, only the eight supplied known failures** `npm run test`:
  run **once** on the fixed code, **3,334 passed, 8 failed, 12 skipped**;
  323 files passed, 3 failed, 5 skipped. No additional failure or missing-ffprobe
  failure. No existing test was weakened or skipped.
- **PASS** focused tests: 177 across fade/controller, settled-frame identity,
  microphone devices and launcher; 13 review-shell tests; one additional local
  1,500 ms fallback probe. `git diff --check` passes.

Full-suite failing lines only:

```text
FAIL scripts/check-approved-dependencies.test.mjs > approved dependency inputs > matches every current npm, Cargo, CMake, Swift, FFmpeg, and model input
FAIL scripts/check-cargo-graphs.test.mjs > Cargo graph policy > covers every independent Cargo lockfile in the repository
FAIL scripts/check-cargo-graphs.test.mjs > Cargo graph policy > renders advisory exceptions only for their owning graph
FAIL scripts/generate-release-inventory.test.mjs > release inventory > rejects a source label that is not an exact commit
FAIL scripts/generate-release-inventory.test.mjs > release inventory > creates a deterministic, valid CycloneDX 1.7 SBOM with every source family
FAIL scripts/generate-release-inventory.test.mjs > release inventory > rejects a native staging symlink that escapes the packaged tree
FAIL scripts/generate-release-inventory.test.mjs > release inventory > hashes the complete packaged payload and final distribution artifacts
FAIL scripts/generate-release-inventory.test.mjs > release inventory > verifies and inventories the source-bound native helper manifest
```

## Export and build environment

Real GUI Save video → One video → native save dialog completed with **Video saved**.
`ffprobe -count_frames` reports **1920×1080 H.264, 60 fps, 667 decoded frames,
11.116016 s video/MP4**, plus **AAC, 11.116000 s**. That matches the 11.116-second
committed take within timestamp quantization. Both screen originals, both isolated
system-audio originals and the export fully decode with `ffmpeg -xerror`:
**5 files, exit 0**. The fixture was not armed for audible markers; this is not
audio level, sync or spoken-quality evidence. Capture selected NVENC; native
preview reported the RTX 4070 Vulkan hardware backend.

Environment follows the previous reports: CachyOS x86-64, RTX 4070, private
KWin/Wayland/PipeWire lab `linux-check-1101`.
`FFMPEG_DIR` is the ignored worktree symlink to
`/home/olle/dev/screenrec-linux/crates/thirdparty/ffmpeg-linux64-lgpl-shared`;
`LIBCLANG_PATH=/usr/lib`,
`PATCHELF=/home/olle/.local/share/klippt-tools/patchelf-0.19.2/bin/patchelf`,
Rust tests use `LD_LIBRARY_PATH=$FFMPEG_DIR/lib`. Dependencies use an ignored
node_modules symlink. The existing pinned ffmpeg was copied into this worktree's
ignored native-bin directory and its adjacent ffprobe was staged before tests.
Initial typechecks/lint and native script entrypoints used host Node 24.22.1;
final build/typechecks, full npm suite and GUI harness used pinned Node 22.22.1.

Final staged SHA-256:

```text
f57b57ed41c66f6742d25e9944188579fab0afd82af322468c439008090a5782  openscreen-pipewire-helper
beb85015c86f22b73f41809eaebd04fee0a314a902d97bbeb849a65ed1c66742  klippt-parakeet-stt
c8e8670e70518b956f271df528329d2871f2edc9f97a65accfcd83356297e405  compositor_view.node
```

Opacity/visibility API contract checked against the
[Electron 44.9.1 BrowserWindow documentation](https://raw.githubusercontent.com/electron/electron/v44.9.1/docs/api/browser-window.md).
The Linux no-opacity requirement is enforced independently of the motion preference.

## Cleanup and limits

All input, native dialogs and audio graph changes stayed inside the private lab.
The host desktop, input, focus, clipboard and speakers were not driven. The lab
is stopped; its temporary synthetic source ended with it. Test recordings, export,
captured image frames/screenshots and the isolated app profile were deleted.
Local logs, hashes, JSON evidence and harnesses remain in
`artifacts/linux-check-1101/`, including `media-verification.json`,
`export-ffprobe.json`, `frame-analysis.json`, `mic-probe.json`, `recompose.json`
and `cleanup.json`. Recording paths in those files are historical after cleanup.

Not verified: physical Niri capture/dragging, real microphone/camera quality or
timing, multi-monitor behavior, other desktops/GPUs, packaging, installed-app
behavior or Mac hardware. Settings enumeration saw the host webcam label; this
does not establish real-device acceptance. The exact paused-recompose error
catch, direct pill-Stop reveal and a natural Linux top-dock transition have the
specific limits above. No nested delegation was used.
