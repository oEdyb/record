# Packaged Linux preview workload — October 26, 2026

Exact runtime `3a177e66`, normal-FUSE Ubuntu-floor AppImage. The existing owned
three-clip 48.633-second video-only take is reopened through real Recordings UI,
then played continuously once at fullscreen preview size 1800×1012. Private
KWin lab on the installed NVIDIA GPU; no fixture process or capture runs during
playback. The shared lab slice retains its two-core/6 GiB cap. This is a bounded
constrained-system result, not Mac parity or an unrestricted benchmark.

The native `OPENSCREEN_COMPOSE_TIMING=1` log yields 2,898 publications over
48.287 seconds: 59.995 fps. Publication intervals: p95 20 ms, p99 21 ms, max
38 ms; one exceeds 33.333 ms, none exceeds 50 ms. Native readback: p95 8.652 ms,
p99 11.083 ms, max 25.621 ms. Both clip changes play through to the tail. Source
clock resets also include the final transition to the stopped frame; do not
interpret three resets as three clip boundaries.

The built-in local report records 2,829 consumed/drawn frames, native boundary
p95 1.842 ms, renderer IPC p95 12.105 ms and draw p95 2.1 ms. These are separate
stage percentiles; adding them is not an end-to-end percentile. Report metrics
cover the view lifecycle and include idle polls before/after playback. Native
rows are explicitly restricted to the measured playback window. Render size is
rounded from the 1799×1012 initial view rectangle to 1800×1012 in the GPU.
No external camera, complex effects, scrubbing latency or long-session stability
claim follows. The diagnostic UI probe exposes no console events in this packaged
build, so no browser rAF percentile or input-latency claim is made.

A separate observability defect was found: ordinary review close/quit exits the
app (unit inactive/dead, PID zero) but leaves the preview report `running`.
Only explicit destroyView IPC finishes a preview report; process shutdown does
not. A later launch consequently classifies this cleanly exited preview as
interrupted. The retained report is unchanged evidence, not manually marked
successful. Fix report finalization and persistence during ordinary quit before
using terminal statuses as crash statistics. This does not invalidate the
bounded timing values or indicate failed media playback.

`summary.json`, `native-frames.json`, the unmodified workload report, measurement
window and owned-fixture tail screenshot retain the evidence. The attempted UI
probe only activates the existing observer; all UI actions use lab OS input.
The private lab is stopped after collection. No runtime code changed and no full
suite was run. Hardware, exact Niri, other GPU, Mac and Windows gates remain.
