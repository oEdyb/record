# Paused cursor grant verification — 2026-10-26

`verification.json` records final production-bundle/private-desktop evidence and
source/helper hashes. Four clips across two consecutive recordings fully decode.
The second recording changes editable → system → editable through replacement
portal grants, retaining one helper PID and unchanged first-clip bytes. Cursor
pixels, sidecar asset references, clip bounds and fresh recording origins pass.
`verify-media.py` repeats media assertions using the retained lab recordings.

The earlier desktop cancellation pass kept the old paused system mode; the accepted
replacement then produced fully decoded system/editable clips. That first pass
preceded the terminal accumulator cleanup. The final two-recording pass uses the
rebuilt Electron bundle including that correction. The Ubuntu-floor packages now pass strict distribution policy and extracted
AppImage policy; three bare distro loader checks resolve all 27 ELFs and start
all three executables. `packaged-verification.json` records the normal-FUSE
AppImage system → editable cursor pass, fully decoded 1,290/813 frames, one
helper PID, unchanged first clip hash, and pixel/sidecar checks. Private inventory:
`release/linux-port-20261026-fcf6b7dd/`. The first packaged hash attempt sampled
before Pause acknowledgement and was invalid; the repeat explicitly waits for
the acknowledged Resume control before sampling. No application fix was needed.

`checks.txt` contains bounded check summaries. Regression logs demonstrate the
missing request behavior and the cross-recording accumulator leak before fixes.
Independent review passed after the lifetime correction. Routine GUI input,
portal selection and screenshots used only agent-lab; the lab was stopped.
Physical camera, exact Niri session, Mac hardware and broad performance parity
remain outside this evidence.
