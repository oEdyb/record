# Performance implementation — 2026-09-05

Implementation of the [2026-09-04 audit](performance-audit-2026-09-04.md), authorized by Olle after the audit and included in the performance commit on `checkpoint/klippt-beta-hardening-2026-09-01`. Baseline: `8635cda9`. This note records measured scope and remaining platform gates; it does not claim a release is ready.

## Changes and evidence

| Area | Change | Verification |
| --- | --- | --- |
| Native export audio | Lossless temporary PCM spools replace complete-program arrays. Decode, stretch, mix, fades, loudness measurement, limiter, and AAC operate on bounded blocks. Raw decode/disk failures stop export; invalid clean stems retain the complete raw microphone. Temporary disk use grows with audio duration, while memory stays bounded. | 165 release unit tests; real reordered four-clip Metal/VideoToolbox export; long synthetic probes below. |
| Export decoders | Retain current screen/camera decoders, reuse adjacent sources, reopen reordered sources, aggregate telemetry across eviction. | 500 distinct source paths plus 12 reordered references; observed handles return to baseline. |
| Preview presentation | Hold one operation through IPC, bitmap creation, and paint. Close discarded bitmaps. Report only painted frames; discard pending packets after resize/unmount. Poll by elapsed time, capped at 30 Hz. | Tests at 60/120/144 Hz, delayed/rejected bitmap, resize, unmount, and transport integration. |
| Window startup | Lazy-load auxiliary windows, browser-only shims, and custom caption fonts. Countdown listener stays eager. Correct package matching in Rollup chunk rules. | Eager shell JS: 1,989,959 → 988,876 bytes at the startup checkpoint. Final build confirms separate window chunks. Bytes are not measured launch latency. |
| Timeline/scene work | Index region/clip lookups. Skip identical scene IPC submissions. Reset deduplication after view changes or failed sends. Cache bundled sprite lookups. | Focused timeline geometry, scene retry/lifecycle, and asset-resolution tests. |
| Undo | Own and freeze snapshots, share unchanged branches, clone returned Undo/Redo documents. Atomic background patching reuses owned data. A 64 MiB budget counts shared top-level branches once; retain up to 50 steps. | Schema-valid 15,000-word benchmark: record 50 snapshots 570–695 → 232–257 ms; patch all 50: 1,162–1,191 → 0.283–0.348 ms. Mutation, patch-failure, budget, import, Undo/Redo tests pass. Real GUI Remove/Undo/Redo/Undo restores two clips. |
| Caches | Waveform LRU protects mounted readers and bounds idle storage at 128 entries/8 MiB. Clean Voice prunes recognized completed derivatives once at GUI startup, before any path publication: 4 GiB/30 days. | Tests cover pinning, startup ordering, links, symlinks, unknown/incomplete entries, and original preservation. Runtime disk pruning remains disabled until readers have leases. |
| Cleanup | Remove 16 retired production files, seven orphan test files, one retired test block, and seven direct dependencies. Consolidate shared CSS policies while retaining behavior checks. | Lockfile has nine removed package records, zero additions or changed surviving package records. Signed dependency approval and notices regenerated and verified. Notes regressions remain because production scrolling coverage is still absent. |
| Test/CI cost | Reuse validated packaging bases with independent copy-on-write fixtures; retain full real-asset integration. Cancel superseded PR runs; cache Cargo outputs; skip Electron download in pure checks. | Original 29 packaging tests: 36.66 → 2.96 seconds on this Mac. Fixture-isolation coverage added. Hosted CI has not run. |
| Build/test maintenance | Extract recording path resolution from the main-process cycle. Update the Mac soak harness for bootstrap.js, .klippt, isolated userData, and retained child logs. Move the direct store-write E2E assertion to a unit test; production E2E uses accessible transport controls. | Production build and focused regression tests pass. |

## Runtime export measurements

Low-resolution synthetic native exports used real H.264/ALAC sources, Metal, VideoToolbox, and full-program normalization. These isolate memory behavior; they are not creator-workflow throughput benchmarks.

| Workload | Peak RSS | Export time | Observed open handles |
| --- | ---: | ---: | --- |
| 5 minutes | 46.4 MiB | 19.55 s | 8 → 12 → 8 |
| 30 minutes | 56.3 MiB | 123.61 s | 8 → 12 → 8 |
| 500 distinct source paths + 12 repeated/reordered references | 50.7 MiB | 8.99 s | 8 → 12 → 8 |

The 500 paths share a hardlinked inode; each distinct path opens a decoder, but this does not measure 500 physically different recordings. All audio streams have the expected duration; decoded samples are finite and measure −14.5 LUFS. The five-minute AAC decode has 512 normal trailing padding samples. Input hashes remain unchanged. Existing video duration metadata is one output frame short; output frame counts are exact.

A real 60-second animated-window capture at 2560 × 1440 passed through the production CLI and native export. Export took 26.784 seconds, output duration was 60.116 seconds, and audio/video duration difference was 16 ms. Start/middle/end decode checks and fast-start checks pass. The GUI also recorded two clips through Record → Pause → Continue → Stop and tested Remove → Undo → Redo → Undo.

The rebuilt native preview played a two-clip, 120.212-second animated fixture to completion without an error. Sampled playback was 26.689 seconds after 26.738 wall seconds and 104.342 after 104.485 wall seconds. The workload snapshot contained more than 3,500 painted frames, GPU readback p95 about 3.20 ms, and draw p95 1.0 ms. The trace also includes idle/loading time and was still open at test-app exit; it is not a completed sustained-FPS report or the packaged long-project gate.

The GUI playback check exposed and fixed an existing terminal-seek defect with variable frame timing: requesting a time after the final video PTS but inside the clip duration caused a fatal empty-preloaded-clip error. Mac and Windows decoders now retain the last owned frame at EOF; Linux already did so. The original recording now passes terminal seek, rewind, and playback to completion in the rebuilt GUI. Three native regression tests pass in automatic, software, and VideoToolbox modes; they cover valid GPU composition and keep corrupt-media errors. The shared Player regression is available on Windows too. The unused Mac frame-count stub was replaced with actual decoding, and its obsolete typecheck scaffold was removed; all four real export timing tests now pass.

Legacy GUI opening also exposed two existing migration issues: the title came from the wallpaper value, and the initial clip had no duration until a preview metadata event occurred. Both GUI opening paths now use the existing authorized-media duration probe before their first save. The recording filename supplies the default title. Failed or denied probes leave a recoverable placeholder; original projects and media remain unchanged. Focused tests cover the real CLI envelope and recovery. The final production build opened the untouched CLI fixture through Open project → Browse files with the correct recording title, one clip, 60.105875-second duration, and Saved status. Its original project hash remained unchanged. OS events operated the app controls; a one-use picker fixture supplied the file path. The cause of the initial missing preview event was not proven; opening no longer depends on that event.

## Verification record

- Final full JS suite: **2,658 passed, one skipped, 253 files**, 22.77 seconds. An earlier run caught an obsolete literal approval date; the corrected assertion checks its format while signature and hash checks remain intact.
- App and test TypeScript, repository Biome, docs, design, i18n, signed dependency verification, notices, and production Vite build passed. Biome retains the existing oversized generated Cargo-inventory warning.
- Initial built-renderer/Electron E2E: nine passed, one failed due to access to a development-only store global. The corrected four-test timeline E2E group and 30 relevant unit tests passed. Native MP4/GIF E2E exports passed.
- Independent read-only review found no introduced defects across native audio/decoder, preview, startup, timeline, cache, history, cleanup, packaging, and CI changes.
- Final read-only review also closed the terminal-seek finding and checked legacy opening, frame ownership, rewind, error paths, and original-media preservation. It found no introduced defects.
- After the final decoder change: 165 release library tests, three EOF regressions, and all four real export timing tests pass. Final test TypeScript and the changed test/harness lint checks also pass.
- macOS capture helper and compositor addon rebuilt and staged. Windows/Linux changes were source-reviewed but not built or run here. Clippy is blocked by two pre-existing public-raw-pointer safety errors in the Mac encoder.

## Constraints and follow-up

Retain the existing release gates: normal-resolution long creator flow, webcam/audio combinations, Windows/Linux execution, signed/notarized package and update validation. Synthetic low-resolution tests do not close those gates. Preview GPU sharing, native idle-loop redesign, and moving the automatic planner to a worker remain measurement-led follow-ups; no speculative replacement architecture was added.

## Primary contracts

- [HTML animation frames and image bitmaps](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html): timestamp-driven scheduling and asynchronous bitmap lifetime.
- [HTML media metadata](https://html.spec.whatwg.org/multipage/media.html#event-media-loadedmetadata): resolve legacy duration before the initial GUI save.
- [React immutable state](https://react.dev/learn/updating-objects-in-state), [React lazy](https://react.dev/reference/react/lazy): snapshot ownership and component loading.
- [Vite 7 async chunk loading](https://v7.vite.dev/guide/features#async-chunk-loading-optimization), [Rollup manual chunks](https://rollupjs.org/configuration-options/#output-manualchunks): avoid incidental eager dependencies.
- [FFmpeg decode/encode contract](https://ffmpeg.org/doxygen/8.0/group__lavc__encdec.html), [ebur128 0.1.10](https://docs.rs/ebur128/0.1.10/ebur128/struct.EbuR128.html): codec draining and bounded histogram loudness state.
- [Rust atomic temporary-file creation](https://doc.rust-lang.org/std/fs/struct.OpenOptions.html#method.create_new), [Node 22 filesystem contracts](https://nodejs.org/download/release/v22.22.1/docs/api/fs.html): spool creation, independent copies, and retention ownership.
- [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency): cancel superseded PR runs without grouping unrelated release/push runs.
- [Apple Quartz event posting](https://developer.apple.com/documentation/coregraphics/cgevent/post%28tap%3A%29): GUI checks used OS mouse/keyboard events, with browser inspection for observation.

Scratch evidence: `/tmp/klippt-history-benchmark.{cjs,log}`, `/tmp/klippt-native-memory-20260905/{REPORT.md,results.json}`, `/tmp/klippt-perf-real-capture.json`, `/tmp/klippt-tests-complete.log`, `/tmp/klippt-build-complete.log`, `/tmp/klippt-final-gates.json`, `/tmp/klippt-final-gui-check.json`, `/tmp/klippt-perf-gui/diagnostics/workloads/4e825107-c5b1-4b92-9b51-95c574d431a8.json`, `/tmp/klippt-v4-after.log`. Temporary files may disappear; the measurements above are the durable record.
