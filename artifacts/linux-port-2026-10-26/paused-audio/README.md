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

Host helper provenance is in `helper-provenance.json`. Portable package and
actual Electron verification will be recorded separately after the runtime
commit; these direct-helper checks do not establish renderer behavior.

Checks: 115 native tests passed, one existing live test ignored and the opt-in
live enumeration test filtered; 173 affected JS tests and both typechecks pass.
One final full JS run: 3,110 passed, 12 existing platform/opt-in skips. Strict
Clippy and lint pass. Fresh split reviews passed after correcting queued
Cancel/Stop ordering and moving bounded opening inside cancellable preparation.
