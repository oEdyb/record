# Recording-focused Klippt — October 3, 2026

Initial recording-focus phase: complete. Both performance targets, required gates and real Mac
smoke tests passed. The source-quality follow-up below is complete.

Initial scope: a fast, recording-focused capture tool. No new editor features. The installed app,
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

## Follow-up — October 3, 2026: high-quality untouched source handoff

Status: complete. Remain on `codex/overnight-2026-10-03`; no installed-app, release-pipeline,
remote-push or existing Resolve-project changes. A new owned Resolve test project is permitted
for the requested actual four-track import proof.

Acceptance: a real 120-second Mac clip with screen, camera, microphone and system audio copies
all complete sources in under five seconds, byte-identical to their originals. Separate takes
is the fresh default and remembers explicit choice; One video remains available. High is the
fresh remembered recording-quality default; compare it with Standard on the same deterministic
content and report bitrate, actual frame rate, writer drops, file size and CPU. Verify actual
Resolve import, positions, source offsets, moved links and playback, plus all required gates.

Follow-up changes (one line per change, with file and regression coverage):

- `src/components/ai-edition/ExportDialog.tsx`, `src/lib/ai-edition/store/editingPreferences.ts`: preselect Separate takes on fresh setup and remember explicit output choice across reopen/new mounts, retaining One video and active video progress; flow and preferences tests.
- `electron/export/sourceHandoff.ts`: byte-copy complete screen, hidden camera and standalone microphone/system originals with original extensions; manifest v2 lists files and unchanged encodings; unit and actual-media byte-identity regressions.
- `electron/export/sourceTimeline.ts`: apply standalone audio offsets once as source trims or gaps and keep cuts/synchronization only in OTIO; exact-offset, shared-boundary and real-media timeline regressions.
- `electron/export/sourceHandoffMedia.ts`: normalize Matroska/WebM's positive timestamp origin without altering MOV/MP4/M4A elapsed durations or media bytes; header parsing and real one-second/nonzero-origin media regressions.
- `src/components/ai-edition/SourceExportPanel.tsx`: synchronously reject duplicate picker/copy requests, clear stale document results, report unchanged originals and use Pause/Continue clip wording; lifecycle, cancellation, retry and terminology tests.
- `src/components/ai-edition/recordingReviewNavigation.ts`, `NewEditorShell.tsx`, `RecordingReviewToolbar.tsx`: prevent Record/library/File/Open and delayed picker results from replacing a document while its source handoff is pending; navigation and toolbar regression tests.
- `src/components/launch/HudDeviceSettings.tsx`, `LaunchWindow.tsx`, `src/lib/recording/recordingQuality.ts`, `electron/recording/recordingPrefsStore.ts`: expose High/Standard before capture, default High and persist explicit choices across launch; setup and preference regressions.
- `src/lib/recording/capturePolicy.ts`, `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/CaptureSetup.swift`: preserve the actual historical UI request of 68 Mbps in Standard and double it to 136 Mbps in High; policy and real native geometry/encoder tests (18 Mbps was only the helper's missing-request fallback).
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingCadence.swift`, `ScreenCaptureRecorder.swift`, `RecordingFrameCache.swift`: drive High screen output on an exact host-clock 60 Hz interior grid, count repeated source frames separately and fail sustained writer lag loudly; native cadence, jitter, backpressure and reanchor regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingCadence.swift`, `RecordingFrameCache.swift`, `ClosingFrameAppender.swift`, `ScreenCaptureRecorder.swift`: complete the remaining High frame grid through the frozen Pause/Stop boundary with one partial final interval and bounded appends; actual encoded-grid, delayed-teardown and oversized-backlog regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingWriterFinalization.swift`, `ScreenCaptureRecorder.swift`: flush buffered compatibility audio before ending High's session and marking inputs finished; regression reproduces error -11862 and verifies clean encoded initial/resumed clips with three audio tracks and all separate originals.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/ScreenCaptureRecorder.swift`, `RecordingCadence.swift`: retain the earliest detected terminal-failure boundary despite delayed or reordered callbacks so automatic Stop cannot extend failed capture; failure-epoch and reordered-audio-callback regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/ScreenCaptureRecorder.swift`, `OriginalTrackWriter.swift`: prepare all enabled writers before the capture epoch and choose Continue’s seed time after setup, preserving actual first-sample offsets and readiness; delayed-preparation, missing-source cleanup and encoded-offset regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/CompatibilityAudioWriter.swift`, `ScreenCaptureRecorder.swift`, `RecordingWriterFinalization.swift`: move compatibility PCM decode/mix/three-AAC appends off the video queue, bound queued/in-flight raw samples and bytes, preserve source times and drain/flush before the frozen session end; actual blocked-AAC/encoded-grid/gain, overflow, Pause/drain and stale-callback regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingStartup.swift`, `ScreenCaptureRecorder.swift`, `RecordingCadence.swift`: confirm recording only after actual enabled original/AAC appends and a caught-up High grid, preserve the first epoch/frame and bound startup separately from live lag; encoded 185 ms backpressure, readiness/phase transition, 1.06-second camera, and independent missing-microphone timeout/cancellation regressions in `RecordingStartupTests.swift` and `NativeCaptureQualityTests.swift`.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingFrameCache.swift`: retain capture timestamps separately from output timestamps and keep future pixels out of historical grid slots; pixel identity/provenance regressions in `RecordingFrameCacheTests.swift` and an actual encoded dark/bright-frame startup test.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingStreamRecovery.swift`, `ScreenCaptureRecorder.swift`: preserve paused sessions after source loss, replace stopped streams on valid reselection, ignore stale/stopping callbacks and acknowledge safe Continue rejection only after rollback; native identity/state/replacement and previous-versus-new-clip acknowledgment regressions in `RecordingStreamRecoveryTests.swift`.
- `electron/recording/nativeMacHelperClient.ts`, `nativeMacRecordingService.ts`: distinguish an explicitly rolled-back paused Continue from timeout, dead helper or active writer failure; six client/service regressions verify operation-scoped rejection, unchanged committed bytes/journal, reselection retry and retained fatal recovery.
- `electron/recording/nativeMacHelperClient.ts`, `nativeMacRecordingService.ts`: clear rejected-attempt source deduplication and provisional recovery metadata using the acknowledged attempted clip index, serialize journal rollback and retain fatal write-failure handling; missing/negative/fractional index and original-started-before-rejection camera-disabled/new-offset retry regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/ScreenCaptureRecorder.swift`, `RecordingStreamRecovery.swift`: correlate safe rejection with the attempted clip index, atomically check source availability before activation and reject queued metadata from cancelled source owners; real encoded-camera cancellation in `NativeCaptureQualityTests.swift` and exact previous/new acknowledgment regressions in `RecordingStreamRecoveryTests.swift`.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/AudioTrackMixer.swift`: report false AAC appends even while writer status is still writing, retain the owner's detection time and surface finish failures; rejected-append, delayed earliest-failure and finalization regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/OriginalSourceWriter.swift`, `OriginalTrackWriter.swift`, `ScreenCaptureRecorder.swift`: isolate camera and standalone audio appends from the video queue, bound queued/in-flight samples and retained bytes, drain before finalization and retain original callback identity/failure time; blocked-AAC/camera, offset, overflow, Stop/drain and stale-callback regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/NativeCameraCapture.swift`, `OriginalTrackWriter.swift`, `src/hooks/useScreenRecorder.ts`, `useCameraPreviewStream.ts`, `src/lib/webcamFormats.ts`: capture a native-resolution H.264 MOV camera original alongside preview, with independent AAC microphone/system MOV originals and measured offsets; supported-format, opaque-ID, real encode, audio-origin and unfinished-fragment tests.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/ScreenCaptureRecorder.swift`: gate Start/Continue on actual screen and enabled camera appends and finalize sidecars despite screen-writer failure; readiness, missing-source and cancelled-writer regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/CaptureSetup.swift`: roll back screen filter, camera and configuration independently after failed paused reconfiguration; regression proves all rollback attempts run even when one fails.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/NativeCameraCapture.swift`: match Chromium's trailing VID:PID camera-label suffix to one native camera while preserving exact-ID priority and rejecting ambiguity; actual built-in-camera failure receipt and native collision/parenthesis regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/NativeCameraCapture.swift`: clamp camera frame duration to exact supported rational bounds instead of rounding slightly above the 30 fps limit; actual startup-failure receipt and native 15/30/60/29.97 fps boundary regressions.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/NativeCameraCapture.swift`: apply the native format after input/output negotiation and verify active-device and delivered-buffer pixels so the session preset cannot silently change or resize capture; real preset-reset diagnostic and native scaled-output rejection regression.
- `src/components/launch/HudDeviceSettings.tsx`, `LaunchWindow.module.css`: keep quality text readable at rest/hover and native-camera text readable on the dark panel; High no longer promises preview dimensions as its recording format; setup regression and actual browser contrast checks.
- `src/components/launch/useRecordingHudPresentation.ts`, `LaunchWindow.tsx`, `HudControls.tsx`: preserve the last timer, history and chosen panel size through Save, keep its transport width fixed and disable size changes during finalization; three reproduced regressions and actual compact/expanded Save proofs.
- `src/components/launch/LaunchWindow.module.css`: fit the two-row panel and use a distinct expanded animation with hidden controls during width growth, preserving reduced motion and rapid reversal; 72 targeted tests and actual visible-clipping frames reduced from nine to zero.
- `electron/recording/nativeMacHelperClient.ts`, `nativeMacRecordingService.ts`, `nativeMacRecoveryJournal.ts`: journal early original paths and first-sample offsets, preserve readable owned sources after helper failure, reject invalid/symlink sources and surface recovery warnings; client, service and recovery regressions plus real fragmented-audio XCTest.
- `electron/recording/nativeMacRecordingService.ts`: freeze original events after helper termination, drain late metadata before recovery and serialize final journal save/discard cleanup; controlled deferred-write regressions cover normal Stop, failed Stop, discard and failed startup.
- `electron/recording/nativeMacRecordingService.ts`: reattach validated readable original fragments after failed sidecar finalization without changing a committed screen clip's duration; failure/recovery regression.
- `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/CaptureTelemetry.swift`, `electron/recording/nativeMacHelperClient.ts`: report validated source/output/repeated/drop/queue counters through IPC rather than stripping optional metrics; native and parser regressions.
- `src/lib/ai-edition/schema/index.ts`, `src/components/ai-edition/recordingImport.ts`, `src/lib/recordingSession.ts`, `electron/ipc/handlers.ts`: carry original source paths and finite measured sync offsets through session acknowledgments, saved projects and import; schema, import and native-ack regressions.
- `src/i18n/locales/*/launch.json`: matching recording-quality/native-camera keys across all 13 dictionaries; i18n validation (English fallback for new labels).
- `scripts/overnight-recording-profile.mjs`, `source-quality-profile-utils.mjs`: drive real four-source recording on a seeded moving-detail fixture, time the actual source-export UI, require complete readable byte-identical files and reject incomplete comparison evidence, including a truncated camera/audio sidecar; profiling utility regressions.
- `scripts/source-quality-profile-utils.mjs`, `overnight-recording-profile.mjs`: reject recovery warnings and provisional clips as normal Stop acceptance while retaining a separate intentional-helper-crash proof; clean-Stop evidence regressions.
- `scripts/source-quality-profile-utils.mjs`, `overnight-recording-profile.mjs`: preserve production helper warning events through the real diagnostic serializer after timed work ends, with timing diagnostics disabled; warning-parser regression.
- `scripts/source-quality-profile-utils.mjs`, `overnight-recording-profile.mjs`: launch the tone fixture through LaunchServices in a private Chrome profile and clean up its exact owned executable/profile despite reparenting; launch/ownership regressions and real cleanup receipt.
- `scripts/overnight-recording-profile-utils.mjs`, `overnight-recording-profile.mjs`: use the guarded private source-profile directory for LaunchServices One video verification too; ownership regression preserves the exact executable/profile boundary rather than weakening it.
- `scripts/overnight-recording-profile-utils.mjs`, `overnight-recording-profile.mjs`: wait for the visible export dialog, choose One video and activate its picker explicitly while retaining legacy automatic-picker verification; delayed-dialog and compatibility regressions in `overnight-recording-profile.test.mjs`.
- `scripts/source-quality-profile-utils.mjs`, `overnight-recording-profile.mjs`: require decoded system-audio samples, finite RMS/peak and a matching original-file SHA rather than accepting a silent fixture; silent/missing-signal regressions and independent known-tone recording.
- `scripts/source-quality-profile-utils.mjs`, `overnight-recording-profile.mjs`: sample only the exact owned development helper for one second after a diagnostic capture failure; ownership regression rejects installed, unrelated and ambiguous helpers.
- `electron/native-bridge/services/compositorViewService.test.ts`: register the fake renderer’s cancellation handler synchronously like the native add-on, preventing cancellation before async test setup from leaving its promise pending; all 42 affected export-transaction tests pass, with cancellation, old-file preservation and staging-cleanup assertions retained.
- `scripts/analyze-source-quality-profile.mjs`: report requested/measured bitrate, packet cadence, encoded 60 Hz grid, decoded repeated frames, camera pixels, process CPU and file sizes; cadence and duplicate-analysis regressions.
- `scripts/source-quality-ui-smoke.mjs`: verify remembered output/quality choices, actual rest/hover contrast, cancellation/retry, source-copy navigation locks, playback and desktop/narrow layouts; rendered-state checks and known-color contrast regressions.
- `scripts/source-quality-ui-smoke.mjs`, `source-quality-profile-utils.mjs`: execute CLI smoke commands asynchronously so the same Playwright controller can resume newly attached editor windows; a real local child/broker event-loop regression in `source-quality-profile.test.mjs` covers the observed verification deadlock.
- `scripts/verify-source-handoff-resolve.py`, `scripts/source-quality-profile-utils.mjs`: inspect actual imported four-track positions, source starts/ends in seconds, media frame rates and relative moved-folder links in new owned Resolve projects; wrong-speed/out-point and import-expectation regressions.
- `scripts/source-quality-profile-utils.mjs`: require the measured Resolve timeline rate to equal OTIO's rate; missing, nonfinite and 24-versus-60 rate regressions prevent false import acceptance.
- `AGENTS.md`, `PRODUCT_PLAN.md`, `technical-documentation/product-behavior.md`: record High capture and untouched separate sources as the active default; old editing behavior remains compatibility documentation.

Latest completed code checks: `npm test` passed 4,095 tests in 377 files with one
existing skip; `npm run lint`, `npm run wb:typecheck`, app/test TypeScript, i18n and document
checks exited zero. Lint retains two existing warnings. Fifty-three Swift tests and the refreshed full native directory build passed without compiler
warnings. [Gate receipt](../artifacts/source-quality-2026-10-03/checks/required-gates.json)
and [native receipt](../artifacts/source-quality-2026-10-03/checks/recording-verification.json).
The post-native full suite exposed the cancellation mock race described above. Its failure log
is preserved; all 42 affected tests and the fresh exact full suite pass after correction. The
post-cancellation full suite took 40.93 seconds. After the native startup fix, the fresh exact
full suite took 29.06 seconds. After the paused-source and metadata-rollback fixes, the fresh
exact suite took 29.82 seconds. The final harness regressions bring the suite to 4,094 passing
tests in 29.54 seconds. After the same-event-loop CLI smoke regression, the final suite
passed 4,095 tests in 29.62 seconds; all seven current gates exited zero on helper `0b6f9c64`
and app bootstrap `48cf7006`.

Historical paired capture/export timings passed on helper `5879c070`, but their system-audio
sources were silent and are not accepted as four-source proof. The final audible pair on
`0b6f9c64` / `48cf7006` passes below; Owned Resolve verification also passed below; follow-up acceptance is complete.

Audible-source diagnostics preserved several rejected runs. The first isolated High lag/30-second
Stop case was initially unreproduced by three instrumented healthy recordings. A later observed
High retry failed before writer readiness while the Chrome fixture stayed alive. Its immediate
instrumented repeat measured 173.47 ms of compatibility system-audio ingestion on the video
sample queue, followed by 205.71 ms of cadence lag while the video input was ready. This proves a
blocking ingestion stage; the one-second sampler had an empty call graph and does not identify
an internal AVFoundation stack. A bounded independent compatibility-audio owner and ordered
drain/finalization now pass 44 native tests, including a real blocked-AAC/encoded-video proof.
The compatibility owner removed the inline stage, but its next real High preflight still
failed: 159.44 ms of owner work coincided with ten video-backpressure events, while the first
recording acknowledgment preceded all microphone/AAC readiness. The sampled call graph was
again empty; shared-writer internal locking is an inference, not established stack evidence.
An explicit bounded startup phase now retains the first screen epoch and
pixels, wait for actual enabled-source and AAC appends plus a caught-up grid, bound High startup
video backlog to one second, and fail missing source readiness after two seconds. The live
133 ms limit applies permanently after the truthful acknowledgment. Historical slots must not
use pixels from a future source timestamp. All 49 native tests pass, including the encoded
185 ms startup case and independent two-second missing-source timer. The refreshed native
directory build passed without warnings on helper `300aec91`, and fresh JS gates passed.
Both final same-helper Standard/High captures now pass the duration, cadence, audio,
normal-Stop and byte-copy guards; Owned Resolve verification passed below.
The fresh startup review found no actionable code issues and verified unchanged source/test
hashes. Its encoded regression uses real codecs and a delayed AAC append, but models video
backpressure by withholding appends; it does not exercise the full recorder callback/timer
glue. The real High preflight on `300aec91` then passed: 1,015.3 ms to recording,
240.4 ms clean Stop, 470.7 ms for four byte-identical readable source copies and positive
system-audio PCM. All 506 video packets followed the 60 Hz interior grid. The final
two-minute pair subsequently passed below; owned Resolve verification passed below.

The October 3 compact-panel correction passed an actual development-app comparison: Save
retains the selected 256 px compact or 832 px expanded layout, an 86 px disabled transport
and frozen timer. Visible expansion clipping fell from nine frames to zero. Real
Pause/Continue, rapid reversal and reduced motion passed; the installed app is unchanged.
[Desktop receipt](../artifacts/source-quality-2026-10-03/hud-layout/result.json) records
screenshots, 72 targeted tests, the current app build and primary contracts.

The real paused-source recovery check on `0b6f9c64` / `48cf7006` passed: closing the selected
window after Pause rejects Continue while keeping the session paused, valid reselection
starts capture again, and immediate Pause/Stop preserves all three clips. Twelve complete
originals remained readable and SHA-identical through a 1,099.8 ms GUI handoff. The shortest
clip was 780 ms. The expected source-unavailable warning stayed recoverable; no fatal or
automatic Stop occurred. [Desktop receipt](../artifacts/source-quality-2026-10-03/smoke-pause-source-failure-0b6f9c/report.json).

The final owned-helper SIGKILL recovery check preserved four readable byte-identical fragmented
originals and exported them through the GUI in 622.8 ms, with visible failure/recovery.
Removal back to zero followed by Pause/Continue and immediate Stop preserved eight readable
unchanged originals; source handoff took 746.2 ms, including a subsecond screen clip.
[Crash receipt](../artifacts/source-quality-2026-10-03/smoke-four-source-recovery-final-0b6f9c/report.json)
and [remove/continue receipt](../artifacts/source-quality-2026-10-03/smoke-remove-zero-final-0b6f9c/report.json)
both record the final `0b6f9c64` helper.

One video remains functional: actual UI export produced a 5.333-second H.264/AAC MP4 in
4,656.4 ms; all 320 video frames decoded and a fresh development-app import played forward.
Decoded head/tail stills show changing screen content and the camera composite. Two native
picker cancellations and the 400 px review layout passed. The original harness report remains
failed: it sampled the dialog before it appeared and later expected an obsolete automatic
picker. Actual UI clicks and the separate playback receipt prove the saved file; three
profiler regressions fix those verification errors without changing product code.
[One video proof](../artifacts/source-quality-2026-10-03/smoke-one-video-playback-final-0b6f9c/one-video-proof.json).

The final UI/CLI smoke passed remembered High, fresh Separate takes, remembered One video
across reopen/restart, cancel/retry, and actual toolbar/native-menu navigation locks while
the source picker is held. Playback advanced and reached the 120.29-second tail; 400 px
layout had no overflow and the console had no errors. Supported guarded CLI operations on
an owned clone removed 2–4 and 7–9 seconds; GUI source export carries three retained segments
on each of four OTIO tracks while keeping complete originals and the original document unchanged.
[Current UI/cut receipt](../artifacts/source-quality-2026-10-03/high-audible-final-0b6f9c/ui-smoke-final/report.json).

Resolve Studio 21.1.0.17 imported full, cut, multi-clip and moved-folder OTIO in one new owned
verification project. All strict guards passed: V1 Screen, V2 Camera, A1 Microphone, A2 System
audio, 60 fps timelines, exact timeline gaps/trim positions and source starts/ends checked
against each media rate, including the camera's actual 30 fps. The cut and moved timelines
have three retained segments on every track; moved references resolve inside the Unicode
folder with spaces. Moved-folder playback advanced from 00:00:01:00 to 00:00:30:06 using native Play/Stop.
Full head/tail screenshots show readable media. After the owned project was saved and Resolve
quit, all eight original media files and all three existing saved project databases retained
their SHA-256 and byte lengths; all four moved media copies also match their originals.
[Full](../artifacts/source-quality-2026-10-03/resolve-final-0b6f9c/full-verification.json),
[cut](../artifacts/source-quality-2026-10-03/resolve-final-0b6f9c/cut-verification.json),
[multi-clip](../artifacts/source-quality-2026-10-03/resolve-final-0b6f9c/multi-verification.json),
and [moved-folder](../artifacts/source-quality-2026-10-03/resolve-final-0b6f9c/moved-verification.json) receipts.
[Playback](../artifacts/source-quality-2026-10-03/resolve-final-0b6f9c/playback.json),
[media protection](../artifacts/source-quality-2026-10-03/resolve-final-0b6f9c/media-protection.json),
and [existing project protection](../artifacts/source-quality-2026-10-03/resolve-final-0b6f9c/original-project-protection.json).

The final matched pair uses the same seeded moving-screen fixture, native
2564 × 1692 screen pixels and frozen helper `0b6f9c64` / app `48cf7006`, with timing diagnostics disabled.
Both runs have a clean actual native Stop, no audited warning/fatal events, and four readable
byte-identical exported originals. Decoded system-audio RMS is 0.039852 / 0.039836; all eight
source files exceed 120 seconds. [Guarded comparison](../artifacts/source-quality-2026-10-03/quality-comparison-audible-final-0b6f9c.json)
links both immutable reports and before/after source hashes.
The actual failed-source retry and this pair both use the final recovery fixes.
The earlier successful `300aec91` pair remains separate historical evidence.

| Measured quantity | Standard | High |
| --- | ---: | ---: |
| Screen duration | 120.306667 s | 120.301667 s |
| Screen bitrate requested / measured | 68 / 68.127254 Mbps | 136 / 136.345974 Mbps |
| Encoded screen frames / actual output rate | 6,874 / 57.137316 fps | 7,219 / 60.007481 fps |
| Complete source updates per second | 57.137157 | 59.924191 |
| Writer-dropped screen / camera samples | 0 / 0 | 0 / 0 |
| Native repeated-source frame count | 0 | 12 |
| Screen file bytes | 1,035,358,874 | 2,061,403,585 |
| Camera source pixels / measured rate | 1920 × 1080 / 30.004574 fps | 1552 × 1552 / 29.996673 fps |
| Camera file bytes | 29,728,954 | 127,738,565 |
| Mean owned-process CPU / native child | 45.991% / 24.761% | 50.489% / 26.162% |
| Mean owned-process RSS | 852.4 MiB | 974.8 MiB |
| Click to actual recording | 853.9 ms | 720.2 ms |
| Native Stop / visible review | 239.2 / 1332.1 ms | 247.9 / 1580.4 ms |
| Four-source export through actual UI | 740.8 ms | 1,491.8 ms |

CPU is sampled process `%cpu`; 100% represents one core. Chrome's fixture and Resolve are
excluded. The whole-preset comparison includes intentional camera-format and bitrate changes;
it does not attribute all CPU differences to the screen encoder. High has zero interior
60 Hz packet-grid violations. Output fps is encoded frame count divided by file duration;
source cadence and scheduled pixel reuse are separate quantities. Native repeats count source
sample identity; decoded pixel-duplicate analysis follows the timed captures. Zero writer drops
does not prove every display update was delivered or used. These are local SSD GUI timings;
hash and decode checks occur after the export timer.

The camera records a live room rather than the seeded screen fixture. Its scene pixels differ
between runs, so camera file-size differences cannot be attributed entirely to the preset.

Compact receipts, scripts, logs and selected proof images are committed. Large original media
and unused diagnostic screenshots remain local. Raw logs retain their original whitespace;
source/document whitespace checks are separate from those verbatim forensic outputs.

Full bounded software decode completed after the timing runs: Standard/High screen decoded
6,874/7,219 frames and camera decoded 3,608/3,606 frames. Screen adjacent exact-pixel duplicates
were zero in both; High camera had two. Native High repeats remain twelve because source
identity reuse and lossy decoded-pixel equality are different measurements; unique decoded
hashes do not prove unique captured content. High screen has zero 60 Hz packet-grid violations.
[Decoded comparison](../artifacts/source-quality-2026-10-03/decoded-quality-comparison-final-0b6f9c.json)
links full per-role analysis and decoded head/tail stills.

The [old comparison](../artifacts/source-quality-2026-10-03/quality-comparison.json) on
`5879c070` remains historical: copies were readable and byte-identical, but both system-audio
originals were silent. It is excluded from final four-source acceptance. Earlier preflight
and failed-capture reports remain immutable, including the `72dae20b` fragmented-file recovery
after error -11862 and the later rejected `8d132cf1` startup run. Current `0b6f9c64` passed both
normal two-minute Stops. All final smoke checks, decoded analysis and owned Resolve proof passed.

Primary contracts: [React refs](https://react.dev/reference/react/useRef) keep the source-copy
lock visible to menu/keyboard callbacks before a render; state separately updates controls.
[Node 22.22.1 child processes](https://nodejs.org/download/release/v22.22.1/docs/api/child_process.html)
confirms synchronous child waits block the controller's event loop. The CLI smoke must await
asynchronous execution so Playwright can resume newly attached renderer pages.
[OTIO file format](https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-file-format-specification.html)
owns source cuts, offsets, gaps and relative media references; the media files remain complete.
Pinned [FFmpeg Matroska writing](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavformat/matroskaenc.c#L2893),
[Matroska reading](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavformat/matroskadec.c#L3183)
and [MOV reading](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavformat/mov.c#L1805)
explain why positive timestamp origins need container-specific duration handling.

[Apple movie fragments](https://developer.apple.com/documentation/avfoundation/avassetwriter/moviefragmentinterval)
permit playback of partially written QuickTime movies; camera and standalone AAC sources use
fragmented MOV rather than assuming that M4A supports this recovery contract.
[ScreenCaptureKit minimum interval](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/minimumframeinterval)
throttles incoming updates; the separate output clock and packet timestamps establish High's
constant cadence. [Average bitrate](https://developer.apple.com/documentation/avfoundation/avvideoaveragebitratekey)
is an encoder request, so the measured stream bitrate is reported separately.
[Camera active format](https://developer.apple.com/documentation/avfoundation/avcapturedevice/activeformat)
requires supported formats and coordinated format/frame-duration configuration.
[Chromium camera descriptors](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/capture/video/video_capture_device_descriptor.cc)
append the device model in parentheses; [Mac UVC model IDs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/capture/video/mac/uvc_control_mac.mm)
use a four-digit vendor/product pair. Normalize only that suffix and require a unique native
name match; unavailable or duplicate explicit cameras never fall back silently.

[Apple exact camera frame duration](https://developer.apple.com/documentation/avfoundation/avcapturedevice/activevideominframeduration)
and [advertised rational bounds](https://developer.apple.com/documentation/avfoundation/avframeraterange/minframeduration)
prevent a rounded duration from exceeding a supported endpoint.
[Chromium AVFoundation setup](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/capture/video/apple/video_capture_device_avfoundation.mm)
configures output geometry and reapplies the device format after input/output negotiation.
[Apple writer endSession](https://developer.apple.com/documentation/avfoundation/avassetwriter/endsession(atsourcetime:))
ends at the frozen capture boundary; the encoded-grid regression verifies the resulting packets
and duration after delayed Stop and teardown. The first terminal failure boundary remains frozen
even if recovery Stop arrives later. All buffered compatibility-audio appends finish before
endSession; ending first reproduced Apple's -11862 append-after-session error on real High Stop.

[Apple startWriting](https://developer.apple.com/documentation/avfoundation/avassetwriter/startwriting%28%29)
prepares a writer independently of startSession. Prepare each enabled encoder before accepting
the first capture sample; its actual timestamp still anchors the session. The actual failing trace
showed 243 ms of preparation turning a fresh source frame into a 331 ms startup backlog.

[Apple input readiness](https://developer.apple.com/documentation/avfoundation/avassetwriterinput/isreadyformoremediadata)
can temporarily be false for every interleaved input. [Session start mapping](https://developer.apple.com/documentation/avfoundation/avassetwriter/startsession(atsourcetime:))
preserves source-time offsets and late-track synchronization. Keep that first epoch and wait
for actual enabled-source/AAC appends and a caught-up grid before recording confirmation;
the one-second backlog and two-second readiness bounds are local policy, not Apple guarantees.

Current-platform research also checked Apple’s [ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos),
which gives screen, system audio and microphone separate callback queues.
[finishWriting](https://developer.apple.com/documentation/avfoundation/avassetwriter/finishwriting%28completionhandler%3A%29)
requires all append calls to return before finalization. The newer
[async SampleBufferReceiver](https://developer.apple.com/documentation/avfoundation/avassetwriterinput/samplebufferreceiver/append%28_%3A%29)
starts at macOS 26; a wholesale switch would add a second writer implementation for the existing
macOS 13 baseline. The targeted audio-owner fix preserves that baseline. Real short captures have passed;
the final audible two-minute acceptance pair passed. [Dated research receipt](../artifacts/source-quality-2026-10-03/checks/current-primary-research.json).

For the panel fix, the current [CSSWG animation model](https://drafts.csswg.org/css-animations-1/#animations)
describes retaining playback time when animation names match. Actual `getAnimations()` showed
the reused compact row's animation already finished when expansion began; a distinct expanded
name restarts its hidden delay, and reduced motion removes it. This primary draft and the
real rendered proof falsified the earlier assumption that changing timing would restart it.

Follow-up limits (not fixed or not verified, with reasons):

- One video legacy success footer still says Keep editing: retained compatibility copy, with no editor feature added. The recording workflow itself returns to review; broader old-editor wording is deferred outside this capture/export acceptance.
- Resolve API reads during playback timed out; native Play/Stop state and the stopped timecode prove real advancement instead. No Resolve implementation was changed.

- Resolve 21.1's repeated same-basename OTIO import in one project returned an existing timeline despite the requested import name. Verification used byte-identical OTIO copies with unique filenames, preserving content and media. This importer behavior is outside Klippt; the untouched `timeline.otio` imported successfully into the new project, and no Resolve code or existing project was modified.
- The original isolated 30-second Stop timeout: no stall stack was captured, so its precise cause remains unproven. Later High lag was traced to blocking compatibility-audio ingestion; the separate owner and bounded truthful startup now pass native regressions and both real two-minute captures. The live guard remains strict; these runs do not establish a universal fix for unexplained OS or shared-writer stalls.
- ScreenCaptureKit's isolated -3805 application-connection interruption before the final Standard run became ready: retained as a failed diagnostic and excluded from timing evidence. Static review found no proven product lifetime bug; an independent observed Standard repeat completed cleanly. The first failed run had no fixture-liveness observer, so its cause remains unproven.
- HEVC: not selected. High doubles the actual historical H.264 request from 68 to 136 Mbps while retaining existing decode/interchange compatibility; measured bitrate is reported separately from the requested rate.
- Sixty unique captured pictures per second: not promised. High outputs an exact 60 Hz timestamp grid, and reports source updates and repeated source samples separately.
- Five-, thirty- and sixty-minute capture soaks and Windows/Linux desktop behavior: not performed in this follow-up; the requested desktop acceptance is two minutes on this Mac.
- Newly added non-English labels: matching keys use English fallback; translation quality remains unverified.
- Installed app, release packaging/signing/update feeds and remote pushes: excluded by Olle's explicit constraints. Existing Resolve projects remain protected; only new owned interchange-verification projects are authorized.
