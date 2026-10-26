# Packaged multi-clip cursor preview — October 26, 2026

Runtime: `3a177e66d6d108fbebaa6e7fe4323d3cfb20d1df`, normal-FUSE Ubuntu-floor AppImage.
Private KWin agent-lab only; real compositor input and owned fullscreen fixture.
Microphone, system audio and camera disabled. Editable cursor enabled.

Record → move pointer → Pause → Continue → move pointer → Pause → Continue →
move pointer → Stop produces three clips (41.433, 3.650, 3.550 seconds).
Each clip has a native cursor sidecar with local timestamps and a valid sprite:
823, 86 and 60 samples respectively. The first screen hash remains unchanged.

Screenshots show the recorded cursor in all three clips, including seeking and
automatic playback transitions. During preview the real pointer was at (110,210),
outside the video. `proof.json` records white cursor pixel bounds in a dark fixture
region. At 1.5 seconds in each raw source, the corresponding body band has zero
white pixels, supporting that the visible white cursor is an editable overlay.
This is a bounded fixture check, not proof about every frame or cursor shape.

Focused checks: 21 tests passed in `nativeMacClipSession.test.ts`,
`linuxClipCaptureMetadata.test.ts` and `pipeWireCursorAccumulator.test.ts`.
No runtime changes or rebuild; no full suite. Lab stopped after verification.

The earlier paused-audio-loss/reconfigure take had no sidecars. The combined
recovery check below does not reproduce that absence with deliberate movement.
Exact Niri capture, physical devices, other GPUs and performance parity remain
separate gates.

Media stays in the private lab profile. Its paths and SHA-256 hashes are in
`proof.json`; raw videos are not committed. Screenshots contain only the owned
fixture and private test app.

## Paused microphone recovery with deliberate cursor movement

The same immutable AppImage passes a second bounded take: explicit private
LabMicrophoneA → Record/move at y650 → Pause → remove A → Continue rejected
while paused → restore A → Continue/move at y800 → Stop/review. One helper
survives; no portal is reopened and the failed Continue adds no clip.

The two clips last 19.616 and 4.316 seconds. Both have native sidecars with
64/85 samples, bounded local timestamps, known sprite references and readable
24×24 PNG assets. All four screen/microphone files fully decode; both first-clip
source hashes remain unchanged. The recovered clip loads its sidecar with
85 samples and visibly renders the cursor at the expected fixture location.
The physical private pointer remains at (110,210), outside the preview.
Proof: `audio-recovery-proof.json`, filtered runtime events and screenshots.

This does not establish why the earlier stationary/HUD-heavy take had no
samples, but there is no reproduced cursor loss across paused audio recovery.
No speculative runtime fix was made. The prior 21 affected tests remain the
relevant result; no further code or tests changed. The private lab is stopped.
