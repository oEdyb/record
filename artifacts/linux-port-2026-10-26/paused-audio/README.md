# Paused audio recovery — October 26, 2026

Private `agent-lab klippt` only: headless KWin/KDE portal, PipeWire 1.6.10,
WirePlumber 0.5.18, NVIDIA. Host windows, input and physical audio were untouched.
These are bounded functional checks, not physical-device or performance parity.

- `before.events.jsonl`: baseline `4f065298` stops the take when the selected
  virtual microphone disappears after acknowledged Pause.
- `after-proof.json` and `after.events.jsonl`: one helper and portal, two
  recoverable missing-input Continue rejections, restored A, switch to B,
  disable microphone, then cancel preparation and Stop. Exactly four clips;
  the first clip's source hashes remain unchanged.
- `media-verification.json`: all seven screen/original files fully decode;
  microphone originals contain 440/440/880 Hz; fourth screen has no audio track.
- `enumeration-timeout.json`: freezing only this lab's PipeWire daemon makes
  the actual C registry enumeration return its one-second error at 1.002 s.
  Normal enumeration passes before and after; daemon resumed in `finally`.
- `frozen-stop-proof.json`: with that same private daemon frozen during
  replacement opening, Cancel/Stop acknowledges in 0.12 ms and the helper exits
  in 22.92 ms, before daemon resumption. One committed clip, no tail clip.

The scripts preserve the procedures, with formatting and private-graph guards.
Run via `agent-lab run klippt -- python3 <script>` after creating the owned
fixture and two remapped virtual microphones `LabMicrophoneA/B` fed from
`lab_mic_a/b.monitor`. Four-clip testing removes and restores only source A's
owning module. The native helper path is the host release staging path; the
enumeration probe must be compiled from `enumeration-probe.c` and the helper's
current C archive to `/tmp/klippt-audio-enum-probe`. Scripts overwrite only their
named lab evidence files. Media remains local in the lab, outside Git.

Host helper provenance is in `helper-provenance.json`. The portable runtime is
`81805667bafc97ab839503aa25bae99b7f9a2892`. All four Ubuntu-floor formats pass
strict package policy; extracted AppImage policy and clean Ubuntu/Arch/Fedora
loaders pass (27 ELFs, three executables). Immutable private inventory:
`release/linux-port-20261026-81805667/`; checksums: `package-SHA256SUMS`.

The exact normal-FUSE AppImage passes real HUD Record A → Pause → remove A →
rejected Continue, still paused → restore A → Continue → additional unchanged
Pause/Continue → Pause → choose B in the real device list → Continue → Stop.
Review shows 1:42 / four clips and plays the captured fixture. All eight media
sources fully decode, measured microphone windows contain 440/440/440/880 Hz,
and the first clip's acknowledged hashes remain unchanged. The same mounted
helper PID survives the take; its actual bytes match the floor package helper:
`4ea2dd0f8de78ef72ee090ab592e15551838d3ebecc414add86feb26f5e54dd3`.
Proof: `packaged-verification.json`, `packaged-app.log`, and two screenshots.
The log reports 40 superseded frames under the lab CPU cap; no throughput claim.
The generic failed-Continue toast still says “Press Stop” despite retry being
available; its copy needs a follow-up. Lab and owned build container stopped.

Checks: 115 native tests passed, one existing live test ignored and the opt-in
live enumeration test filtered; 173 affected JS tests and both typechecks pass.
One final full JS run: 3,110 passed, 12 existing platform/opt-in skips. Strict
Clippy and lint pass. Fresh split reviews passed after correcting queued
Cancel/Stop ordering and moving bounded opening inside cancellable preparation.
