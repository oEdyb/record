# Recording-focused Klippt — October 3, 2026

Status: complete. Both performance targets, required gates and real Mac smoke tests passed.

Scope: a fast, recording-focused capture tool. No new editor features. The installed app,
release pipeline, Resolve, existing user projects, and remotes are outside this run.

## Starting checkpoint

- Branch: `codex/overnight-2026-10-03`.
- Original uncommitted work, including local artifacts, committed unchanged as `fff98f36f4748d74d67cd01fd1cdd12b3c66d712`.
- Twelve nested test-workspace Git metadata directories were temporarily parked because one had no commit; all were restored before committing. File contents were unchanged.
- Runtime: Node 22.22.1 / npm 10.9.4, held under `/tmp` for this run.

## Acceptance

- `npm test`, `npm run lint`, and `npm run wb:typecheck` pass.
- Actual HUD click-to-recording and 120-second MP4 export are measured before and after; both improve.
- Every behavior change and bug fix has regression coverage.
- Actual Mac capture, playback, and exported media agree, including a static-screen pause/resume recording.
- Each completed change below names its file and regression coverage; remaining issues name the reason.

## Changes

One line per behavior change; paired tests are listed after the semicolon. No new editing features were added.

- `src/lib/productSurface.ts`, `NewEditorShell.tsx`, `v4/EditorShellV4.module.css`: recording review replaces the timeline/inspector with playback, seek, Record, Save video and Original files; toolbar, menu/shortcut and actual Mac flow coverage.
- `src/components/ai-edition/RecordingReviewToolbar.tsx` and `.module.css`: compact, responsive recorder controls respect entitlement and active export state; `RecordingReviewToolbar.test.tsx`.
- `src/components/ai-edition/Preview.tsx`, `PreviewCanvas.tsx`: review preserves composed legacy-project playback while disabling camera, framing, zoom and annotation mutation; `PreviewCanvas.readOnly.test.tsx`.
- `src/lib/ai-edition/store/undo.ts`: recording review does not apply legacy document Undo keyboard commands; `undo.test.tsx`.
- `src/components/ai-edition/useRecordingReviewShortcuts.ts`: native-style Save, Record, library and playback shortcuts share review actions and preserve text inputs; `useRecordingReviewShortcuts.test.tsx`.
- `electron/main.ts`, `electron/recording/recordingReviewFileMenu.ts`, `src/components/ai-edition/useRecordingReviewMenu.ts`: native menu accelerators use recorder actions and cannot replace an active recording HUD; both menu test files.
- `src/components/launch/defaultRecordingSource.ts`, `LaunchWindow.tsx`: select an available default screen without overriding saved/manual/portal choices or late/unmounted state; default-source and launch tests.
- `src/hooks/useScreenRecorder.ts`, `LaunchWindow.tsx`: immediate Record and Continue skip the default countdown, reject duplicate starts, disable setup while starting and show recording only after writer acknowledgement; `useScreenRecorder.nativeStopFailure.test.tsx` and launch tests.
- `electron/recording/recordingPrefsStore.ts`: fresh setups use baked system cursor while preserving explicitly saved overlay choices; `recordingPrefsStore.test.ts`.
- `electron/recording/nativeMacCapturePermissions.ts`, `electron/ipc/handlers.ts`: already-granted Mac screen permission avoids repeated Electron source enumeration; permission tests retain denied/unknown fallback.
- `src/hooks/useScreenRecorder.ts`: discard unclaimed camera capture after cancelled/failed native startup; hook startup/cleanup regressions.
- `electron/recording/recordingStartupOverlay.ts`, `electron/ipc/handlers.ts`: bound overlay readiness, cancel pending shows and prevent stale overlay resurrection; overlay tests include real Electron event-overload type compatibility.
- `electron/recording/nativeCaptureHelperPaths.ts`, `electron/ipc/handlers.ts`: discover development helpers when Electron starts from compiled app paths, preserving packaged/env paths and Windows separators; helper-path tests.
- `electron/recording/nativeMacHelperClient.ts`, `nativeMacRecordingService.ts`: failed helpers are fatal once, dead buffered startup cannot succeed, and missing Continue first-frame acknowledgement stays recoverable; both native-client/service test files.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingFrameCache.swift`, `ScreenCaptureRecorder.swift`: resume from a complete current-source frame at the new host-clock boundary, drop older live frames and invalidate cache on source changes; native frame/cache tests encode static two-second, resumed one-second and subsecond clips (real ScreenCaptureKit Pause/Continue is verified separately).
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/ClosingFrameAppender.swift`, `ScreenCaptureRecorder.swift`: preserve idle-screen clip duration at Pause/Stop with a chronological closing frame and bounded writer retry; native encoded-duration/readiness regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/CaptureTelemetry.swift`: expose frame-status inspection used by the complete-frame cache; native frame-cache status tests.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingBoundaryWarnings.swift`, `ScreenCaptureRecorder.swift`: failed closing boundaries reach recoverable Pause/Stop results without losing committed media; four native warning tests and two helper-protocol regressions.
- `src/components/ai-edition/recordingImport.ts`: probe raw recording duration before atomically committing matching asset/clip lengths, fixing a two-minute file permanently imported as 60 seconds; five new deferred-duration/failure regressions and real two-minute raw import.
- `src/components/ai-edition/recordingReviewReadiness.ts`, `NewEditorShell.tsx`, `RecordingReviewToolbar.tsx`: wait for handoff consumption and the latest committed document before Save/Originals; preserve the pending-session blocker after failed imports or uncertain queries; readiness/ownership tests and a toolbar regression.
- `src/components/ai-edition/recordingReviewNavigation.ts`, `NewEditorShell.tsx`: gate library menus, shortcuts and delayed Browse results on the live handoff/project state, and close the library before Record; nine navigation regressions.
- `src/lib/ai-edition/store/projectStore.ts`, `NewEditorShell.tsx`: guard asynchronous library/Browse/launch loads at final publication so stale results or errors cannot replace a newer recording; deferred-load, cancellation and ownership regressions in `projectStore.test.ts`.
- `src/components/ai-edition/ExportDialog.tsx`: Save video opens one native picker directly for source-quality MP4, preserves legacy audio processing, and leaves manual retry after dismissal; `ExportDialog.flow.test.tsx`.
- `src/components/ai-edition/ExportDialog.tsx`: a new Save after closed background completion starts a fresh export, and cancelling reopened active progress never launches a replacement picker; separate completion/cancellation regressions in the flow test.
- `electron/export/recordingPassthrough.ts`, `src/native/contracts.ts`, `electron/native/compositor-view/addon.d.ts`: explicit source preservation allows packet copy only for a full-span single identity screen clip with compatible codec/dimensions/audio, preserving original cadence; guard tests and compile-time scene-field coverage.
- `electron/export/recordingFastExport.ts`, `electron/native-bridge/services/compositorViewService.ts`: probe, copy to staging, verify and atomically publish eligible recording MP4s; unsupported/probe/verification cases fall back, cancellation closes the child before cleanup, and silent sources gain stereo AAC; unit/service and four real FFmpeg packet/frame-identity tests.
- `electron/export/recordingFastExport.ts`, `electron/export/fixtures/closing-frame.swift`: prove packet count/hash, normalized PTS/DTS and average cadence before native verification, preserving a zero-duration closing packet and handling native 600-to-58 nominal-rate remuxing without weakening ordinary render checks; native AVAssetWriter fixture and callback-failure regressions.
- `electron/native-bridge/services/compositorViewService.ts`: duration-probe failures release active MP4/GIF export slots; service regressions.
- `electron/diagnostics/nativeExportPaths.ts`, `workloadTelemetry.ts`, `electron/ipc/nativeBridge.ts`: report packet copy and compositor bypass truthfully instead of a software-render fallback; native export-path tests.
- `src/i18n/locales/*/{editor,launch}.json`: add matching recording-review/startup labels across all locale dictionaries; i18n key validation and component tests.
- `scripts/build-macos-screencapturekit-helper.mjs`, `scripts/swift-build-output.mjs`: select the actual output of the installed SwiftPM with identical release/architecture/package/scratch arguments, failing instead of silently staging an old or dSYM binary; 10 output-selector regressions in `swift-build-output.test.mjs` and staged-binary hash verification.
- `scripts/overnight-recording-profile.mjs`, `overnight-recording-profile-utils.mjs`: repeat actual HUD capture, Stop, source-identical GUI export and smoke cases with isolated test data, and fix fixture JavaScript newline escaping; 14 utility regressions reject incomplete/mismatched performance proof, stale Stop replies, wrong-duration exports and invalid fixture code.
- `scripts/test-macos-capture-helper.mjs`: run native regressions in a temporary copied package with bounded Swift jobs and child-close cleanup, preserving the approved application manifest byte-for-byte; 12 real Swift XCTest cases passed.
- `scripts/test-macos-capture-helper.test.mjs`: verify isolated manifest validation, unchanged originals and success/failure/cancellation cleanup; 13 utility tests.
- `AGENTS.md`, `PRODUCT_PLAN.md`, `technical-documentation/product-behavior.md`, `HANDOFF.md`: make the recording focus and immediate capture/review/save flow authoritative; documentation checks.

## Measurements and checks

Final commands used Node 22.22.1 / npm 10.9.4. [Full command evidence](../artifacts/overnight-2026-10-03/final-checks/result.json)
retains separate logs and exit codes, including the earlier failed attempts.

- `npm test`: exit 0; 374 files passed, 3,992 tests passed, one existing skip; 78.210 seconds.
- `npm test -- --maxWorkers=2`: the complete suite also passed with bounded workers; 114.319 seconds.
- `npm run lint`: exit 0; 1,164 files checked; two existing warnings (an empty test catch and an oversized generated license inventory), no new warning.
- `npm run wb:typecheck`: exit 0.
- `npx tsc -p tsconfig.test.json --noEmit`: exit 0.
- `npm run build-vite`: exit 0, including app TypeScript and the final development UI bundle; no packaging step.
- `npm run i18n:check` and `npm run docs:check`: exit 0.
- `node scripts/test-macos-capture-helper.mjs`: exit 0; 12 native XCTest cases passed in an isolated package; [native log](../artifacts/overnight-2026-10-03/final-native-tests.log).

The first final suite exposed a changed approved Swift manifest checksum and timeouts under
host load. The application manifest was restored byte-for-byte, and native tests moved into
the isolated test package. Both full-suite reruns passed afterward; no approval policy or
release configuration was changed. Earlier Node 26/snapshot-load results are not acceptance evidence.

The first `baseline-recording-v2` timings are retained as diagnostic evidence only. Hash auditing
found the native build selector staging an older binary despite a successful Swift build. They
are not accepted performance proof. The original checkpoint was rebuilt in isolation and its
helper hash verified before the corrected before/after run.

Accepted proof: [comparison](../artifacts/overnight-2026-10-03/comparison.json),
[corrected baseline](../artifacts/overnight-2026-10-03/baseline-corrected/report.json),
[three after starts and fresh two-minute recording](../artifacts/overnight-2026-10-03/after-final-recording/report.json),
and [identical-source after export](../artifacts/overnight-2026-10-03/after-same-source-export-corrected/report.json).
The comparison links the separate measurement reports explicitly.

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Actual click to writer-accepted recording, median of three | 2,355.2 ms | 294.1 ms | 87.51% |
| GUI export to saved file, identical two-minute source | 54,389.3 ms | 879.6 ms | 98.38% |

Before starts: 2,702.7 / 2,355.2 / 2,354.1 ms. After starts: 330.9 / 294.1 / 288.8 ms.
The identical source SHA-256 is `9e0a66381dc72130ddd7ea70e939a6c51a7d99305c8674ab885ff71956f38d4a`;
both source and after export are 120.081667 seconds, H.264, 2564 × 1692, with 6,922 video packets.
The fresh after recording is 120.145 seconds and saves in 506.4 ms. The native closing-frame
600 nominal-rate source also saves successfully in 905.1 ms; its packet-preservation path is verified.

Native provenance: rebuilt checkpoint helper SHA-256
`0156a5ce3ce308f1b79af543af0c520f98f0a26a78e8a30d80ae5140277a109a`; current authoritative,
staged and development helper SHA-256
`d496cecd254b0ad0a2f4518306e14f526ec2e4d5682857ce79642e00acf7243c`.
[Baseline build receipt](../artifacts/overnight-2026-10-03/baseline-corrected/native-baseline-build.json).
Reports include compiled JavaScript hashes and host load; unrelated host work was left running.

Live capture was profiled over both two-minute recordings. Baseline delivered 57.644 fps with
zero dropped writer frames, mean app-process CPU 17.9998% and maximum summed working set
1,345,632 KB; thermal state was nominal. After delivered 57.456 fps with zero dropped writer
frames, mean app-process CPU 17.342% and maximum summed working set 1,222,672 KB; thermal
state was fair. These are observations on this busy Mac, not proof of a live-capture speed gain.
The CPU figures sum Electron `app.getAppMetrics()` processes and exclude the spawned native
capture helper. Its separately sampled CPU mean was 5.2504% before and 6.4522% after, with
maximum RSS 41,744 / 41,568 KB respectively (115 samples per run).
Native screen frames use ScreenCaptureKit/AVAssetWriter; eligible
Save bypasses decoding/compositing/video encoding and copies the original packets.

Stop was profiled separately because the early baseline harness incorrectly observed a hidden,
stale review window. Those early Stop timings are invalid. The corrected short-clip baseline
native Stop calls took 50.9 / 48.0 / 54.3 ms; complete current review took 752.4 ms cold and
253.1 / 261.3 ms warm. After native Stop took 69.0 / 44.3 / 49.6 ms; complete current review
took 600.8 ms cold, 290.2 ms warm and 432.2 ms for the two-minute file. Review readiness includes
the harness's media-duration observation. Stop remains in tens of milliseconds; no Stop-speed
improvement is claimed. [Corrected Stop baseline](../artifacts/overnight-2026-10-03/baseline-stop-corrected/report.json).

Actual static ScreenCaptureKit recording passed Pause → source change → Continue → Pause →
Continue → Stop. Three clips encode to 2.278333 / 0.928333 / 3.161667 seconds, matching committed
metadata to within one millisecond; review is 6.370 seconds. The middle clip visibly contains the
alternate source. [Report and media](../artifacts/overnight-2026-10-03/after-static-reconfigure-v2/report.json).
Subsecond capture, and Pause followed immediately by Stop, also passed real Mac capture.

The default-display flow is Record → Stop → Save video: three app clicks plus one native save
confirmation. Selecting the same window manually takes nine clicks before versus seven after,
plus the same native confirmation; benchmark-only codec/quality choices and app launch are excluded.
The before/after sequences are stored in `comparison.json`.

Final development UI smoke tests passed native menu Record/Save, two canceled pickers followed
by retry, actual playback advancement, source/export duration agreement and desktop recording
with the recorder HUD excluded. The 400-pixel layout has viewport width and scroll width both
400 and all controls visible; the harness temporarily lowers the development window minimum
for this audit and restores it afterward. No production minimum-width change was made.
[UI report](../artifacts/overnight-2026-10-03/after-default-display-ui-v2/report.json).

Removing the previous clip back to zero, then Continue/Pause/Continue/Stop, passed: the removed
clip file remains recoverable, and only the retained 0.945 + 1.960 seconds appear in the 2.905-second
review. [Removal report](../artifacts/overnight-2026-10-03/after-remove-zero/report.json).
Killing only the test-owned capture helper passed failure recovery into the durable clip review.
[Failure report](../artifacts/overnight-2026-10-03/after-helper-failure/report.json).

Existing-grant microphone-only, system-only, both and neither capture passed. System-only recorded
118 native audio samples; microphone-only 178; both 117 system and 195 microphone samples and
three AAC tracks. The mixed-audio smoke recorded one dropped writer frame under the concurrent
full-suite load; no zero-drop or audio quality claim is made for that smoke. The two-minute
no-audio performance captures had zero dropped writer frames. Reports are linked in `comparison.json`.

Measurements use the development Electron app with isolated user data and temporary files.
The recording benchmark selects the same source and baked system cursor explicitly. Baseline
export renders source dimensions, requested 60 fps and H.264; source-preserving Save keeps the
original H.264 packets, timestamps and frame cadence. FPS/bitrate settings apply only to its
render fallback. Export comparisons use the identical recorded source SHA-256. No recorder or export is mocked.
The native save picker is redirected only to an owned test output path. The capture source is a
synthetic terminal with a CSS cursor/bar animation; it is not scrolling real-world terminal logs.
The earlier fixture script had incorrectly escaped newlines, while its identical CSS animation
remained active in both timing runs. The corrected utility test protects future fixtures. The
identical two-minute copied export also passed actual FFmpeg tail decoding.

## Primary sources

- [Apple writer append](https://developer.apple.com/documentation/avfoundation/avassetwriterinput/append%28_%3A%29), [retiming](https://developer.apple.com/documentation/coremedia/cmsamplebuffercreatecopywithnewtiming%28allocator%3Asamplebuffer%3Asampletimingentrycount%3Asampletimingarray%3Asamplebufferout%3A%29) and [host clock](https://developer.apple.com/documentation/coremedia/cmclockgethosttimeclock%28%29): acknowledge actual accepted samples and give boundary frames unique host-clock timing.
- [ScreenCaptureKit idle frames](https://developer.apple.com/documentation/screencapturekit/scframestatus/idle) and [filtered screenshots](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager/capturesamplebuffer%28contentfilter%3Aconfiguration%3Acompletionhandler%3A%29): an unchanged display may deliver no new frame; macOS 14 adds a filtered one-frame fallback.
- [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance): measure real work and defer unrelated UI work.
- [React state](https://react.dev/reference/react/useState): keep recorder UI state tied to acknowledged work.
- [HTML media duration](https://html.spec.whatwg.org/multipage/media.html#dom-media-duration-dev) and [loaded metadata](https://html.spec.whatwg.org/multipage/media.html#event-media-loadedmetadata): commit probed raw duration instead of depending on a preview event that may already have fired.
- [FFmpeg streamcopy](https://ffmpeg.org/ffmpeg.html#Streamcopy): source preservation copies compressed packets only when no transformation is required.
- [FFmpeg MP4 faststart](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv): finalize MP4 indexing for ordinary file playback.
- [Node 22.22.1 child lifetime](https://github.com/nodejs/node/blob/v22.22.1/doc/api/child_process.md#event-close): wait for child closure before staging cleanup.
- [FFmpeg stream rates](https://ffmpeg.org/doxygen/8.0/structAVStream.html): distinguish nominal and average frame rates; preserve VFR packets on the explicit source-quality path.
- [FFmpeg probing/seeking](https://ffmpeg.org/doxygen/8.0/group__lavf__decoding.html) and [decoding](https://ffmpeg.org/doxygen/8.0/group__lavc__encdec.html): reopen and decode exported head/tail before publication. Klippt's one-video/one-stereo-AAC verification policy is owned by `crates/compositor/src/export_verify.rs`, not by the MP4 standard.
- Installed `swift build --help` and `--show-bin-path`: use the current tool's output contract rather than a guessed SwiftPM directory.

## Not fixed or not verified

- New editor features: excluded by the explicit recording-only direction; inherited project/CLI/export behavior remains compatible.
- Multi-clip, camera, trimmed, transformed, editable-cursor or mastered exports, unsupported AAC layouts, and rotated/non-square-pixel sources: retain the existing renderer; safe packet identity has not been proven for these inputs.
- Windows/Linux runtime capture: no corresponding desktop available on this Mac; pure helper discovery and existing platform paths remain covered by unit tests.
- macOS 13 paused reconfiguration of an entirely static uncached source: lacks the macOS 14 screenshot fallback; a fresh complete ScreenCaptureKit frame is still required and timeout is reported loudly.
- Newly added non-English locale labels: English fallback with matching keys; translation quality has not been validated.
- Installed app, packaging/signing/CI/update-feed release actions, Resolve and remote pushes: deliberately untouched under the task constraints; only the development native-helper build output selection was corrected.
- Long 5/30/60-minute recording runs: not yet exercised in this run; the acceptance benchmark is two minutes. Existing release duration gates remain applicable.
- Constant 60 fps under unrelated host load: not proven; the recorded native cadence was about 57.5 fps with no dropped writer frames. Source-preserving Save retains that cadence rather than inventing frames.
