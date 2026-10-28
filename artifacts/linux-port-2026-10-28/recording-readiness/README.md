# Recording readiness — October 28, 2026

Runtime `e0659bff`, normal FUSE-mounted AppImage in
`release/linux-port-20261028-e0659bff/`. SHA256:
`8d7cba510d0757a5564a4a92de773942feb534c8592914248aa312fefcb7e5a0`.
This check is preparation for Olle's next recording, not universal edge-case or
long-run performance clearance. No public release or merge.

## Actual saved microphone

A private, hidden Electron device-enumeration probe reused only the installed
profile's media-device salt and the same `klippt://app` origin to correlate the
saved device ID with its actual label. No salt/device IDs are published here.
The saved input was raw Endgame Gear Xstrm, while the system default is
EasyEffects' processed virtual source. Native audio-boundary probes from the
unchanged C capture source reproduced rejection of the raw source after external
policy substituted a different peer. Explicit Easy Effects Source succeeded:
286,720 float samples over three seconds, RMS 0.000010310, peak 0.000207740.
This is quiet room noise, not a spoken-level or physical lip-sync test.

Only the installed `micDeviceId` preference changed to the verified processed
source, with a backup beside the preferences file. Host default source, routing,
EasyEffects processing, camera enabled/format preferences and project data stay
unchanged. [Measurements](microphone-routing.json).

## Default-input correction

The private combined check reproduced a second startup failure: Chromium's
`deviceId: default`, label `Default`, was treated as an explicit PipeWire node
label. Required target resolution rejected it. The Linux adapter now omits the
display label for the default sentinel, allowing session default policy. Explicit
physical/processed labels remain explicit. A focused regression fails before
and passes after; it also asserts explicit EasyEffects selection is preserved.
89 affected adapter/lifecycle tests, both typechecks, changed-file Biome and diff
checks pass. Ubuntu 22.04 floor AppImage build and distribution policy pass.
No native rebuild or full suite was needed for this TypeScript boundary change.

## Final combined run

The final exact AppImage ran inside private KWin with normal app GPU settings,
actual OBSBOT 1920×1080 at approximately 30 fps, microphone and system audio.
The test fixture alone used software rendering. First clip receives the actual
processed host microphone through a one-way PCM bridge into a speakerless private
source. System sound is synchronized private 1 kHz pulses and white screen
markers. After acknowledged Pause, the microphone feed switches to the private
marker stream; Continue records a second clip. Stop opens populated review.
No test tone is connected to host playback.

- Clip 0: screen 9,266 ms; actual processed microphone is nonzero quiet room noise,
  RMS 0.0000620194, peak 0.000814086. System sound is nonzero.
- Clip 1: screen 9,233 ms; both isolated marker audio sources are nonzero.
- All eight screen/camera/microphone/system files fully decode. Native screen
  capture selects NVENC; camera encoding uses Chromium's existing path.
- No decoded audio sample clips. Camera files are 1920×1080 near 30 fps.
- Ten first-clip system markers match video: median video-minus-audio 14.69 ms,
  range −1.98 to 41.36 ms after the stored original offset.
- Nine second-clip markers match per source: microphone median/range 13.02 ms;
  system median/range 34.02 ms. These include test routing and AAC/frame timing;
  they do not calibrate physical microphone-to-camera latency or long-run drift.
- Controls and camera native windows are hidden during active monitor capture
  and present while paused. [Cycle](combined-cycle.json), [media](media-analysis.json).

## Test-environment limits and cleanup

Earlier combined attempts stalled while the shared lab budget hit its memory
limits with retained graphics allocations. Those attempts are not counted as
passing media evidence. One fixture also reallocated its full-screen canvas each
frame; the local test copy now resizes only when dimensions change. An extracted-
AppImage diagnostic attempt did not establish the final pass.

For the final pass only, a temporary copy of the existing `agent-lab` CLI placed
this lab and clients in a separate `agents-klipptcheck.slice`, retaining the same
2-CPU, 4 GiB soft / 6 GiB hard limits. No host input, clipboard or portal actions
were used. The ordinary shared slice's temporary soft-limit diagnostic change
was restored to 4 GiB; its 6 GiB hard ceiling stayed unchanged. Other projects'
services were not stopped. These constrained runs establish behavior and short
marker timing, not normal-desktop performance or immunity to driver/resource
stalls. User-speech quality and physical camera lip-sync remain unverified.

The test app was closed through the private window manager after durable saving.
The Klippt lab, microphone bridge and build container are stopped. Raw physical
recordings remain only in the private test profile and are not committed.
