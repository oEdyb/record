# OpenScreen compositor fix ports — October 31, 2026

Scope: sweep items 6, 7, 8, 11, 12, 17, 18, 19, 20, and 21 from
[the upstream sweep](openscreen-upstream-sweep-2026-10-31.md).
Sources are the MIT OpenScreen PR diffs, read with `gh pr diff N -R getopenscreen/openscreen`.
No Recordly source was used. No persisted project schema changes.

## Ports

- **6 — DONE:** [#1377](https://github.com/getopenscreen/openscreen/pull/1377),
  [#1379](https://github.com/getopenscreen/openscreen/pull/1379).
  `timeline_walk.rs`: unreadable screen/camera opens, absent start frames, distant
  interior seek results, and lost frames abort with clip context. Preserve first-frame
  hold for a stream whose actual first PTS is later than the requested start.
  Existing Mac decoder already retains a seek's last valid frame at EOF.
  Regression: missing-screen/camera export test and clip-start acceptance tests.
  Generated-media validation also exposed an unknown final VideoToolbox packet
  duration. Set one encoder tick for unknown CFR packet duration before rescaling;
  H.264 and HEVC now decode all 120 reported output frames instead of 119.
  The pinned FFmpeg `libavcodec/packet.h` defines zero duration as unknown.
  This ports the requested source-read failure behavior, not upstream's separate
  staged-output publication machinery (Klippt already owns publication externally).
- **7 — DONE:** [#1418](https://github.com/getopenscreen/openscreen/pull/1418).
  Mac/Linux available duration covers the longer of video stream and container;
  a static screen's last frame can cover a later clip start within that duration.
  Camera tail acceptance remains bounded to half a second.
  Regression: one-frame duration, unknown-duration fallbacks, and bounded/unbounded holds.
- **8 — DONE:** [#371](https://github.com/getopenscreen/openscreen/pull/371).
  `audio.rs` uses LGPL libavfilter atempo with bounded stage count, priming and
  measured-length correction, falling back to WSOLA on filter failure. WSOLA
  discards through an amortized read head. `audio_spool.rs` uses the same graph
  through block readers/writers, preserving disk-backed export and cancellation.
  Linux staging includes libavfilter; Mac staging already discovers linked dylibs.
  Regression: speed presets, pitch, silent tails, fallback, exact lengths, spool parity.
- **11 — DONE:** [#1408](https://github.com/getopenscreen/openscreen/pull/1408).
  `compositor_macos.rs` creates R16/RG16 views for P010; UV texture swizzles carry
  full-range metadata into the shared Metal shader.
  Regression: actual CoreVideo buffers for 420v/420f/x420/xf20 with Metal views.
- **12 — DONE:** [#1421](https://github.com/getopenscreen/openscreen/pull/1421).
  `shaders.metal` uses each frame's BT.601/709/2020 NCL tag. Texture swizzles carry
  matrix/depth metadata; software carriers preserve colorspace. Untagged/2020 CL
  frames retain upstream's BT.709 fallback; this is not HDR tone mapping.
  Regression: matrix/depth swizzles and shader compilation in compositor tests.
- **17 — DONE:** [#551](https://github.com/getopenscreen/openscreen/pull/551).
  `linux_decode.rs` rewinds and pumps again if an indexed seek yields no frame.
  Reuses Klippt's existing draining/error-safe sequential pump rather than the
  older upstream packet loop. Regression: committed VFR/fragmented EOF fixtures.
- **18 — DONE:** [#1163](https://github.com/getopenscreen/openscreen/pull/1163).
  `regions.rs` and `timeline_walk.rs` share one continuous output grid across
  speed spans and clip boundaries. Mac MP4 index reservation uses the same grid.
  Regression: 200-window cumulative rounding and 2445-frame cut-up timeline.
- **19 — DONE:** [#575](https://github.com/getopenscreen/openscreen/pull/575).
  `pipeline_linux.rs` sets two-second GOPs; OpenH264 gets explicit QP 1–51 and
  High profile without frame skipping. Requested bitrate is not a hard cap.
  Linux-only tests inspect periodic keyframes, context QP, and SPS profile.
- **20 — DONE:** [#566](https://github.com/getopenscreen/openscreen/pull/566).
  `cursor.rs` resets null, omitted, and empty cursor type to arrow.
  Regression: independent pointer → null and pointer → omitted transitions.
- **21 — DONE:** [#537](https://github.com/getopenscreen/openscreen/pull/537).
  Mac/Linux background/sprite caches use a 512 MiB LRU budget and protect textures
  already used in the current frame. An active set larger than the budget can
  exceed it; inactive entries are evictable. Regression: shared byte-budget policy,
  oldest-first eviction, stopping at budget, and active-set protection.

## Validation limits

The Rust suite uses `MAC_FFMPEG_DIR=/opt/homebrew/opt/ffmpeg cargo test` from
`crates/compositor`. This validates the locally installed FFmpeg, not the packaged pin.
Mac tests also compile and execute the pure FFmpeg Linux decoder through test cfg.
No Linux Rust target/sysroot is installed, so Vulkan composition, Linux pipeline,
OpenH264 encoder tests, and Linux library staging were not compiled/run here.
No TypeScript changed. No installed app was replaced or controlled.

Before release, run on the PC: full crate tests with the packaged LGPL FFmpeg,
forced OpenH264 GOP/QP/SPS tests, VFR/fragmented EOF seeks, static-screen/audio export,
reordered/missing/truncated source failures, many speed spans with final audio/video
length agreement, wallpaper/sprite cycling and memory behavior, packaged addon loading.
On Mac, record and export real screen/camera media, static screen plus long audio,
10-bit limited/full-range clips and BT.601/709/2020 color charts; compare preview and
encoded pixels, source coverage, pitch and audio tails. No real desktop recording
or end-to-end color-chart export was performed in this task.

## Gate results

- `MAC_FFMPEG_DIR=/opt/homebrew/opt/ffmpeg OPENSCREEN_TEST_MEDIA=/tmp/klippt-compositor-media cargo test`
  from `crates/compositor`: **271 passed, 0 failed, 4 ignored**.
  Generated four-color screen/gray-camera media enabled all five export timing tests:
  H.264/HEVC frame counts, GIF source coverage, cancellation, reordered-source audio.
- `cargo build --manifest-path crates/Cargo.toml -p compositor-view-napi` with the
  same FFmpeg: passed; staged only the debug addon in this worktree for npm tests.
- `OPENSCREEN_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg npm run test`: **3287 passed, 8 failed, 5 skipped**.
  The eight failures are the known stale dependency/Cargo-graph/release-inventory
  policy tests; no additional failures. Initial local missing-addon failures were
  resolved by building the addon, without changing those tests.
- `node --check scripts/build-linux-compositor-addon.mjs`, `node scripts/check-docs.mjs`,
  and `git diff --check`: passed.
- TypeScript gates not applicable: no `.ts` or `.tsx` edits.

The first npm attempt lacked dependencies. `npm ci --ignore-scripts` and
`npm rebuild electron` supplied local test prerequisites without running the app.
An initial generated-media export check caught the final-packet loss above; it was
fixed and the entire Rust suite rerun with that media enabled.
