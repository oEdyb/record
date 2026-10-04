# Capture timer scheduling — October 4

The creator loop and crash recovery are merged locally through `ccc12867`. This slice
investigates the sustained High four-source capture failure without changing frame-rate,
bitrate, the 133 ms live backlog limit, or original-source preservation.

## Evidence before the activity change

`artifacts/capture-queue-2026-10-04/measured/report.json` failed the requested five-minute
recording in its third clip at about 156 seconds. The native diagnostic records:

- Cadence timer entry gap 167.24 ms; unwritten backlog 153.38 ms; screen input ready.
- Previous timer callback took 0.201 ms. Maximum timer callback was 39.30 ms, 62 seconds earlier.
- Latest screen callback took 0.035 ms and ended 0.12 ms before the failing timer.
- Latest screen pixels were 11.67 ms old. Maximum source age was 106.03 ms shortly before failure.
- State-lock maxima stayed below 10 ms. No writer/original backpressure or append failures.

The saved sampler file has zero call-graph entries. Its receipt and binary image list are
not evidence of where a thread blocked. The observations establish late timer execution;
they do not distinguish scheduling delay, accumulated callback work or unmeasured blocking.
The exact diagnostic-only patch used for this run is `measurement-only.patch` in the artifact
root. Diagnostics aggregate a bounded set of metrics in memory instead of serializing and
flushing output on every slow callback. Timing now covers whole callbacks, state waits,
retiming, admission and owner-completion queue delay.

## Contract and experiment

[Apple ProcessInfo](https://developer.apple.com/documentation/Foundation/ProcessInfo)
recommends `latencyCritical` for high-priority I/O such as audio/video recording.
[Activity lifetime](https://developer.apple.com/documentation/foundation/processinfo/beginactivity(options:reason:))
is explicitly bounded to the work. The helper previously declared no such activity.

The helper now acquires `.userInitiated` and `.latencyCritical` during Start/Continue and
active recording. Pause/Stop owns an independent finalization lease, so a concurrent capture
failure cannot release saving's protection. Start/Continue errors and terminal capture
failures release recording ownership. The last lease ends the activity; abandoned leases
also release their ownership. Idle/paused operation retains no recording activity.

This is an isolated activity experiment, not proof that queue QoS caused the observed gap.
The queue QoS, encoder configuration and failure threshold remain unchanged.

## Verification in progress

All 56 native tests passed, including overlapping capture/finalization, repeated releases,
Pause/Continue token renewal and abandoned-lease cleanup. The complete native platform
rebuild passed. Independent lifecycle/concurrency review found no actionable findings.
The live process's named recording activity was observed through `pmset -g assertions`.
The five-minute High four-source test passed (`activity/report.json`): two Pause/Continue
cycles, paused Stop, 12 byte-identical originals and per-source decode probes. Record readiness
859.4 ms, Stop-to-review 2,258.9 ms, source handoff 3,796.9 ms. No native fatal event.
The third clip spans 294.457 seconds; the shorter two clips exercise restart boundaries.
This is one successful run, not proof of causality or 30/60-minute acceptance.
All eight repository gates passed (`checks/summary.json`): 4,118 tests passed, one existing
skip; app/test/workbench TypeScript, lint, i18n, design and document checks passed.
All 12 source files passed full-duration decoding. The initial two-thread software decode
of the long screen file exceeded the test's 300-second timeout without reporting corrupt
frames; a subsequent VideoToolbox decode completed cleanly with a longer bound. One null-muxer
camera warning was caused by output time-base rounding: source PTS/DTS are strictly increasing,
and full decoding with the demux time base and passthrough timing produced no error.
Receipts: `activity/full-decode*.json` and `activity/camera-*.json`. Independent receipt
coverage verified all 12 exports. Fresh packet checks on all three screen files found zero
60 Hz grid violations; the long screen has 17,668 packets through 294.45 seconds.
`activity/all-screen-cadence.json` contains exact commands and coverage.

The successful recording's maximum timer-entry gap was 93.46 ms and maximum timer callback
5.51 ms. This is an observation, not an isolated proof of why the earlier run failed.

## Signed local packaging and desktop smoke

Clean-source packaging at `f55ccd0c` completed with fresh verified Whisper provenance.
The standard build exposed a Parakeet staging incompatibility: current Swift emits into
`out/Products/Release`, while the script expects the legacy triple/release directory.
The exact executable reported by `swift build --show-bin-path` was staged separately;
`parakeet-stage.json` records matching hashes. Packaging scripts and guards are unchanged.
The official Electron installer restored the exact pinned runtime assets before the final build.

The final local DMG is signed with Dyberg Developer ID; afterSign and deep/strict codesign
verification passed. No install, push or notarization occurred. Distribution validation
**failed** on `dist/.vite/manifest.json`, an output not allowed by the current asset policy.
This is a local test build, not an approved public release. The guard was not bypassed.
The DMG is retained under `.local-install.noindex/capture-queue-2026-10-04/`.

Actual native mouse/keyboard input in the signed app passed window selection, Record,
Pause/Continue, Stop, playback, Separate takes through the macOS folder picker, Command-N
back to compact recording with the remembered source, and Escape back to review. The named
recording activity was absent while paused. Both exported screen takes match originals and
fully decode. Audio/camera were off in this smoke; the earlier four-source run covers them.
`package-smoke.json` records the isolated user-data directory and exact source hashes.
The owned app was quit and its clean packaging worktree archived afterward.

## Record action accessible name

Native accessibility inspection found that the idle red Record button announced the selected
source name, indistinguishable from the source selector. Both tray layouts now announce the
localized Record action while preserving the source tooltip. Starting, saving, Stop and Linux
portal prompts retain their existing state labels. This follows the
[MDN aria-label reference](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-label):
an icon-only button needs an accessible name describing its action. The existing translated
Record key is reused. The targeted LaunchWindow suite passes 66 tests, including both layouts.

The rebuilt development app's native accessibility tree announces Record with Entire screen
as its help text in both horizontal and vertical trays. The vertical tray was also inspected
visually. All eight gates passed again: 4,119 unit tests, one existing skip; Vite production
build passed. Receipts: `record-name-checks/summary.json` and `record-name-desktop.json`.
