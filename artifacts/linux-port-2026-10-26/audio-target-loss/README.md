# Explicit microphone target loss — 2026-10-26

Private PipeWire 1.6.10 / WirePlumber 0.5.18 regression on this workstation:

- Selected microphone A emits 440 Hz; default microphone B emits 880 Hz.
- Before the fix, removing A silently records B: the one-second FFT windows at
  1/5/7 seconds report 440/880/880 Hz.
- After pinning an explicit target, A removal stops PCM at about 3.03 seconds
  and reports a target error. No B samples enter that stream.
- Untargeted default capture retains its policy: 440/880/880 Hz after A removal.

The C probe links the helper's actual compiled PipeWire archive. It requires a
private lab environment, writes interleaved 48 kHz stereo floats to stdout, and
logs state transitions to stderr. Compile with `cc -std=c11 -O2 -Wall -Wextra
-Werror -I electron/native/pipewire-capture/csrc probe.c <current helper build
archive>/libopenscreen_pw_shim.a -ldl -lpthread -lm -o /tmp/audio-route-probe`.

Create two private null sinks (`lab_mic_a`, `lab_mic_b`) and remapped sources
(`lab_mic_source_a`, `lab_mic_source_b`) using lab-scoped pactl. Play 440/880 Hz
WAVs only to those null sinks with lab-scoped paplay. Set the private default to B
for targeted cases, A for the default control. Run `run-probe.py` through
`agent-lab run klippt --`, passing the probe path, evidence label, and target
(`lab_mic_source_a`, or `--default` after `--` for the default control). The runner
checks the private environment and discovers only its named remap module before
removing A three seconds after first PCM. Recreate A before the next case.
Raw PCM remains in the private lab state; verification.json retains hashes and
measured results. No physical audio devices are used.

The production Electron bundle also selected A through the real Chromium device
list, resolved its label to the correct PipeWire node, recorded, paused, continued
and then lost A. The HUD stopped and opened review with an interruption. Both
screen clips and microphone originals fully decode; all measured microphone
windows contain 440 Hz. Committed source files remain byte-identical. The
failure tail is provisional until review probes its media; the review shows
57 seconds and two clips. This bounded test is not performance/clock-parity
evidence: the low-priority lab reports frame/audio drops under its resource cap.

The actual Rust callback regression fails before correction and passes after it;
normal teardown is suppressed and an explicit native error is preserved. Native
suite: 105 passed, one existing ignored, two live filtered. Shared affected JS:
168 passed. Strict Clippy, formatting and lint pass. Independent review reports
no introduced P1/P2 findings. Lab stopped after tests.

Contracts: [PipeWire target properties](https://docs.pipewire.org/page_man_pipewire-props_7.html),
[stream targeting](https://docs.pipewire.org/group__pw__stream.html),
[WirePlumber 0.5.18 policy](https://raw.githubusercontent.com/PipeWire/wireplumber/0.5.18/src/scripts/linking/prepare-link.lua).
WirePlumber 0.4.8 recognizes no-reconnect after the first link but lacks
no-fallback handling. Initial target loss on that older policy remains an
integration gate; this live workstation test establishes current-host behavior.
