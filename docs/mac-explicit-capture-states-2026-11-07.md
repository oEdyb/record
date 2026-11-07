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
