# Four-source Linux handoff and shorter-camera export

Baseline package: `2d4323129ead891855c7475b578ad45e4588f9f3`, normal FUSE AppImage.
Private KWin/PipeWire lab; synthetic Chromium camera; microphone 660 Hz and
system 440 Hz supplied to separate private nodes. No physical devices or host
input/audio. Two clips contain all four originals.

Separate files: eight byte-identical originals, all fully decode; zero warnings.
OTIO has four 871-frame tracks, with a two-frame camera gap at the end. FCPXML
uses video-only screen clips and isolated audio tracks, avoiding doubled audio.

One video uses h264_nvenc, hardware=true, fallback=false. The packaged baseline
shortens clip two to its 3.2-second camera instead of its 3.233-second screen.
It emits 869 packets/frames reported by the muxer, with a 14.483-second container.
The shared walker now bounds by screen duration and holds the camera at EOF.
Two real-render regressions fail before (41 vs 120 frames) and pass after.
With the rebuilt host addon via the existing OPENSCREEN_COMPOSITOR_VIEW_NODE
override, the same project exports 871 reported video frames and 14.516 seconds.
Both outputs fully decode; 440/660 Hz amplitudes retain system unity and the
existing 1.4 microphone boost across both clips. Exact probe data is retained;
container nb_frames is not a claim about captured or decoded source cadence.
This host-addon result still requires the final portable candidate check.

Only affected tests ran. Private lab stopped. See the current acceptance record
for the final candidate rather than treating this baseline as the latest build.
