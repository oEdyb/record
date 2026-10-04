# Capture readiness and interruption review — October 4, 2026

Baseline: local main `bf10edff`, containing the prior recording work and creator-loop UI.
Implementation branch: `codex/capture-readiness-2026-10-04`.

## Observed failures and scope

A recovered native recording reached review with an ordinary success toast. Its capture
failure reason existed only in the closed HUD. The fix persists capture interruptions in
the recording manifest, recovery journal and saved project. Review displays a persistent
notice, expandable reason and Record again action. Original-file recovery remains available
with expired access. Removing the affected recording removes the notice; restoring it restores
the notice. No new editing feature or capture quality relaxation is included.

Fatal callbacks and final-clip Stop warnings both populate interruption metadata. The import
commits it atomically with clips before consuming the handoff; retries preserve it. Existing
projects without metadata are unchanged. Session normalization validates bounded strings.

Independent review found and resolved issues including: Space on the new disclosure must retain
native keyboard behavior, and final-clip warnings without a fatal callback must also persist.

## Primary sources and decisions

- [Apple sample handler queues](https://developer.apple.com/documentation/screencapturekit/scstream/addstreamoutput(_:type:samplehandlerqueue:)):
  callback timing and writer readiness are distinct. Optional diagnostic telemetry records
  first input and first enqueue separately from the existing first successful append.
- [Apple microphone selection](https://developer.apple.com/documentation/ScreenCaptureKit/SCStreamConfiguration/microphoneCaptureDeviceID):
  the default microphone remains selected when no explicit device is configured. Diagnostics
  now record the configured identifier and current AVFoundation default candidate. This does
  not prove which hardware ultimately delivered a callback or change device selection.
- [Native HTML disclosure](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details):
  use details/summary for the reason, preserve Space activation and visible keyboard focus.

## Native evidence

Under `artifacts/capture-readiness-2026-10-04/`:

- `instrumented/report.json`: six-second High recording with screen, camera, microphone and
  system audio passed; two Pause/Continue cycles, paused Stop, all four source copies hash-match
  and audio fixture tone verification passed. Record readiness 1,469.3 ms; Stop-to-review
  3,893.6 ms; source handoff 1,890.5 ms. These are observations, not a controlled speed comparison.
- `sustained/report.json`: requested five-minute High four-source recording failed at about
  239 seconds in its third clip. Lag was 220.22 ms with screen input ready and zero writer/original
  backpressure or append failures. Recorded append maxima were below that lag; the cause remains
  unproven. No five-minute acceptance is claimed.
- The fatal sampler's receipt references an absent output file. It is not a successful stack
  collection. Queue scheduling, uninstrumented work and diagnostic output are hypotheses only.
- The complete native platform rebuild passed. Optional first-input diagnostic fields do not
  change recording settings, writer readiness or the existing quality contract.

## Recovery acceptance

- `interruption-live/report.json` initially failed: a third screen fragment had no MP4 moov
  header (confirmed with ffprobe), preventing the two committed clips from importing.
  The five-second renderer probe had failed, but retained handoff state left Preparing visible.
- Recovery now checks provisional screen headers with the existing bounded inspector.
  Only a positively identified missing moov header is excluded from playable clips. Its
  file and path remain intact. Unknown/time-out/unavailable inspection results retain the
  provisional clip for the renderer's independent probe and explicit guarded retry.
- Exclusion and uncertain-inspection warnings survive normalization and whole-app restart.
  This follows [FFmpeg's fragmentation contract](https://ffmpeg.org/ffmpeg-formats.html#Fragmentation):
  recoverability depends on written container structures, not nonzero byte size.
- `interruption-verified/report.json`: actual owned-helper SIGKILL recovered both committed
  clips, showed the persistent notice after reload, and exported all retained screen,
  camera, microphone and system originals unchanged. Stop-to-review 3,699.2 ms, including
  the deliberate reload/assertions in this harness; source export 800.6 ms.
- `ui-interruption/` verified 400px interruption layout and Space disclosure before a later
  test-hook failure. `ui-final/report.json` passed the corrected injected import
  failure and successful retry, wide/narrow library states and three Record-again returns;
  zero renderer errors. Screenshots inspected. The test hook failure was an incorrect
  bridge action name, not a production failure.
- `sustained-normal/report.json` failed the same 133 ms cadence contract with diagnostics
  off. Logging is not the sole explanation. Sustained four-source capture is still unverified.

## Final code checks

Full suite: 378 files, 4,118 passed and one existing skip. The test count includes recovery
header validation, unknown-probe retry preservation, session/project persistence, final-clip
warnings and disclosure keyboard handling. Exact commands/results are in `final-checks-2/`.
The native isolated wrapper passed 53 tests; production renderer/main/preload build passed.
Independent final review found no remaining actionable issues in this slice.

## Remaining acceptance

Investigate the native queue stall before changing capture scheduling. Packaging still
requires fresh, clean-source Whisper provenance; do not refresh an unrelated stale manifest
or weaken the packaging guard. Installed app, user projects and remote branches are untouched.
