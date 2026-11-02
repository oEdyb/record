# Actual Niri capture, review and exports — October 26, 2026

Olle explicitly authorized use of the physical session while away. Tested the
normal-FUSE `a4f92422` AppImage with its packaged native binaries, no helper/addon
overrides, a separate user-data profile and an owned fixture window. The existing
registered desktop identity was retained. No application source changes or new
builds were needed. This was a focused desktop check, not a full test suite.

## Observed journey

- Enabled system audio and the default microphone using real OS keyboard input.
  The configured source is Easy Effects Source; no global device, volume or mute
  setting was changed. No physical camera is available.
- Selected only the owned window through GNOME's actual portal. The fixture's
  quiet 1 kHz pulses and visual markers were armed with native keyboard input.
- Saved two clips of 7.250 and 5.083 seconds. Pause held the displayed clock;
  Continue started another clip in the same take. Earlier setup footage remains
  separately in the private profile; the result here refers to the final take.
- Stop opened review with both clips. Playback advanced, then the seek control
  reached 12.333 seconds with no native compositor error and sought back.
- Separate files used the native folder chooser. All six screen/microphone/system
  originals are byte-identical to their recording sources; all fully decode.
  OTIO and FCPXML are present, with no handoff warnings.
- One video used the actual save dialog and reported Video saved. The owned file
  was saved in Downloads by the chooser, then moved into the private test exports
  directory. It fully decodes: H.264/AAC, 740 video frames, 12.333-second container,
  matching the kept screen duration. Mixed RMS differs from the system originals
  by −0.03 dB, ruling out a doubled system track in this near-silent-mic take.
- Ctrl+Q closed the app and its unit; the driver's following page read observed
  the expected closed target. The fixture was already stopped. All owned windows
  are closed, and the previous focus is restored. Pointer and clipboard were not
  used. The lab and build container remain stopped.

App controls used focused OS keyboard events, with CDP only inspecting state.
GNOME's native folder/save buttons used their accessibility actions. Media remains
under `~/.local/state/klippt-verification/niri-workflow-20261026/`; no recordings or
approval tokens are included in this evidence. `result.json` contains hashes and
numeric observations only.

## Limits retained

The default microphone supplied valid nonzero PCM, but EasyEffects/room input was
nearly silent: RMS −86/−92 dBFS and peaks −54/−67 dBFS across the two clips. There
was nobody speaking, so this does **not** validate voice quality, speech balance
or calibrated physical A/V latency. System-audio RMS was about −36 dBFS.

The known Niri global-shortcut backend issue remains: BindShortcuts returned
error 5 at launch. Focused recording controls worked; no global shortcut success
is claimed. Monitor capture/HUD exclusion, physical camera, broader GPUs/desktops,
Mac regression and public release gates are unchanged. No endurance or universal
performance claim follows from this bounded session.
