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
Full-duration decode and clean-source signed packaging are still in progress.
