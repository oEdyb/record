# Merged Studio Linux verification — October 31, 2026

Base: `origin/feat/studio-mac`, `37db2c5cdc1173cec76259d5f64bb4bac4564e17`.
Fresh worktree: `/home/olle/dev/klippt-merged-check`.
Fix branch: `fix/linux-merged-check`. No merge, installation or release.

## 1. PASS — native rebuild and Rust gates

- `npm run build:native:linux`: rebuilt and staged the PipeWire capture and
  Parakeet helpers from this worktree.
- `node scripts/build-linux-compositor-addon.mjs`: rebuilt and staged the Linux
  addon, including all six renamed FFmpeg libraries and `libavfilter.so.11`.
  The script verified no unprefixed FFmpeg imports. `ldd` resolves the staged
  libraries; the actual Electron preview and export loaded this addon.
- `cargo test --locked` in `crates/compositor`, final source: **264 passed,
  0 failed, 1 ignored** across unit and integration binaries.
- `cargo clippy --all-targets --locked` in `crates/compositor`: exit 0 after
  fixing the denied lint below. Existing warnings remain (82 in the lib-test
  build, including generated FFI warnings); this is not a warnings-free claim.
- PipeWire crate `cargo test --locked`: **128 passed, 0 failed, 1 ignored**.
  `cargo clippy --all-targets --locked -- -D warnings`: exit 0.
- Forced `OPENSCREEN_EXPORT_ENCODER=libopenh264` Linux export regression:
  **3 passed**. The real OpenH264 GOP/QP/SPS tests also pass; encoder output in
  the logs confirms the codec opened rather than taking its unavailable skip.

Build environment: CachyOS x86-64, RTX 4070, private KWin/PipeWire lab.
`FFMPEG_DIR` points to this worktree's ignored symlink to the existing pinned
LGPL shared SDK at
`/home/olle/dev/screenrec-linux/crates/thirdparty/ffmpeg-linux64-lgpl-shared`.
`LIBCLANG_PATH=/usr/lib`; the addon build also used
`PATCHELF=/home/olle/.local/share/klippt-tools/patchelf-0.19.2/bin/patchelf`.
Rust tests used `LD_LIBRARY_PATH=$FFMPEG_DIR/lib`.
Local npm dependencies were reused through an ignored node_modules symlink.

Final staged SHA-256:

```text
1089c6931ffce530fabae57f9756602364cd9d66f446eff33703249da97dc176  openscreen-pipewire-helper
beb85015c86f22b73f41809eaebd04fee0a314a902d97bbeb849a65ed1c66742  klippt-parakeet-stt
829536a4c127e4922aad5ef8c20702f650b4161e1ce3c90d2381c52b648062e9  compositor_view.node
```

## 2. PASS — failures fixed without changing Mac runtime behavior

- `crates/compositor/src/frame_geometry.rs:1605`: replace the golden test's
  `1920.0 / 1920.0` with `1.0`, preserving its value while removing the denied
  Clippy `eq_op` error. All 34 affected geometry tests pass.
- `crates/compositor/src/pipeline_linux.rs:668`: supply one CFR encoder tick
  when packet duration is unknown, before timestamp rescaling. The pinned
  `libavcodec/packet.h` defines zero packet duration as unknown. The Linux
  encoder uses a `1/fps` time base. This is the same policy already present in
  the Mac path; no Mac runtime file changed.
- `crates/compositor/tests/linux_export_camera_tail.rs:85`: exercise a size
  accepted by NVENC and count actual decoded frames, including the existing
  short-camera cases. Before the fix: **119 decoded / 120 encoded**, test fails.
  After the fix: **120 / 120**, test passes. Forced OpenH264 also passes.

No Linux compilation errors were found in the merged GOP/OpenH264 policy,
EOF rewind/container-duration or texture-cache eviction paths. Their existing
Linux/shared regressions pass unchanged. Cache tests cover oldest-first
eviction, stopping at budget and protecting the active frame's textures; this
was not a GPU memory soak.

## 3. PASS — real Studio take, One video and still-window startup

All capture, native picker input, test tones and UI interaction stayed inside
`agent-lab merged-check`. No host pointer, focus, clipboard or physical audio
device was driven. Development app: this worktree's built
`dist-electron/bootstrap.js`, Electron 44.9.1. Capture used the rebuilt helper;
final preview/export used the rebuilt addon in a fresh Electron process.

Studio: Record → Pause → Continue → Stop → Finish. Review loaded two clips,
**10.950 s + 10.150 s = 21.100 s**. System audio enabled; camera/mic disabled.
The native picker selected the owned animated fixture window. Save video →
One video → native save dialog completed and displayed **Video saved**.

Final ffprobe/full-decode results:

- **1920×1080 H.264, 60 fps, 1,266 decoded frames, video duration 21.100000 s**.
- **AAC LC audio duration 21.100000 s; MP4 duration 21.100000 s**.
- Duration error against Studio's committed take: **0 frames**.
- **11 keyframes at 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20 s**: GOP 120 frames.
  No discard-flagged video packet remains.
- Export audio mean **−23.4 dB**, peak **−10.3 dB**; no speaker playback used.
- Both original screens, both system-audio originals, the pre-fix and final
  exports, and the still-window clip fully decode with `ffmpeg -xerror`:
  **7 files, exit 0**.

Before the packet fix, the same GUI export had 1,266 packets but only **1,265
decoded frames**, video duration **21.083008 s**, and a discard-flagged final
sample. The final GUI export above closes that regression.

The separate native still-window take used the same rebuilt capture helper
and an owned unanimated window. It started without a repaint, recorded
**960×676, 93 decoded H.264 frames / 3.100000 s**, and its first frame was
visually inspected. The missing-crop warning arrived **539 ms after stream
start**; that interval includes scheduling and is not an exact first-buffer
measurement. CropWait unit tests pin the **500 ms** held-frame deadline and
release with no second frame.

One test-process SIGSEGV occurred while the build script overwrote its loaded
addon/libraries in place (addon rewritten 19:02:34, crash 19:02:36). The first
process was therefore invalid for subsequent testing. Final verification used
a cold process after the build; reopening the take and GUI export passed.
This does not establish a fix for the earlier unrelated GLib crash documented
in the Studio Linux report.

## 4. PASS typechecks; FAIL full npm suite only on supplied known failures

- `npx tsc --noEmit`: exit 0.
- `npx tsc -p tsconfig.test.json --noEmit`: exit 0.
- `npm run build-vite`: exit 0.
- `npm run test`: run **once**, **3,316 passed, 8 failed, 12 skipped**;
  320 test files passed, 3 failed, 5 skipped.
- Failures: `scripts/check-approved-dependencies.test.mjs` (1),
  `scripts/check-cargo-graphs.test.mjs` (2),
  `scripts/generate-release-inventory.test.mjs` (5), matching the supplied
  pre-existing failures. No missing-ffprobe failure occurred: the ignored
  native-bin directory had the existing pinned ffmpeg and a system ffprobe
  symlink staged before the full run. No test was weakened or skipped.
- Final changed test file rustfmt check and `git diff --check`: exit 0.

The npm run preceded the Linux-only packet fix. Final full Rust tests, Clippy,
forced OpenH264 export tests and the actual GUI export cover the changed code;
the npm suite was not repeated.

## Cleanup and limits

All test media, extracted frames, temporary screenshots and the isolated app
profile were deleted; the owned lab is stopped. Local JSON evidence, harnesses
and gate logs remain under `artifacts/linux-merged-check/`, notably
`media-verification.json`, `studio-take.json` and `cleanup.json`.
Installed Klippt and other checkouts were not modified.

This verifies Linux compilation and a private KWin workflow on the Niri host.
It does not verify physical Niri capture, physical devices, Mac hardware,
multi-monitor behavior, other GPUs/desktops, portable packaging or release
readiness. No subagents were started.
