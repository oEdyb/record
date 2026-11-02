# Ubuntu 22.04 audio identity — October 26, 2026

The existing Ubuntu-floor container ran its own PipeWire `0.3.48-1ubuntu3.2`,
PipeWire Pulse of the same version and WirePlumber `0.4.8-4`. Tests were launched
through `agent-lab klippt-oldwp`. Container sockets/state were private, `/dev/snd`
was absent, and no host input, audio or portal was used. Both lab and container
are stopped after testing.

Two SPA `audiotestsrc` nodes are named `lab_mic_source_a/b`; B is the default.
The real C capture probe links the floor helper's PipeWire archive. The graph
identifies the actual output nodes connected to its two input ports:

| Case | Requested | Actual graph input | PCM |
| --- | --- | --- | --- |
| Baseline C at `81805667` | A | B / B | present |
| Add legacy `node.target` alongside `target.object` | A | A / A | present |
| Default capture control | default | B / B | present |
| Missing explicit target after correction | missing | B / B | present |

This establishes a normal-selection bug beyond the previously suspected loss
race. WirePlumber 0.4.8 reads `node.target`; it does not read `target.object`.
The helper now supplies both names, retaining current policy properties.
The missing-target row remains a real failure and is **not fixed** by this
compatibility change. The next capture change must prevent admitting fallback
PCM when the intended source disappears between enumeration and linking.

Current-policy regression (`current-policy-loss.json`): PipeWire 1.6.10 /
WirePlumber 0.5.18 still captures A at 440 Hz and stops admitting PCM at
3.029 seconds after A is removed three seconds after first PCM. The nine-second
probe reports explicit target failure; it never records the 880 Hz default B.
The retained runner now uses the source's owning module, avoiding a differing
module-list JSON field. Both private test labs and the container are stopped.

The attempted frequency setter did not change the adapters' default 440 Hz.
Consequently these assertions use actual graph identity, not a distinct-tone
claim. No media sample-rate or drift claim follows from this test.

`*-verified.json`, `default-control.json`, `missing-target.json` and the complete
graphs/event logs retain the observed cases. Raw PCM stays outside Git. The
baseline probe overrides only `pw_audio.c` from `81805667` before linking the
current floor C archive; the corrected probe uses the rebuilt actual archive.
The build's C file SHA is recorded in `source-provenance.json`.

`run-old-audio-stack.py` is the retained runner, now asserting peer identity and
PCM presence. It requires root inside the private container with no audio
device mount; it starts and tears down all three audio processes itself. Use
unique `EVIDENCE_LABEL` values, an absolute `OSC_AUDIO_PROBE`,
`OSC_AUDIO_TARGET` (default A), `OSC_EXPECTED_SOURCE` and
`OSC_EXPECTED_PCM=present|absent`. Invoke it through `agent-lab run klippt-oldwp
-- docker exec ... dbus-run-session -- python3 <runner>`. The asserted corrected
repeat is retained separately. This is audio integration evidence, not a GUI,
physical microphone, full older-desktop or packaged-app pass.

Related renderer fix: confirmed paused Continue failures offer retry guidance
in all 13 locale files. Pre-writer reconfiguration failures now explicitly
confirm paused state only while the helper is alive and no fatal error exists.
Regressions fail before both fixes; fatal/dead-helper guidance remains separate.
176 affected JS tests and 115 native tests pass. One final full JS run passes
3,113 with 12 existing skips; typechecks, Clippy, lint/i18n/docs/design and
changed-file React Doctor pass. Portable candidate `81805667` predates these
source changes; no new packaged verification is claimed.
