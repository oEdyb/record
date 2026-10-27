# Second-monitor preview and exclusion research — October 27

Source `c5cd55658fc1a0172d5e2842b3aa82911d1276e6`. Normal-FUSE Ubuntu-floor
AppImage: `release/linux-port-20261027-c5cd5565/`, SHA256
`a9a255154bfb6a6a3c23aa92063981fe950e588be7b19e9875e7fc23b617d4a1`.
The launcher and existing F8/other Niri Klippt bindings target this candidate.
The camera-only local Niri rule opens the preview on right-hand DP-3. No existing
host windows were moved, focused or closed.

## Research result

No supported clean same-monitor exclusion workaround was found. Current official
[Niri screencasting](https://niri-wm.github.io/niri/Screencasting.html) documents
solid blackout rectangles for both windows and layers. The [maintainer discussion](https://github.com/niri-wm/niri/discussions/3272)
still treats blackout styling as a separate feature. Nesting a desktop can isolate
apps launched inside it, but mirroring the current composed monitor also mirrors
its overlays. No compositor modification, replacement desktop or docking rewrite
was undertaken.

## Implemented fallback

Niri 26.04 [IPC types](https://raw.githubusercontent.com/niri-wm/niri/v26.04/niri-ipc/src/lib.rs)
expose exact PipeWire cast node IDs, output targets, window/workspace geometry and
change events. Subscribe before querying; validate the entire owned preview
footprint in logical coordinates against the exact granted cast. A camera already
wholly on an uncaptured monitor stays mapped. Same-output, straddling, ambiguous,
dynamic or missing identities fall back to hiding before writer admission. Paused
source replacement clears stale node identity. The pill still hides for monitor
recording; window-only capture keeps existing behavior.

Relevant camera/layout, cast, workspace, configuration, overview or output changes
and IPC failures revoke the exemption for the rest of the clip. Pause restores
desired visibility; Continue evaluates again. Unrelated window movement/focus does
not revoke eligibility. A retained preview is not redundantly remapped: Wayland
may move a newly mapped window to the focused output. Generation guards prevent
stale decisions or Stop cleanup from changing newer capture.

This is conditional visibility, NOT compositor-level atomic exclusion. A forced
move, monitor hotplug, compositor thumbnail or output transition can race frame
production. Keep the preview on the uncaptured display and avoid layout changes
mid-recording. No zero-frame privacy guarantee is claimed for those transitions.
Conservative event revocation can also hide the preview after workspace/cast
changes; Pause/Continue rechecks it. Missing source-replacement identity remains
hidden rather than guessing. No polling or repeated preview remapping is used.

## Evidence and limits

58 affected tests across six suites pass. After avoiding redundant remapping, the
23 directly affected guard/controller/window tests pass again. Both typechecks,
changed-file Biome, docs/design, production build and packaged policy pass. Two
fresh held-out reviews return PASS. No full suite, native rebuild, repeated four-
format packaging or soak.

- [Real socket and installed niri CLI transport](ipc-transport.json), using synthetic
  two-output compositor replies: admission succeeds, an actual streamed layout
  event revokes it once; 18 ms bounded run. This is not a desktop latency benchmark.
- Real private nested Niri IPC: an unprovable node stays hidden. The nested backend
  cannot validate native Niri screencasting; positive two-monitor policy checks
  use typed fixtures, not physical monitor input.
- Read-only host output inspection confirms DP-1 [0,0,2560,1440] and DP-3
  [2560,0,2560,1440]. No host camera window was present for an eligibility proof.
  Physical two-monitor preview/capture remains a user-driven verification gate.
- The actual OBSBOT became free. A private direct 1080p30 MJPEG probe decoded 59
  frames over two seconds. No physical imagery was published or committed.
- The exact AppImage then recorded actual OBSBOT + private KWin monitor:
  Record → Pause → Continue → Stop, with two durable camera-linked clips. Screens:
  111/120 decoded frames at 1920×1080; cameras: 113/116 decoded frames at 1920×1080
  around 60 fps. All four files fully decode. [Media](packaged-physical-camera-media.json).
- Across all 231 screen frames, the former preview/pill region is uniform owned-
  fixture background (maximum channel standard deviation zero). Camera and HUD
  native windows are unmapped during active capture and return on Pause.
  [Window observations](packaged-physical-camera-cycle.json). This validates the
  conservative fallback and real camera path, not the positive physical two-output
  exemption. The capped lab reported 17 superseded source frames; no unrestricted
  performance claim is made.

Raw camera footage remains only in the private lab profile. The lab and build
container are stopped after verification. Host input, clipboard, audio routing,
portal interaction and current windows were untouched; only validated launcher/
Niri configuration files changed with backups.
