# Klippt performance and code audit — 2026-09-04

Follow-up: [implemented changes and verification, 2026-09-05](performance-implementation-2026-09-05.md). The findings below describe the original baseline.

Audited commit: `8635cda9`. The working tree was clean at the start. This is an audit, not an implemented optimization. No runtime code, dependencies, or tests were changed.

## Result

The main opportunities are bounded export memory, correct preview scheduling, smaller window startup bundles, and cheaper document history. Removing obsolete code will reduce maintenance, but most of that code is already outside the application import graph. It is unlikely to improve playback speed.

The test suite is healthy at runtime and reasonably fast. Its largest cost is one packaging fixture factory. Keep the behavioral checks and reduce repeated fixture work. The separate test typecheck currently fails.

## Scope and evidence

Inspected the renderer, Electron bridge and services, Mac capture, shared native timeline walker, Mac export, audio processing, recording controls, document history, analysis, cache lifecycles, dependencies, packaging, and CI. Windows and Linux received a source/configuration review, not execution on those operating systems. The inherited website and lab tools were checked as separate support surfaces; they are not desktop hot paths.

The import audit used the installed TypeScript resolver, starting at `src/main.tsx`, `electron/bootstrap.ts`, and `electron/preload.ts`. It followed imports, exports, literal dynamic imports, and worker URLs. It included type imports conservatively. Reference searches then checked the unreachable candidates against tests, scripts, and workbench code. This is not proof against arbitrary runtime-generated paths or external consumers.

Fresh checks used the pinned Node `22.22.1`:

| Check | Result |
| --- | --- |
| `npm test -- --reporter=default --reporter=json` | 250 files; 2,671 passed, 1 skipped; 22.60 seconds |
| `npx tsc --noEmit` | Passed |
| `npx tsc -p tsconfig.test.json --noEmit` | Failed: TS18047 at `src/native/hooks/useNativeCompositorView.test.ts:121`; `ref.current` may be null |
| `npm run lint` | Passed with the existing 1.4 MiB `Cargo-Evidence.json` size warning |
| `npx vite build` | Passed; renderer 6.70 s, main 2.98 s, preload 14 ms; chunk warnings remain |
| Actual preview hook with controlled rAF and bitmap promises | Reproduced refresh-rate-dependent polling and stale bitmap presentation |
| Actual document-history module with synthetic data | Measured whole-history cloning cost; details below |
| Existing local workload reports | Read 29-report inventory; latest post-fix preview report has only 2 delivered frames |

The shell defaults to Node 26.5.0. Checks explicitly prepended `/Users/olle/.local/share/fnm/node-versions/v22.22.1/installation/bin` to PATH. These are single local measurements, not repeated quiet-machine benchmarks. No fresh long recording, native export, GPU trace, packaged interaction test, or Rust suite ran. This audit does not close the existing real-Mac release gates.

## Ranked findings

### 1. High — export holds full-program audio in memory

Locations: [pipeline_macos.rs](../crates/compositor/src/pipeline_macos.rs), around lines 1139–1226; [audio.rs](../crates/compositor/src/audio.rs), `decode_clip_audio_inner`, `stretch_clip_pcm_by_speed`, `finalize_decoded_clip_audio`, and `assemble_concatenated_pcm`.

The video walk retains decoded microphone and bed PCM for all clips. It then creates mixed clip buffers and another complete concatenated program buffer before mastering and AAC encoding. Even the unchanged-speed path copies segment slices and creates exact-length output arrays. `assemble_concatenated_pcm` allocates the complete duration even when all segments are silent.

At 48,000 samples/s, two channels, and four bytes/sample, one hour is **1,382,400,000 bytes (1.29 GiB) per complete stereo buffer**. At 90 minutes it is 1.93 GiB. These are allocation calculations from the code, not measured peak RSS. Source roles, intermediate copies, and speed processing can increase the peak substantially.

Recommended change: produce exact-length edited audio in bounded blocks, with a disposable lossless spool for whole-program loudness measurement and a second mastering/encode pass. First remove unnecessary copies on unchanged-speed segments and release buffers as soon as their consumer finishes. Preserve isolated source roles, clean-stem validation, complete-program normalization, speed mapping, 10 ms boundary fades, and atomic publication.

Acceptance: measure peak native RSS at 5, 30, 60, and 90 minutes. Verify decoded AAC duration, boundary samples, loudness, true peak, cancellation, and original-media preservation. Do not replace whole-program mastering with independent per-clip normalization.

### 2. High — export retains every source decoder until completion

Location: [timeline_walk.rs](../crates/compositor/src/timeline_walk.rs), lines 155–174 and 243 onward; decoder maps are owned by `pipeline_macos.rs`.

The walker inserts one screen decoder per distinct source path and one camera decoder per distinct camera path. Neither map evicts entries during the walk. Cursor tracks also accumulate by source path. A recording with many clips therefore retains many decoder contexts, file handles, and native frame resources. This scales with unique media sources, even after earlier sources are no longer needed.

Recommended change: count future source uses and release decoders after their last use, or use a small bounded cache when timeline reordering makes reuse valuable. Keep shared camera sources reusable. Preserve aggregate decoder-path telemetry after eviction.

Acceptance: compare 10, 100, and 500 short clips; measure open handles, live decoder count, RSS, and export throughput. Include repeated and reordered references to the same source. This is a confirmed lifetime pattern; the size of its runtime penalty is not yet measured.

### 3. High — preview backpressure ends before presentation

Location: [useNativeCompositorView.ts](../src/native/hooks/useNativeCompositorView.ts), lines 259–318.

`inFlight` becomes false immediately after IPC returns. `createImageBitmap()` is still pending. The next request can therefore start another bitmap operation. Completed bitmaps have no generation check before `drawImage()`. `onFrame` and the frame probe also run before the bitmap is painted.

A scratch harness transpiled and executed the actual hook, with only React hooks, the native client, rAF, and canvas boundaries stubbed. Holding bitmap completion produced **three pending bitmaps**. Resolving bitmap 2 before bitmap 1 produced **draw order `[2, 1]`**. All three timing callbacks had already fired. This demonstrates a scheduling defect; it does not measure its frequency in Chromium.

Recommended change: keep one presentation operation in flight through bitmap creation and draw, or discard stale completed generations explicitly. Close every discarded bitmap. Notify transport/presentation observers after the accepted paint. Preserve seek identity checks and cancellation on view destruction.

Acceptance: delayed and rejected bitmap promises, out-of-order completion, seek during draw, resize, and unmount. Then verify playback and scrubbing in the real Mac app.

### 4. Medium — the advertised 30 FPS preview cap depends on monitor refresh

Location: [useNativeCompositorView.ts](../src/native/hooks/useNativeCompositorView.ts), `PULL_LOOP_TICK_DIVISOR` and `pullLoop`, around lines 89 and 240.

Every second rAF callback is not a fixed 30 FPS limit. Executing the hook against simulated display schedules, with immediately resolved native reads, produced:

| Display refresh | Polls in one simulated second |
| --- | --- |
| 60 Hz | 30 |
| 120 Hz | 60 |
| 144 Hz | 72 |

This is a poll-rate result, not a claim that the decoder produces 72 frames. Native generation filtering prevents repeated pixel transfer for an unchanged frame, but does not prevent the IPC request. At 1280×720, one fresh RGBA payload is 3.69 MB; 30 fresh payloads/s represent 110.6 MB/s before counting additional copies.

Recommended change: use elapsed rAF timestamps and an explicit presentation interval. Combine it with finding 3. Consider waking idle preview on scene/seek updates rather than continuous empty polling.

The native idle loop also wakes about every 4 ms in [live.rs](../crates/compositor/src/live.rs), around line 1863. An event/condition-variable wait is a separate battery optimization candidate. Measure idle CPU and wakeups before changing it.

### 5. Medium — every window loads recording and Notes code eagerly

Location: [App.tsx](../src/App.tsx), lines 9–19 and 84–89; [NotesWindow.tsx](../src/components/launch/NotesWindow.tsx); [vite.config.ts](../vite.config.ts).

The editor and CLI entries are lazy, but LaunchWindow, NotesWindow, source selection, countdown, and camera preview are static imports. Notes pulls in its rich-text editor. Each auxiliary renderer loads this common entry even when it only needs a countdown or a camera image. Every window also calls `loadAllCustomFonts()`.

The fresh production build emitted a **1,190.64 kB minified entry chunk**, plus separate React and video-processing chunks of 457.89 and 341.44 kB. Bundle size is evidence of load breadth, not a measured startup delay.

Recommended change: split by actual window type, with a small shared shell. Keep countdown readiness and the first-frame barrier intact; preload the countdown route before it must appear. Load custom caption fonts only in windows that use them. Inspect emitted static imports after the change, because manual chunks can keep otherwise lazy code eager.

Main-process follow-up: the build reports a circular `update-checker → main → update-checker` chunk and a chat-model import that is both static and dynamic. The 2,879.89 kB chunk named `update-checker` must not be mistaken for updater-only code. Trace the bundle graph before changing it. The existing lazy LLM credential store is valuable and should stay lazy.

Acceptance: packaged cold-start trace and per-window JS/RSS measurements for HUD, countdown, Notes, camera monitor, and editor. No claimed percentage saving until those measurements exist.

### 6. Medium — background edits clone all Undo documents twice

Location: [documentHistory.ts](../src/lib/ai-edition/store/documentHistory.ts), lines 3–37.

Each history entry is a complete `structuredClone`. `patchDocumentHistory` clones each compatible snapshot before applying the patch, then clones its result. The 50-entry cap bounds count, not bytes. Large transcripts, annotation data, or custom background strings amplify the cost.

A synthetic 15,000-word object, 1,111,007 JSON bytes, exercised the actual module under Node 22: recording 50 snapshots took 250.6 ms total; patching those 50 snapshots took **539.0 ms**. This is a cloning stress probe, not a schema-valid creator project or a browser benchmark. Reported heap usage includes the TypeScript harness and is not attributed to history.

Recommended change: first establish immutable document ownership, then use structural sharing or smaller reversible patches. Remove the redundant second clone only after checking patch mutation contracts. Consider a byte budget in addition to entry count. Preserve one Undo step per import and all late-enhancement/concurrent-edit rules.

Acceptance: real long-project Undo latency and heap snapshots, plus the existing history/import/concurrency tests. Do not replace complete Undo behavior with settings-only history.

### 7. Medium — timeline and scene work can grow unnecessarily during editing

Locations: [V4Timeline.tsx](../src/components/ai-edition/v4/V4Timeline.tsx), around lines 463 and 1538; [NativeCompositorOverlay.tsx](../src/components/ai-edition/NativeCompositorOverlay.tsx), lines 134–154; [compositorViewService.ts](../electron/native-bridge/services/compositorViewService.ts), `resolveSceneAssetPaths`.

The timeline groups projected sections by filtering the whole projection for every clip. During rendering, each clip also searches assets and video sources. All clip tracks are rendered. These are avoidable quadratic scans and DOM growth on long timelines. Playback itself already isolates the playhead subscription, so a broad store rewrite is not justified.

The native scene effect rebuilds and serializes the complete scene on any document identity change. The main process then parses it and resolves cursor sprite paths with synchronous filesystem probes. Layout gestures and transcript updates can resend unchanged resource paths.

Recommended change: group projection/asset/source lookups once with maps; profile long-timeline rendering before adding virtualization. Memoize packaged resource resolution and use a render-relevant scene signature/coalescing boundary. Keep source and asset validation at the trusted boundary.

Automatic direction also executes its planner synchronously in the renderer after observations load. The tuning pane already debounces requests; debounce does not move CPU work off-thread. Profile labelled long fixtures before considering a worker around the existing pure planner. Do not fork the planner.

Acceptance: browser long-task traces for drag, trim, transcript completion, and automatic replanning on large projects. These are code-supported optimization candidates; interaction speedups are not measured.

### 8. Medium — one packaging test fixture dominates suite wall time

Location: [verify-packaged-distribution.test.mjs](../scripts/verify-packaged-distribution.test.mjs), `packageFixture`, lines 31–161.

This file ran 29 tests in **21.711 seconds** of a 22.60-second suite. The next slowest file took 3.712 seconds. File timings overlap across workers and must not be added to derive suite wall time.

Each fixture copies the complete wallpaper tree into staging, resources, and reviewed output, creates an ASAR, and copies fonts, icons, WASM, and notices. Wallpapers alone occupy about 24 MiB locally. Most negative policy cases need one changed file, not fresh copies of all large assets.

Recommended change: build a validated immutable base fixture once; create isolated variants efficiently, or inject a minimal reviewed asset set into focused policy tests. Keep at least one real-assets end-to-end package test. Never share mutable fixture files across negative cases. This is a fixture-cost problem, not evidence that package policy tests are unnecessary.

Keep Vitest's current Node-default/jsdom-opt-in split. Do not globally disable isolation or raise worker counts without new measurements; repository notes document failures with those approaches. Current online Vitest guidance now includes v5 material, so do not assume all new options exist in the installed 4.1.10.

### 9. Low — style-string tests duplicate policy, not rendered behavior

Locations: [shortcuts.test.ts](../src/lib/shortcuts.test.ts), final test; [app-select.test.tsx](../src/components/ui/app-select.test.tsx), final test; [app-menu.test.tsx](../src/components/ui/app-menu.test.tsx), style test; [inspector.test.tsx](../src/components/ui/inspector/inspector.test.tsx), style test; final two tests in [NotesWindow.test.tsx](../src/components/launch/NotesWindow.test.tsx).

Several tests read CSS/source and search for token names or forbidden green strings. They can fail on harmless comments and pass when a correct token is present but overridden. Notes checks literal CSS/import structure rather than verifying production scrolling.

Recommended change: consolidate intentional design-policy rules into one static check. Keep keyboard, accessibility, controlled-input, and commit-lifecycle tests. Cover Notes scrolling and toolbar visibility in a built-app browser test before retiring its source-string regression. These checks are not the current suite bottleneck.

Keep AppSelect's single no-native-select policy guard, or move it to the consolidated check; that rule is an explicit product requirement.

### 10. Low/medium — CI repeats expensive setup and obsolete runs

Location: [.github/workflows/ci.yml](../.github/workflows/ci.yml) and [.github/actions/setup/action.yml](../.github/actions/setup/action.yml).

The main CI workflow has no workflow concurrency cancellation. Its Rust jobs have no Cargo target cache. Several separate JS jobs each install dependencies and explicitly install Electron, including checks that do not launch Electron. These are source/configuration observations; hosted run costs were not measured.

Recommended change: cancel superseded PR CI runs, cache native builds with keys that include OS, toolchain, lockfile, and FFmpeg SDK, and separate pure JS setup from Electron runtime setup where possible. Keep required checks present. Keep release/publish jobs outside cancel-in-progress rules. Platform-native checks are valuable and should not be deleted because Mac is the first delivery target.

### 11. Lower priority — cache ownership needs a later cleanup pass

[useAudioPeaks.ts](../src/hooks/useAudioPeaks.ts) keeps a module-lifetime URL-keyed cache without eviction. [cleanVoiceService.ts](../electron/media/cleanVoiceService.ts) cleans staging but retains completed recipe entries without a general byte/age policy. The waveform values are capped and small; derived lossless stems can be much larger.

Add measured cache inventories and ownership-aware limits. Preserve active readers, verified clean routes, source media, Undo, and recovery. The OPFS source cache already has refcounts, in-flight deduplication, heartbeat, and stale-run cleanup; do not replace it with a broad directory deletion.

## Unused-code removal candidates

The graph found 17 unreachable files, including the intentionally separate Vitest setup file. Excluding setup gives **16 production-file candidates, approximately 2,752 lines**. Counts include comments and blank lines. These are candidates, not deletions made by this audit.

| Candidate group | Files |
| --- | --- |
| Retired recording setup page | `src/components/ai-edition/v4/RecStage.tsx`; `src/components/ui/audio-level-meter.tsx`; `src/components/ui/use-dialog-focus.ts` |
| Old browser rendering helpers | `src/lib/exporter/annotationRenderer.ts`; `src/lib/exporter/webcamFrameDrawing.ts`; `src/lib/cursor/uploadedCursorAssets.ts` |
| Old browser time stretching | `src/lib/exporter/audioTimeStretch.ts` |
| Old cursor spring implementation | `src/lib/cursor/cursorPathSmoothing.ts`; `src/lib/zoomMath/motionSmoothing.ts`; `src/lib/zoomMath/zoomSpring.ts` |
| Unused buffering and gesture helpers | `src/lib/cursorTelemetryBuffer.ts`; `src/lib/ai-edition/timeline/pointer-drag.ts`; `src/lib/frameStep.ts` |
| Superseded settings history | `src/hooks/useEditorHistory.ts` |
| Old caption extraction entry | `src/lib/captioning/extractMono16k.ts`; `src/lib/captioning/index.ts` |

Do **not** remove `extractMono16kWebDemuxer.ts`: streaming waveform code still uses it. Do not delete all `video-editor` files because the folder is legacy-named; the active editor still imports shared types, defaults, and persistence code from it. Keep current native cursor smoothing and document history.

Five wholly orphan-associated test files contain 39 tests: `cursorTelemetryBuffer`, `cursorPathSmoothing`, `zoomSpring`, `audioTimeStretch`, and `pointer-drag`. Remove those tests with their retired implementations after confirming no supported caller remains. `editorDefaults.test.ts` contains three tests, but only its first assertion group depends on the retired history hook. Keep its other two tests, which protect active preference/persistence defaults. Thus **40 of the 42 tests in these six files** are retirement candidates, not all 42.

Potentially redundant direct dependency declarations:

- `@radix-ui/react-accordion`
- `@radix-ui/react-toggle`
- `@tiptap/extension-text-style`
- `@uiw/color-convert`
- `@uiw/react-color-block`
- `mp4box`
- `react-resizable-panels`

No app/script/workbench literal imports were found for these seven. `@radix-ui/react-toggle` is still transitive through toggle-group; color-convert also remains transitive through used color controls. Removing direct declarations will not necessarily remove their installed packages. Keep `tailwindcss-animate`, which is loaded by Tailwind configuration. Update npm's lockfile and dependency notices together after an actual removal. Rebuild and verify the packaged dependency graph; do not infer package-size savings from source line counts.

## Keep these protections and existing optimizations

- Mac capture uses one SCStream, bounded audio backpressure, asynchronous writer finalization, and isolated source tracks. No evidence supports reducing capture quality or queue depth just to lower memory.
- Camera preview reuses the recorder stream and has an explicit backpressure contract. Preserve it.
- Native preview uses CSS-sized output and consumes frame buffers without the old native clone. Export keeps its own output resolution.
- Screen-only export no longer creates an unused camera decoder.
- GPU-resident video export, atomic output publication, sample alignment, source-role checks, project write serialization, and concurrent-edit/Undo tests protect expensive failures.
- Native waveform extraction, source-based deduplication, deferred STT, and recording-aware Clean Voice suspension are useful. Small `.map()` calls in these paths are not an optimization priority.
- CLI and UI share project commands. Do not remove compatibility migrations, native fallbacks, or platform checks as “dead code” without testing their entry points.

## Measurement gap and next implementation order

The latest existing CSS-size preview workload (`a7bb000e-bd3f-429b-a02c-af6d4dd075bd`, 2026-09-01 UTC) covers 22.8 seconds and only two delivered frames, despite 570 IPC samples. Its GPU-readback p95 is not enough evidence for sustained playback. The older 2560×1440 report has 197 delivered frames and 42.48 ms readback p95. These are not a valid matched performance comparison.

Recommended order:

1. Fix the test-ref nullability error and preview presentation/rate defects. Verify the original Mac playback and scrub flow.
2. Run a sustained CSS-size preview trace. Measure accepted paint intervals separately from empty IPC latency; do not add unrelated percentile values.
3. Bound decoder lifetime and export audio memory. Run long exports with decoded-media checks.
4. Split auxiliary-window startup and reduce repeated scene/history work, guided by traces.
5. Remove confirmed retired code and its tests; simplify the packaging fixture and redundant direct dependencies.
6. Improve CI setup/caching and measure the new complete suite once.

An IOSurface/shared-texture preview is a later prototype if CPU readback remains the measured bottleneck. Electron 44.1.0's installed type declarations expose `sharedTexture` and `SharedTextureHandle.ioSurface`. The API is experimental and has explicit lifetime/synchronization rules. It is not a drop-in change, and it must not weaken renderer sandboxing.

## Primary references

- [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance): defer unused work and keep the main process responsive.
- [Electron sharedTexture contract](https://www.electronjs.org/docs/latest/api/shared-texture): experimental import/transfer and resource-release obligations. Cross-checked against the installed 44.1.0 `electron.d.ts`.
- [Apple Metal resource synchronization](https://developer.apple.com/documentation/metal/resource-synchronization): synchronization remains required when changing GPU/CPU ownership.
- [React lazy](https://react.dev/reference/react/lazy): window-specific modules can load on first render; the API already exists in this app's React 18 usage.
- [Vitest performance guidance](https://vitest.dev/guide/improving-performance): distinguish worker-phase totals from wall time and profile before changing isolation. Current site includes newer-version material; installed config remains authoritative for 4.1.10.

Scratch evidence from this session is in `/tmp/klippt-audit-vitest-20260904.{json,log}`, `/tmp/klippt-audit-build-20260904.log`, `/tmp/klippt-audit-{tsc,test-tsc,lint}.log`, `/tmp/klippt-audit-graph.{cjs,json}`, and `/tmp/klippt-preview-audit.cjs`. Temporary paths can disappear; the key results, scope, locations, and measurement methods are recorded above.
