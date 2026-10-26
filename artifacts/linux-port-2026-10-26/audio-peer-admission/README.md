# Explicit audio peer admission — October 26, 2026

Baseline `19995181` let WirePlumber 0.4.8 connect a missing explicit target to
default B and deliver 1,146,880 bytes of PCM during the three-second probe.
The new guard observes the selected node and actual input links on the audio
stream's own PipeWire core. It keeps admission closed until a current core
barrier verifies those links, discards pre-verification buffers, and latches
wrong peers, source removal, native/core errors, ambiguous identity and overflow.
Untargeted default capture keeps its session-manager policy.

Private matching Ubuntu 22.04 stack (PipeWire 0.3.48, WirePlumber 0.4.8):

- Missing target: B is still attempted in the graph, but an explicit wrong-peer
  error is reported and **zero PCM bytes** reach the callback.
- Valid A: both graph input links originate from A and PCM is delivered.
- Default control: both links originate from B and PCM is delivered.
- Remove A after one second: PCM ends at 1.0027 seconds with a source-removal
  error; the three-second probe does not continue admitting audio.

Current PipeWire 1.6.10 / WirePlumber 0.5.18: selected A measures 440 Hz. Removing
it three seconds after first PCM ends PCM at 3.0293 seconds with an explicit
error during a nine-second probe. The 880 Hz default is never recorded.

The old-stack fixtures prove graph identity and admission, not distinct tones
or physical clock-rate parity. Their frequency setter was previously ineffective.
No GPU/physical microphone or performance claim follows from these audio checks.
All runs use `agent-lab` and private state/devices; the old stack runs in the
owned floor container without `/dev/snd`. Raw PCM remains local, outside Git.

`peer-gate-*.json` and event logs retain the actual cases. Baseline comparison:
`../legacy-audio-routing/missing-target.json`. The retained old-stack runner now
matches the supplied probe executable name and can remove owned A after one
second. Source fingerprints: `source-provenance.json`. No new package is claimed
by these direct C archive probes; portable verification follows the runtime
commit.

116 native tests pass, one existing live test ignored and one opt-in live
enumeration test filtered. This includes six offline C scenarios executing the
actual callbacks: stale barriers and queued PCM, wrong/missing peers, terminal
errors, removal/ID reuse, malformed/overflow and default bypass. Strict Clippy,
formatting and whitespace checks pass. Fresh split protocol and regression
reviews report no concrete P1/P2. JS production code is unchanged in this slice;
the preceding source checkpoint passed 3,113 JS tests with 12 existing skips.
