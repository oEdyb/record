# Linux confidence monitor and virtual microphone — October 27

Runtime `cde7e19b5a74fb3b5c4bbf22cfaeab66e27d3ffa`. Ubuntu 22.04 floor normal-FUSE
AppImage: `release/linux-port-20261027-cde7e19b/`. SHA256
`55ba49d8e038cbd56be65c6f45799a6f4dcaf78439d7722a540e356813ac3cc3`.
Launcher and validated Niri F8/other Klippt bindings now target this file. Existing
user applications were left running; fully quit and reopen to load the update.

## Processed microphone

Host graph inspection found the renderer selecting Xstrm while EasyEffects linked
its virtual source into that stream. Warning logs also showed repeated failed
resolution of explicitly selected Easy Effects Source. Native enumeration only
accepted exact Audio/Source. It now also accepts exact Audio/Source/Virtual.
Sinks, streams, video and unknown Source subtypes remain excluded. Explicit peer
matching is unchanged: select Easy Effects Source intentionally when using it.
Physical-device selection rerouted by external policy still fails loudly.

The new actual-enumeration-callback C regression failed before the correction;
all seven offline scenarios now pass strict C compilation. The Rust C-test
harness passes one selected test. Live private enumeration resolves lab_processed
with description Easy Effects Source; an explicit-target native callback probe
captured 192,512 float samples, RMS 0.087422 and peak 0.124969, from private tone
links. The earlier auto-link attempt admitted silent PCM; only the subsequent
manually linked private source establishes nonzero audio. No physical audio
routing or EasyEffects settings changed.

Primary contracts: [PipeWire virtual source configuration](https://github.com/PipeWire/pipewire/blob/master/src/daemon/pipewire.conf.in),
[EasyEffects maintainer's matching-class correction](https://github.com/wwmm/easyeffects/discussions/4809).

## Live preview and separate camera media

The separate confidence window was still Mac-only. Both recorder-creation paths
now enable the shared window/frame relay on Linux. Its unique Klippt Camera title
is preserved against page title updates, avoiding owned HUD activation ambiguity.
Capture concealment is independent of desired renderer visibility: late requests,
reloads and creation cannot reveal it before capture ends or pauses. The existing
camera stream/writer is retained while the preview is hidden.

Normal AppImage + private compositor input + synthetic camera: Record → Pause →
Continue → Stop opens populated review with two camera-linked clips.
[Native window observations](packaged-cycle.json): recording/resumed expose only
the owned fixture; paused exposes both Klippt and Klippt Camera. Decoded source
measurements are in packaged-media.json. Red synthetic-camera pixels are present
in each standalone camera file and absent from every decoded screen frame.
The prior development run also passed with 3,607 screen and 1,803 camera frames.
No raw video or physical camera imagery is committed.

Private nested Niri additionally verifies [top-right placement](niri-position.json):
312×186 at [944,24] in a 1280×800 viewport; HUD at [404,344] stays focused when
preview remaps. A backed-up camera-only Niri rule implements that placement and
open-focused false on this machine. Generic Wayland ignores requested global
position; the private KWin preview initially centered over the pill. The local
Niri rule is separate from the portable runtime and is not universal positioning
support. Native Electron 44.9.1 title-event typings were inspected before use.

## Gates and limits

46 tests across six affected suites pass; the final window-only rerun passes all
four tests. Both typechecks, changed-file Biome, docs/design, production build,
release helper build and Ubuntu-floor packaged policy pass. Two independent
reviews found no introduced P1/P2; one caught the Mac-only creation gap, corrected
and verified with actual Linux frame delivery, title guard and mapping tests.
No full suite, repeated package formats, native compositor rebuild or soak.

The OBSBOT Meet 2 is present and advertises 1080p60/4K30 MJPEG. The authorized
physical probe failed EBUSY because the user's running Klippt process owns
/dev/video0. It was not stopped; physical webcam recording remains unverified.
Media tests used synthetic frames/private KWin. Nested Niri covers UI/placement,
not native screencast parity. Earlier user cursor concern was withdrawn by the
user; do not restart a missing-cursor investigation without a new report.
