# Mac recording state conversions

Baseline: d4af576b5. Local evidence lives in
`artifacts/mac-explicit-state-20261107` in the Mac implementation worktree.

## Recorder, startup and stream recovery (row 4)

One `RecordingLifecycle.State` owns transport, source health/generation and clip
readiness. Startup/recovery are views of that same authority. The former stored
recorder flags are derived projections; they no longer mutate independently.
Illegal non-footage transitions are logged. Repeated Stop joins one completion
and waits for source/sample barriers and finalization.

The Apple AVAssetWriter contract requires every append to return before
[finishWriting](https://developer.apple.com/documentation/avfoundation/avassetwriter/finishwriting(completionhandler:)).
The existing owner queues remain those barriers; no concurrency-mode change.

Two independent Codex interrogate reviewers tested adversarial copies. Both
findings were independently rerun and fixed:

- Stop between native startSession and lifecycle epoch publication could delete
  a successfully appended frame. Epoch publication now retains that admitted
  session during Stop/failure; readiness still cannot acknowledge while stopping.
  A deterministic native-session gate test fails before the fix and passes after.
- Duplicate Continue after acknowledgement, or late Continue after Stop, emitted
  a false source error. Those illegal transitions now log without protocol errors.
  Both probes failed on the draft and passed on the original baseline.

Baseline real-window packaged flow: Record, Pause, Continue, Stop queued during
unacknowledged Continue, Restart, Stop, replay; 19 original tracks fully decoded.
Native Metal/VideoToolbox export: 156 frames, 2.6 seconds, 0.59711675 seconds wall.
MacBook Air Camera delivered samples in five saved originals. No reproduced
TypeScript regression. The tiny overlapped clip did not deliver system audio.

Native tests use `scripts/test-macos-capture-helper.mjs`, which creates an isolated
test manifest without changing the approved production Package.swift. Plain
`swift test --package-path ... --filter ...` finds no production test target.
Baseline requested writer class names were absent; actual writer/audio coverage
is NativeCaptureQualityTests and AudioTrackMixerPCMTests.

Full JavaScript suite: 3600 passed, 6 known dependency-signature failures, 7 skipped.
App/test typechecks pass. Lint passes with the existing oversized Cargo evidence
warning. No dependency key was accessed and no gate changed.

Native Save-panel automation remains unavailable: the automation host has no
Accessibility permission. One video UI opens; production scene building and the
public native export transaction render/encode/decode real media to a private
path. Native picker selection and its final UI completion remain unproven.

Row 4 merged/installed: 8f3e963dc. Packaged real-window flow passed with
19 decoded originals, 157-frame Metal/VideoToolbox export in 0.591961875 seconds.
Installed flow passed with 18 decoded originals and 162-frame export in
0.593563166 seconds. Backup:
`.local-install.noindex/backup-row4-20261107-030745/Klippt.app`.
The installed Restart clip received no camera samples: the helper reported
`source-late` after two seconds and an explicit no-samples finalization warning.
Four other camera originals decoded. This does not establish that the
intermittent camera delivery problem is fixed.

## Original and compatibility-audio writers (row 13)

OriginalTrackWriter now owns an explicit readiness/finalization enum and gate;
encoder preparation, epoch, source session, pending backpressure, first append
publication, draining, empty and completed results cannot mutate as separate flags.
Repeated finish joins a cached completion and never starts a second native finish.
CompatibilityAudioWriter, mixer timeline/track outputs, and producer admission
have explicit enum state authorities instead of their prior flags/nullable modes.

Admission reserves and dispatches a buffer while holding the same lock used by
close, so a closing queue barrier cannot overtake an already reserved append.
Buffers/counters/timestamps remain data; writer modes are enum cases.
The Apple [startWriting contract](https://developer.apple.com/documentation/avfoundation/avassetwriter/startwriting())
separates configured/prepared encoders from a started session and actual appends.
No encoder settings, source time offsets, bounds or drain deadlines were changed.

Two Codex interrogate reviewers ran adversarial media tests. Their two findings
were independently rerun before fixing:

- finish → cancel without removal → finish lost terminal state and could delete a
  saved original as if empty. Terminal completion now survives cancel; repeat
  finish returns its cached result and preserves identical media bytes.
- Invalid compatibility epoch consumed the owner's begin transition while the
  mixer rejected it. Epoch validation now precedes the state transition; a real
  subsequent AAC append succeeds, and the invalid move is logged.

The draft also failed the existing timing-metadata-after-finish test. Terminal
state now retains one-time metadata publication, preserving that public contract.
Native full suite after fixes: 120 tests passed, zero failures. Tests include real
AAC/MOV reading, empty-source outcomes, concurrent finish, delayed encoder
readiness, source offsets, and logged illegal writer/mixer transitions.

The same invalid-epoch recovery probe also failed on OriginalTrackWriter; its
gate now rejects nonnumeric epochs without consuming the first valid epoch.

## Final cross-model review corrections

One bounded Opus pass covered both conversions. Its early-Continue system-audio
loss probe was independently rerun: the draft invoked fatal failure once, while
the original baseline did not. A distinct preparing phase now lets that callback
warn/retry before the seed step; after seeding it retains the original fatal policy.
The production regression test uses the actual audio-stop policy and proves a
subsequent real resumed MOV is readable. The original injected-callback probe also
passes after the fix.

Inactive and replacement-required are now represented together when necessary;
Stop/invalidate cannot make an inactive source resumable. Completed capture state
rejects/logs every late mutation while repeated Stop still joins completion.
There is one clip index, in the lifecycle store; rejected Continue restores it
through the transition gate. Compatibility wrapper readiness is no longer cached
alongside the mixer's actual append state. Each source's failure timestamp remains
admission data used for the final capture boundary, not another writer-mode flag.

Cancellation stays terminal. Finish after cancelled capture returns the cached
failure without resurrecting the writer. Cancelling an already completed original
is rejected/logged and preserves its media, even with remove requested; ordinary
rollback callers cancel only incomplete writers. This avoids a later false saved
result for missing media. Stop/finalize itself is never rejected.

Track-output logs are injectable and tested; the admission test now races 16
producers against close and checks every accepted submission was processed.
The native suite after these corrections passes 127 tests with zero failures.

The first row-13 packaged media pass is excluded from private-source acceptance:
the test runner checked the source button before Studio rendered and skipped its
selection. The runner now waits for the UI and asserts the actual private window
before any capture. No application source-selection change was required.
