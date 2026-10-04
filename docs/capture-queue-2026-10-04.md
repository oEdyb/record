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

## Normal-runtime endurance attempt

At `675e6d72`, the requested 30-minute High four-source run failed about 100 seconds after
starting, with diagnostics off and no concurrent build/test jobs. The same eight-frame
backlog safeguard ended capture with writer status still writing. Automatic recovery opened
review. `long-normal/summary.json` records the native results and owned file paths.
The five-minute pass therefore does not establish a scheduling fix. No 60-minute acceptance
run is claimed. The profiler's packet-output buffer is raised to 128 MB for planned long
60 Hz packet inspection; the old 10 MB cap could truncate that test after capture completed.

## Explicit capture-queue priority experiment

The serial sample queue previously declared no QoS. Apple's
[task-priority guidance](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheTaskLevel.html)
explains that queue priority affects CPU scheduling and timer latency. The next experiment
sets only this queue to `.userInitiated`. Serial ownership, process-activity leases, timer
flags, one-millisecond leeway and the eight-frame safeguard are unchanged. This targets the
observed timer-entry delay without changing media tolerances. Existing callback/timer metrics
will compare the same four-source workload. It is not an established fix until measured.
All 56 native tests pass with the explicit queue priority. Full native rebuild and all eight
repository gates pass (4,119 unit tests, one skip). `qos-checks/summary.json` records commands.

The explicit-priority run also failed: third clip 150.447 seconds, timer-entry gap 184.283 ms,
lag 176.850 ms, writer ready. Unlike the earlier measured run, the preceding timer callback
lasted 31.233 ms and a nearby screen callback 60.287 ms (60.194 ms in telemetry). Zero writer
backpressure and append failures remain. This does not validate queue priority as a fix.
`qos-diagnostic/failure-timing.json` preserves the exact measurements. Next distinguish
preemption from time actually spent inside callbacks before changing another policy.

## Framework delivery isolation

The live 10 ms stack sample exposed framework receive/deserialization on the same serial
queue as cadence, before our delegate callback measurements begin. A System Trace then joined
receive stacks to preempted thread-state intervals (22.64 ms in IOSurface/IOKit, 11.90 ms in
deserialization). This confirms off-CPU time, not an expensive attachment cast. The trace's
retained scheduling data did not include the run's largest 145 ms timer gap; attribution of
that maximum remains unverified. `qos-system-trace/scheduling-analysis.json` owns exact joins.
The traced five-minute run passed, following two failed explicit-priority runs.

[Apple's SCStream output contract](https://developer.apple.com/documentation/screencapturekit/scstream/addstreamoutput(_:type:samplehandlerqueue:))
allows a separate delivery queue. Framework delivery now uses its own serial queue and
synchronously forwards application processing to the writer/cadence queue. This introduces no
unbounded application sample backlog. A command-lane delivery barrier drains old callbacks
before reconfiguration restores source-cache acceptance. Camera and writer state keep their
existing processing owner. Source delivery age and intervals between complete source frames
are reported separately from output-grid drift, with the interval baseline reset per clip.
These observations do not classify static-screen gaps as failures. The eight-frame writer
backlog policy remains unchanged. Moving-source quality and long recording still need proof.

The first isolated-delivery five-minute run completed, with 12 source copies and exact output
cadence, but was not accepted as smooth: 8,008/17,869 output frames reused a previously written
source timestamp. Source delivery p99 was 1.101 ms, maximum 58.361 ms; complete-source intervals
maxed at 26.744 ms, with no backpressure. The cache retained only the newest captured image,
so an image just ahead of a quantized grid slot could displace that slot's eligible image.

The cache now retains at most two recent captures while active, selecting the newest PTS no
later than the grid slot and no earlier than the last written source. It rejects out-of-order
captures, clears both references on source invalidation, and retains only the latest while
paused. This fixes normal one-frame timing mismatch without deep-copying surfaces or claiming
to preserve every frame in longer bursts. Deterministic tests cover the demonstrated mismatch,
reference selection bounds, pause/invalidation and out-of-order samples. Real verification
must inspect repeated-source counts as well as on-grid PTS.

The corrected 60-second four-source run passed: 2 repeated source frames out of 3,466 output
frames (the prior five-minute version had 8,008/17,869). This is a comparison of different
length runs, not a controlled statistical rate guarantee. Maximum source delivery age was
3.387 ms; p99 0.893 ms. All 12 exports match originals and fully decode without errors;
packet-grid validation passed. Decoded frames at 10 and 11 seconds visibly advance the
moving fixture. Record readiness 732.7 ms; Stop-to-review 2,381.1 ms; source handoff 2,740.7 ms.
`delivery-cache/summary.json`, `full-decode.json`, and `motion-10/11.png` retain the evidence.
Final independent concurrency/frame-cache review found no actionable findings. All eight
repository gates pass (4,119 tests, one skip), all 62 native tests pass, and full native/Vite
builds pass. Endurance acceptance at 30/60 minutes remains outstanding.

## Thirty-minute capture and local source-copy correction

The diagnostics-off 30-minute four-source run completed: 107,876 output frames, 957 repeated
source frames (0.887%), zero append failures/backpressure, and Stop-to-review 4,633.7 ms.
The source-export test then exceeded its 60-second deadline while copying the 30.69 GB third
screen file. The harness closed the app; this is a missed handoff deadline, not a returned
production export error. Original media remains intact. Full-duration decoding and all-screen
packet-grid checks are recorded separately; do not infer their completion from capture success.

The installed Electron 44.1.0 uses Node 24.19.0/libuv 1.52.1. That exact
[libuv implementation](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/fs.c#L1279-L1316)
implements `FICLONE` on Linux; the macOS path silently byte-copies (FORCE returns ENOSYS).
[Apple cp](https://github.com/apple-oss-distributions/file_cmds/blob/main/cp/utils.c#L222-L279)
rejects an existing file with `-n`, uses `clonefileat` for `-c`, and falls back for EXDEV/ENOTSUP.
The local macOS `man cp` confirms this contract. Native copying of this 30.69 GB source took
3.69 ms. File sizes or allocated-block counts alone do not prove shared storage.

The exporter now uses asynchronous `/bin/cp -c -n` with absolute argument-array paths on Mac,
after rejecting any existing destination including directories and dangling symlinks. Other
platforms retain exclusive Node copying. Native errors propagate into existing owned-folder
cleanup. The harness uses the same native command for its own media artifact copies.

Acceptance: actual saved-session GUI retry finishes in 2,020.9 ms (native 1,813.6 ms), all 12
exported files hash-match originals, and the success screenshot was inspected. A separate
native test verifies identical bytes, independent modification/deletion, and existing-file
rejection. Six new tests plus the full suite pass: 4,125 tests, one existing skip, 379 files;
all eight gates, Vite build, and independent review pass. Native code is unchanged since the
62-test native validation. Evidence: `endurance-30/clone-retry/report.json`,
`endurance-30/clone-independence.json`, and `clone-final-checks/summary.json` under the artifact root.
The one-hour acceptance run remains pending. Installed app, release configuration and remotes
are unchanged.
