# Notes on the Linux HUD — options (November 1, 2026)

Decision for Olle. Nothing here is implemented.

## Where things stand

- The Setup footer hides **Notes** and **Transcript** on Linux
  (`LaunchWindow.tsx`, `isLinuxHud ? null`). It has been that way since upstream
  `f695b4c7` (July 3), most likely because Notes could not be kept out of capture there.
  Nothing else opens the Notes window, so Linux has no Notes today.
- Electron's `setContentProtection` is macOS/Windows only, so a Notes window on Linux is
  captured like any other window.
- Since `9535ce6e` the Notes and Transcript windows already unmap whenever the pill does
  (monitor or unknown-source capture) and return, unfocused, at Pause. Window-only capture
  never conceals. That safeguard is dormant while the button is hidden.
- Transcript is a separate matter (Mac-only helper) and stays hidden either way.

## Options

**A. Keep it hidden (status quo).** No work, no risk. Linux lacks a Mac feature
creators use while recording; the Setup footer keeps one lone "Recordings" button.

**B. Show Notes, concealed during monitor capture (one-line UI change).** Notes opens
and works while idle and paused, and during window-only capture. On monitor capture it
vanishes when Record starts and returns at Pause, exactly like the pill. Honest and
safe, but it defeats the main use (reading a script while the take runs) for the most
common case, a full-monitor recording.

**C. Show Notes and keep it outside the captured output on Niri, concealed elsewhere.**
Notes stays on screen during a monitor take only when Niri proves it sits wholly on an
output that is not being cast; anywhere else (other compositors, unproven layout, one
monitor) it falls back to B. The proof machinery exists for the camera monitor
(`niriCameraPreviewGuard.ts` / `niriCameraPreviewPolicy.ts`: match the portal's PipeWire
node to the compositor cast, validate window, workspace and output geometry, revoke on
layout change), but it is keyed to one window titled "Klippt Camera" with app id
`co.dyberg.klippt`. Generalizing it to "Klippt — Notes" (and placing the window on the
other output, as `niriStudioPlacement.ts` does for the Studio on `feat/studio-linux`)
is real work: roughly the size of the camera-monitor change, plus its own Niri checks.
It is conditional placement, not capture exclusion, and Olle's two-monitor setup is the
case it serves.

**D. Wait for window-level exclusion.** Not available on Wayland through Electron today;
not a plan.

## Recommendation: B now, C next

Ship **B** with the Studio merge: it is a one-line change, the safeguard is tested, and it
gives Linux Notes for window capture and paused editing without risking Notes in footage.
Then do **C** only if the walk-away case (script on the second monitor while recording
the first) turns out to matter in daily use; it reuses a proven design, but it should
come with an actual two-monitor Niri check rather than unit tests alone. Do not pick A
unless Olle never writes scripts on Linux, and do not wait for D.

If only one can be chosen today: **B**. It adds the feature at no capture risk, and C
builds on it without undoing anything.
