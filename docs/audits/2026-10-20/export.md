# Export, review playback and preview audit and fixes (2026-10-20)

Read-only audit of `electron/export`, `crates/compositor`, `crates/compositor-view-napi`, the
bundled FFmpeg 8.1.2 LGPL build, the One video and Separate takes flows, and the review screen in
`src/`. Nothing was edited, built or launched. Measurements below used the bundled
`crates/thirdparty/ffmpeg-n8.1.2-macos64-lgpl-shared/bin/ffmpeg` on this Apple M5, on
`artifacts/agent-proof-2026-09-07/proof.mp4` (2560×1440, 60 fps, 24 s), plus `ffprobe` of real
takes in `~/Library/Application Support/openscreen/recordings` (read only).

The prior work in HANDOFF.md still holds and is not repeated: async VT decode (77 → 207 fps),
one-frame-late Metal wait, murmur3 packet proof, and `-moov_size` on the copy path.

Confidence labels: **High** = read in code and/or measured here. **Medium** = code is clear, the
size of the effect is estimated. **Low** = plausible, needs a measurement first.

## Fix results (branch `fix/export`, 2026-10-20)

Measured on this M5 (macOS 26.6.2) from copies of library takes in a scratch folder. "Main" is
commit `44cb0ee62`. An unrelated `xcodebuild` UI test ran during most runs, so render numbers
are the mean of two alternating main/branch runs. Every path used **decoder**
`videotoolbox-async(inflight=4)`, **compositor** `metal`, **encoder** `h264_videotoolbox`
(hardware) unless it says stream copy.

**One video, 40-minute take with 7 pauses** (8 takes, 3420×2214, 18.7 GB):
- Main renders it: **3333 s** (55.5 min), 43.4 fps, 22.9 GB.
- Branch joins the takes by packet copy: **63 s**, 18.6 GB, `packet-concat` + `stream-copy/h264`.
  Read-back proof passed. Audio start matches the source (same 2112-sample priming).
- Of the first 498 s attempt, 263 s was FFmpeg's own AAC encoder. AudioToolbox `aac_at`
  (in the bundled LGPL build) does the same track in 40 s. `aac_at` tops out at 320 kb/s
  stereo; the sources are 250 kb/s.

**One video, single take copy** (12.6 min, 6.2 GB): main **31.3 s** → branch **24.4 s** with a warm
cache (43.6 → 32.1 s on first runs). Preparation 4.9-9.3 s → 0.2-0.4 s, because the full read
pass is gone. The 63-minute take was not run: its 34.6 GB output does not fit the free disk.

**Rendered export, 60 s slice with 4K camera** (`mac_export_bench`, scene with camera overlay):

| | Main | Branch |
|---|---|---|
| Source size 3420×2214, 75.9 Mbps target | 61.2 s, 294 MB | 59.5 s, 133 MB |
| 1080p (1668×1080), 11 Mbps target | 25.3 s, 80 MB | 17.3 s, 35 MB |
| Audio tail after video | 6.6-10.1 s | 0.9-2.2 s |
| Index move after writing (`trailer`) | 0.03-0.25 s | 0.01-0.04 s |
| SSIM vs a 300/100 Mbps reference (20 s) | 0.99950 / 0.99857 | 0.99953 / 0.99911 |

The reference uses the branch's keyframe interval, which slightly favours the branch. Files are
smaller because the 1 s keyframe interval stops VideoToolbox spending bits on a keyframe every
12 frames. At source size the video phase did not get faster (53 → 57 s); the gain is audio.

**Per finding:**
1. **Fixed for screen-only takes** (`a174982a3`, `186cd577f`, `6bace37c`). Complete takes split by
   Pause are joined with the concat demuxer (`-auto_convert 0`, byte-identical packets). Camera
   takes still render: measured above at 0.97-1.0× real time at source size, so a 40-minute
   camera take renders in about 40 minutes. Parallel encode is not possible here
   (`RecommendedParallelizationLimit` = 1).
2. **Fixed** (`bbfedfbcb`, `bf4e9edad`). Measured limit is **4096 pixels on either side**, not
   4096×2304: 4096×4096 and 3840×2560 encode, 4098×1080, 1080×4098 and 4352×2048 fail with
   -12903. Larger renders use HEVC. Errors are English. Dead software candidates were left in
   place (they cost nothing when absent).
3. **Fixed** (`39b23442b`). `moov_size` reserved from the real speed-segment frame count, 64 bytes
   per sample. Falls back to `+faststart` above 24 h. Test checks ftyp/moov/mdat and the padding.
4. **Partly fixed** (`bf817eb0`). The audio tail is 4-6× shorter with `aac_at`. Audio still runs
   after video and lands at the end of the file (not interleaved). Not done: the remaining tail is
   1-2 s per minute and the interleave rewrite is 6-10 h.
5. **Not fixed; handoff below.** Needs the app running to measure, which this task did not do.
6. **Fixed** (`81cbc9b35`, `3f5cd156e`). Paused preview loops drop to a 250 ms timer after 30 quiet
   frames and wake on media events, clock changes and edits; the compositor pull loop polls
   from a timer at 10 Hz; the native thread waits on a condition variable (50 ms paused, 4 ms
   playing) and wakes on every command. Unit tests cover the frame counts. CPU use in the
   running app was **not measured**.
7. **Fixed** (`6c7cfad2d`, `186cd577f`). Preflight on the temp volume at output length (speed
   regions included), also for silent takes. Startup sweep removes dead-PID spools and join lists.
8. **Fixed** (`a174982a3`). One fused pass copies and hashes; a second reads the copy back. Space
   is checked before any full read. Timeout scales with size (20 MB/s floor).
9. **Fixed** (`7413c042f`). 1 s keyframe interval. Measured above.
10. **Space check fixed** (`3f9a57cd5`); **cancel not done** (needs UI, handoff below).

Also seen: HEVC now has the zero-copy candidate (`7413c042f`). The encoder errors that can
reach the export dialog are English. The size estimate still assumes the full target bitrate, which now
overstates rendered files by about 2× (handoff below).

**Gates run locally:** `npm run lint` (one existing warning: the size of
`third-party-licenses/Cargo-Evidence.json`), `npx tsc --noEmit`, the test typecheck,
`cargo test -p openscreen-compositor` (234 unit tests plus integration tests),
`export_timing` with generated media (5 pass), `npm run test` (2554 pass; 2 timed out at
load average 170 and pass on rerun: `agentHistory.test.ts`, `atomicExport.test.ts`). Rebuilt
`npm run build:native:compositor:mac` and `npm run build:native:mac`. A fresh-context review of
the disk and file-writing changes found 4 medium and 4 low issues. Fixed: spool check at output
length and for silent takes, index reserve from real frame counts, 64 bytes per sample, join-list
sweep, absolute join paths. The joined-take proof limit is noted below. Not run: the app itself.

**Handoff notes:**
- **audit-ui:** Separate takes to another volume has no Cancel. `copyOriginalFile.ts:22` needs a
  `signal` and the dialog a button. The export dialog's size estimate
  (`compositorViewService.ts` `estimateMp4FileSizeBytes`) now overstates rendered files about 2×.
  If the dialog names the encoder, a render larger than 4096 px a side now says H.264 but encodes HEVC.
- **audit-recording:** capture at 5K/6K backing pixels uses H.264 and will hit the same
  4096-pixel limit (`CaptureSetup.swift` `captureDimensions`). Not tested in capture.
- **Finding 5 (preview double decode):** measure first with `powermetrics` during review playback
  in the app. If Chromium still decodes the hidden `<video>`, move the clock to an audio-only
  element. The `sharedTexture` spike (Electron 44.1) is the longer path.
- **Windows and Linux** render paths still use `+faststart` and FFmpeg's AAC encoder.
- **Joined-take proof:** the read-back proves the file equals what the concat demuxer produced,
  plus per-take duration within 20 ms. A packet dropped at a join without changing duration
  would pass. Counting packets per take needs a full read of each take.

## Top 10 findings, ranked by user impact

### 1. One video re-renders every take that has a pause or a camera

- **Where:** `electron/export/recordingPassthrough.ts:116` (`clips.length !== 1`), `:127` (any
  camera), `electron/native-bridge/services/compositorViewService.ts:829`.
- **What happens:** the 46 s copy path only runs for a single screen-only clip. Each Pause makes a
  new clip file. A real take from October 10 has 4 clips, a 3420×2214 screen and a 3840×2160 camera
  (`recording-1791617720291-*`). That take goes through decode → composite → encode at source size.
- **Impact:** on this M5 the hardware decoder ceiling is about 390 frames/s at 1080p (HANDOFF,
  September 11), about 810 megapixels/s. A 3.4K60 screen plus a 4K30 camera needs about
  700 megapixels/s of decode. Estimate: One video for such a take runs near real time
  (a 40-minute take takes 30-40 minutes), against 46 s for the 63-minute single-clip copy.
  This estimate is **not measured**.
- **Fix:**
  1. Screen-only takes with pauses: add a stream-copy concat path. Same codec, size and
     SPS/PPS per clip (same writer settings), `-f concat -c copy`, then the same packet proof per
     clip and `-moov_size`. PRODUCT_PLAN already asks for "an edit-free remux/concatenate fast
     path". Check the AAC joins for drift against the existing audio concat plan.
  2. Camera takes: measure first (`mac_decode_bench` with a 4K camera clip). If decode-bound, the
     options are parallel segment encode on chips with two media engines (finding 11 list) or a
     smaller camera decode. Do not guess.
- **Effort:** concat path 12-20 h with tests and a real 30/60-minute paused take. Camera
  measurement 2 h.
- **Confidence:** High that these takes render. Medium on the time estimate.

### 2. H.264 export above 4096×2304 fails, with no software fallback

- **Where:** `crates/compositor/src/pipeline_macos.rs:790-830` (candidate list),
  `:975` (French error), `src/components/ai-edition/ExportDialog.tsx:268` (One video forces H.264).
- **Measured:** `h264_videotoolbox` at 5120×2880, 6016×3384 and 7680×4320 fails with
  `Cannot create compression session: -12903`. 4096×2304 works. `hevc_videotoolbox` works at all
  four sizes. The bundled FFmpeg has no `libopenh264` or `libkvazaar` (`ffmpeg -encoders`), so
  the listed software fallbacks never exist.
- **Impact:** a One video render (any pause or camera, finding 1) of a 5K Studio Display or 6K
  Pro Display XDR capture at native pixels fails at encoder open with
  "aucun encodeur vidéo utilisable sur cette machine". Whether capture itself works at 5K is
  for the recording audit (note left in the shared notes folder).
- **Fix:** choose HEVC automatically when the output exceeds the H.264 limit, or cap H.264
  output at 4096×2304. Remove the dead software candidates. Return an English, user-facing error.
- **Effort:** 3-4 h.
- **Confidence:** High on the limit and the missing encoders (measured). Medium on how many users
  hit it.

### 3. The render path writes the whole output twice (`+faststart`)

- **Where:** `crates/compositor/src/export_settings.rs:98-108`.
- **What happens:** every rendered MP4 is written, then rewritten in place to move the index to
  the front. The copy path already dropped this for `-moov_size`
  (`electron/export/recordingFastExport.ts:337-343`).
- **Impact:** measured on the copy path (HANDOFF, October 13): 64.5/93.1 s with `+faststart`
  against 49.3/50.3 s with `-moov_size` on 34.6 GB. A rendered 60-minute export is smaller, so
  expect a smaller but real saving at the end of every long export, when the bar sits at 100%.
- **Fix:** pass `moov_size` in the `avformat_write_header` options. Frame count is known from
  duration × fps; audio packets from duration / 1024 × 48 000. Reuse the 40 bytes per sample
  formula and keep the "fail rather than truncate" behavior.
- **Effort:** 1-2 h.
- **Confidence:** High.

### 4. Audio runs only after all video, then lands at the end of the file

- **Where:** `crates/compositor/src/pipeline_macos.rs:1440-1505`.
- **What happens:** the walker renders and writes every video frame first. Then audio is
  decoded, assembled, mastered and AAC-encoded in one serial tail. All audio packets land
  after all video packets, so the MP4 is not interleaved.
- **Impact:** extra wall time at the end of every render (not measured; for 60 minutes it is the
  decode of every audio track plus a 60-minute AAC encode). A non-interleaved file makes players
  seek between the start and end of a multi-GB file during playback.
- **Fix:** start each clip's audio decode on a worker thread once that clip's video is walked
  (the `on_clip_end` callback already gives its frame count). Mastering is off for new
  recordings (`editingPreferences.ts:506-507`), so a streaming encode can interleave audio packets.
  Keep the two-pass path only when mastering is on.
- **Effort:** 6-10 h.
- **Confidence:** High on the structure. Low on the time saved until measured.

### 5. Review playback decodes every source twice and copies each frame about 4 times

- **Where:** `src/components/ai-edition/PreviewCanvas.tsx:650-656` (the comment says the
  `<video>` elements stay mounted for decode and clock), `:748` (`VirtualPreview`), `:786`
  (`WebcamOverlay`), `crates/compositor-view-napi/src/lib.rs:268`,
  `src/native/hooks/useNativeCompositorView.ts:259-320`.
- **What happens:** the hidden screen and camera `<video>` elements decode in the renderer
  while the native compositor decodes the same files again with VideoToolbox. Each native frame
  is read back to RGBA, copied into a napi `Buffer`, sent over IPC, wrapped in `ImageData`,
  turned into an `ImageBitmap` and drawn.
- **Impact:** for a 3.4K60 screen plus 4K camera this is two full decode loads and roughly
  preview width × height × 4 bytes × 60 per second of copies. That means fan noise and battery
  drain during review. The size of the effect is **not measured**.
- **Fix:**
  1. Short term: give the clock to the native player or an audio-only element, and stop the
     hidden `<video>` elements from decoding video. Measure first with `powermetrics` during
     playback.
  2. Longer term: Electron 44.1 (installed) ships the experimental `sharedTexture` API
     (`node_modules/electron/electron.d.ts:13638-13670`). It imports an IOSurface as a
     `VideoFrame` in the renderer with no readback or copy.
- **Effort:** short term 8-16 h. sharedTexture spike 16-24 h.
- **Confidence:** Medium. The double decode needs a measurement to confirm that Chromium still
  decodes a `visibility: hidden` `<video>`.

### 6. Paused review still wakes up hundreds of times per second

- **Where:**
  - `src/components/ai-edition/WebcamOverlay.tsx:119-153`: 60 Hz rAF, no paused check. It runs
    `locateVirtualPosition` and `resolveActiveCameraTrack` every frame.
  - `src/native/hooks/useNativeCompositorView.ts:259-260`: the rAF re-arms every frame even in
    the 10 Hz idle mode.
  - `crates/compositor/src/live.rs:2294`: the native render thread sleeps 4 ms and loops, about
    250 wakeups per second while nothing changes.
  - `src/components/ai-edition/VirtualPreview.tsx:312-518`: the known 60 Hz clock loop.
- **Impact:** this is what remains of the 6.0-7.7% of one core measured paused on October 13.
  Constant wakeups keep the CPU from idling on battery.
- **Fix:** return early or cancel each rAF while paused, and restart on play, seek or command.
  Replace the 4 ms poll with a condvar that a command, seek or play signals.
- **Effort:** 3-5 h.
- **Confidence:** High on the loops (read in code). Medium on the CPU each one costs.

### 7. On a full boot disk, audio scratch files fail after the whole video render

- **Where:** `crates/compositor/src/audio_spool.rs:21` (`std::env::temp_dir()`),
  `crates/compositor/src/audio.rs:798` (one spool per decoded track),
  `electron/export/atomicExport.ts:487-510` (capacity check covers the destination folder only).
- **What happens:** PCM spools are 8 bytes per stereo sample frame, about 1.38 GB per track for
  60 minutes. Real screen MP4s carry three tracks (qaa mix, qab, qac); with source tracks
  present, two are decoded, plus the assembled output. Expect about 4 GB on the boot volume.
  That disk is never checked when the export goes to an external drive. A crash or SIGKILL
  leaves the files behind: `Drop` removes them, but nothing sweeps them at startup.
- **Impact:** a long export can fail at the audio step after 30+ minutes of rendering, and
  orphaned GB-size files pile up in `$TMPDIR`.
- **Fix:** preflight free space on the spool volume (≈ duration × 384 kB/s × spool count), or
  keep spools beside the staging file so the existing check covers them. Sweep stale
  `klippt-audio-<deadpid>-*.pcm` at startup.
- **Effort:** 2-3 h.
- **Confidence:** High on the mechanism. Medium on the peak spool count.

### 8. The copy path reads the whole source before checking free space, in a separate pass

- **Where:** `electron/native-bridge/services/compositorViewService.ts:829-857`,
  `electron/export/recordingFastExport.ts:299`.
- **What happens:** pass 0 (framehash of the source) runs inside `prepareRecordingFastExport`,
  before `publish()` runs `assertCapacity`. On a full disk the user waits through a full read of
  the recording (35 GB on the 63-minute take) and only then sees "Not enough free space".
  Pass 0 is also a full extra read that could run inside the copy process.
- **Fix:**
  1. Run the capacity check before pass 0.
  2. Fuse pass 0 into pass 1: one FFmpeg process, two outputs (`-f framehash` of `0:v:0` with
     `-c copy`, plus the MP4). Keep pass 2, the read-back proof of what reached the disk.
- **Impact:** removes one of three full read passes (HANDOFF lists 7.1-11.8 s per pass on the
  63-minute take) and gives an instant answer on a full disk.
- **Effort:** preflight 1 h. Fusion 3-4 h, including a test that the fused framehash equals the
  standalone one.
- **Confidence:** High on the order. Medium on the fusion (`-copyts` is global, so verify the
  MP4 output is unchanged).

### 9. The VideoToolbox encoder runs on FFmpeg defaults: a keyframe every 12 frames

- **Where:** `crates/compositor/src/pipeline_macos.rs:995-1003` sets only size, pix_fmt, time
  base, frame rate and `bit_rate`. libavcodec defaults: `-g 12`, `-bf 0`
  (`ffmpeg -h full`). `h264_videotoolbox` passes `gop_size` as `MaxKeyFrameInterval`.
- **Measured:** 24 s 1440p60 at `-b:v 8M`, `-g 12` gives 120 keyframes and 15.9 MB, SSIM 0.99970.
  `-g 120` gives 12 keyframes and 10.2 MB, SSIM 0.99961. At `-b:v 30M` from raw frames:
  8.0 MB against 5.8 MB. Speed was the same within noise (3.9-5.2 s for 600 frames, warm cache)
  for `-g 12`, `-g 120` and `-prio_speed 1`.
- **Impact:** rendered files are about 1.4-1.55× larger than needed. Quality is about the same.
- **Fix:** set `gop_size` to half the frame rate (YouTube's upload guidance; 30 at 60 fps) or
  2 s, and test `max_b_frames = 2` and `spatial_aq` on real terminal footage before making
  them defaults.
- **Effort:** 1 h plus a 1 h quality check.
- **Confidence:** High on the default and the size. Low on any visible quality change.

### 10. Separate takes to another volume does a full copy with no space check and no cancel

- **Where:** `electron/export/copyOriginalFile.ts:22` (`/bin/cp -c -n`, no `signal`),
  `electron/export/sourceHandoff.ts:34-110`.
- **What happens:** APFS cloning is instant on the same volume. On an external drive `cp`
  copies every byte: about 17 GB for the 4-clip October 10 take. There is no free-space
  preflight, and the copy cannot be cancelled. Cleanup on failure does work (`:222`).
- **Impact:** a full external drive fails partway with a raw `cp` error. The user cannot stop a
  long copy.
- **Fix:** when `stat().dev` differs between source and destination, compare the summed sizes
  with `statfs` free space first. Pass an `AbortSignal` to `execFile`.
- **Effort:** 1-2 h.
- **Confidence:** High.

## Also seen (below the top 10)

- **HEVC renders read back to the CPU every frame.** It has no `AV_PIX_FMT_VIDEOTOOLBOX`
  candidate (`pipeline_macos.rs:817-826`), so each frame waits on Metal (`compositor_macos.rs:2205`)
  and copies NV12 into system memory. Only reachable from saved full-export settings or the CLI,
  since One video forces H.264. Adding the zero-copy candidate is about 2 h and matters once
  finding 2 routes large outputs to HEVC.
- **The size estimate assumes the full target bitrate.** VT undershoots on screen content
  (6.4 Mbps produced at an 8 Mbps target on the test clip). The real 3402×1990 take averages
  3.6 Mbps. The preflight (`compositorViewService.ts:848`) can refuse an export that would fit,
  and the dialog overstates the size.
- **The copy path's FFmpeg timeout is fixed at 30 minutes per pass**
  (`recordingFastExport.ts:242`, `:346`). A multi-hour take on a slow external disk times out,
  then falls back to a full render.
- **Native error strings are French** (`pipeline_macos.rs:955`, `:975`, `:1150`) and can reach
  the export error UI.

## Newer techniques worth adopting

Researched 2026-10-20. Only shipped releases are listed. "H:" is a header in the installed
macOS 27.0 SDK (`$(xcrun --show-sdk-path)/System/Library/Frameworks/`). This Mac runs macOS 26.6.2,
so macOS 27 APIs were not run here.

1. **A 2 s keyframe interval, set explicitly.**
   - **Source:** Cap's export code, commit `cb129725` (read 2026-10-20),
     `crates/enc-ffmpeg/.../h264.rs:1204` sets `g = 2 × fps`, `realtime=false`, `allow_sw=0`.
   - **Replaces:** the libavcodec default `g=12` at `crates/compositor/src/pipeline_macos.rs:995-1003`.
   - **Gain:** 1.4-1.55× smaller rendered files (measured, finding 9). No speed change.
   - **Effort:** 1 h.
2. **VideoToolbox VBR with a VBV cap (`VariableBitRate`, `VBVMaxBitRate`, `VBVBufferDuration`).**
   - **Source:** macOS 26.0, released 2025-09-15. H: `VideoToolbox.framework/Headers/VTCompressionProperties.h:375-421`.
     Apple guide: https://developer.apple.com/documentation/videotoolbox/encoding-video-for-offline-transcoding
   - **Probed:** this M5's H.264 and HEVC hardware encoders list all four keys as supported.
   - **Replaces:** `AverageBitRate` via `bit_rate` at `pipeline_macos.rs:1001`. FFmpeg 8.1.2
     does not expose these keys, so this needs a direct `VTSessionSetProperty` on the session
     or our own VT encoder.
   - **Gain:** fewer wasted bits on static terminal frames, more on scrolling text. Size and
     quality are not measured.
   - **Effort:** 6-10 h (the FFmpeg wrapper does not expose its session).
3. **VideoToolbox compression presets (`HighQuality`, `Balanced`, `HighSpeed`).**
   - **Source:** macOS 26.0 (2025-09-15). H: `VTCompressionProperties.h`, `SupportedPresetDictionaries`.
   - **Probed:** on M5 HEVC 4K, `HighQuality` = VBR, VBV max 1.5× target, 16 lookahead frames,
     B-frames on.
   - **Replaces:** the hand-picked bitrate table in `src/lib/exporter/mp4ExportSettings.ts:29-36`.
     Use Apple's preset as the benchmark baseline for Highest.
   - **Gain:** unknown until benchmarked.
   - **Effort:** 2 h to benchmark.
4. **`ConstantQualityFactor` (a CRF-like quality target).**
   - **Source:** macOS 27.0, released 2026-09-14 (https://developer.apple.com/news/releases/).
     https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_constantqualityfactor
   - **Replaces:** fixed bitrates for Highest. It would need a macOS 27 gate.
   - **Gain:** consistent text quality and smaller static scenes (not measured).
   - **Effort:** 4-6 h after item 2.
5. **`SpatialAdaptiveQPLevel` (`-spatial_aq` in FFmpeg 8.1.2).**
   - **Source:** macOS 15.0 (2024-09-16). H: `VTCompressionProperties.h:1576`. Present in the
     bundled FFmpeg (`ffmpeg -h encoder=h264_videotoolbox`).
   - **Replaces:** nothing set today (`pipeline_macos.rs:995-1003`).
   - **Gain:** quality on flat UI regions next to text (not measured).
   - **Effort:** 1 h plus a quality check.
6. **Do not split exports across parallel encode sessions on base and Pro chips.**
   - **Source:** `kVTCompressionPropertyKey_RecommendedParallelizationLimit` (macOS 14) reads 1 on
     this M5, with a 900-frame minimum segment. Apple specs (fetched 2026-10-20): M5 and M5 Pro have
     one video encode engine, M5 Max two (https://www.apple.com/macbook-pro/specs/). FCP's
     "Allow export segmentation" gained 10-16% in a 2023 test (UNVERIFIED, Larry Jordan blog).
   - **Replaces:** the "parallel segment encode" idea in finding 1. Only worth it on Max and
     Ultra chips, gated on that key.
   - **Gain:** none on this machine.
   - **Effort:** n.a.
7. **Electron `sharedTexture`: IOSurface to `VideoFrame` with no readback.**
   - **Source:** Electron PR 47317, merged 2025-11-07, backported to 40-x-y 2025-11-11
     (https://github.com/electron/electron/pull/48831). NV12 import merged 2026-02-04 (PR 49040).
     Docs: https://www.electronjs.org/docs/latest/api/shared-texture. Experimental. Klippt has
     Electron 44.1.0.
   - **Replaces:** the readback → napi `Buffer` → IPC → `ImageData` → bitmap path
     (`crates/compositor-view-napi/src/lib.rs:268`,
     `src/native/hooks/useNativeCompositorView.ts:259-320`).
   - **Gain:** removes about four full-frame copies per preview frame (finding 5).
   - **Effort:** 16-24 h spike.
   - **Note:** napi-rs documents that Electron's V8 memory cage forces a copy of every native
     `Buffer` (https://napi.rs/docs/concepts/typed-array, napi 3 docs, 2025-07). External
     buffers cannot fix this.
8. **NV12 preview frames instead of RGBA (fallback if item 7 is too experimental).**
   - **Source:** Cap ships NV12 frames over a local WebSocket to a WebGPU worker
     (`apps/desktop/src-tauri/src/frame_ws.rs`, `apps/desktop/src/utils/frame-worker.ts`, commit `cb129725`).
   - **Replaces:** RGBA readback in `crates/compositor/src/live.rs` (latest_frame) and the
     `ImageData` path.
   - **Gain:** 2.67× fewer bytes per frame (1.5 vs 4 bytes per pixel). GPU colour conversion.
   - **Effort:** 10-16 h.
9. **Encoder and muxer on their own thread, behind a bounded queue.**
   - **Source:** Cap `crates/export/src/mp4.rs` (`sync_channel(4)` to an encoder thread) and
     `crates/rendering/src/lib.rs:1094` (decode the next frame during the current render),
     commit `cb129725`.
   - **Replaces:** `enc.send_composited` + `drain_encoder` on the walker thread
     (`pipeline_macos.rs:1418-1423`).
   - **Gain:** small; Klippt already defers the Metal wait one frame and is decode-bound (HANDOFF,
     September 11). Benchmark before building.
   - **Effort:** 4-6 h.
10. **FFmpeg 8.1.3 patch bump.**
    - **Source:** released 2026-09-20 (https://ffmpeg.org/download.html). 9.0 (2026-08-03) and
      9.0.2 (2026-09-18) also exist.
    - **Fixes:** movenc ("fix crash when flushing a fragment with no data") and mov demux
      hardening. Not yet in 8.1.3: the master-only `videotoolboxenc` use-after-free, leak and
      PTS fixes (2026-07-29 to 2026-10-05).
    - **Replaces:** the pinned `n8.1.2-34-g9b6c8969e0` in `crates/.cargo/config.toml` and
      `scripts/fetch-ffmpeg.mjs`.
    - **Gain:** robustness only.
    - **Effort:** 2-4 h plus re-signing the supply-chain approval (owner step).

**Checked and not worth adopting now:**
- **Metal 4 `MTL4CommandQueue`** (macOS 26, WWDC25 session 205): CPU-side encode savings; the compositor is not CPU-bound.
- **MetalFX:** needs 3D motion vectors.
- **VTFrameProcessor** (WWDC25 session 300): optional effects, not a speed-up.
- **AV1 encode:** this M5 lists AV1 decode only, and `VTCopyVideoEncoderList` has no AV1 encoder.
- **`AVAssetWritingPlanner` resumable export** (macOS 27): offline only, a design reference.
- **wgpu 30** (2026-07-01): no IOSurface import, and wgpu is Linux-only here.
- **FFmpeg Vulkan filters:** absent from the LGPL build.
- **Screen Studio 4.0** (2026-10-01, https://www.screen.studio/changelog) claims "up to 3x faster" exports with no published method (UNVERIFIED).
- **DaVinci Resolve "Bypass re-encode if possible":** conditions are only described in forum posts (UNVERIFIED).

## Quick wins under 2 hours

1. Reserve the MP4 index (`moov_size`) instead of `+faststart` in the render path (finding 3,
   1-2 h).
2. Set the encoder GOP to half the frame rate (finding 9, 1 h).
3. Run the free-space check before the copy path's first read pass (finding 8, 1 h).
4. Space preflight and cancel for Separate takes across volumes (finding 10, 1-2 h).
5. Sweep stale `klippt-audio-*.pcm` spools at startup (part of finding 7, 1 h).
6. Early-return the `WebcamOverlay` rAF while paused (part of finding 6, under 1 h).
7. Pick HEVC above 4096×2304 for One video renders (first half of finding 2, about 2 h).
