# Studio — handoff to the Mac, 2026-10-30

Branch `feat/studio` (repo `oEdyb/record`). Continue here on the Mac.

## What Olle wants next

The Studio (the full-size recording window, opened from the pill) should be the **big form of
the pill**: everything the pill can do, plus more. Today it is a reduced copy. His words:

> "The webcam is frozen. And why is the pill so collapsed? You should be able to do everything
> here that you can do in the small pill, even more so."

Settled earlier, keep these:

- Recording from the Studio works (idle Studio has Record). Pressing Play/Record/Resume in the
  Studio keeps it expanded. It only drops to the pill on "Switch to pill", Esc, or Stop (review opens).
- If the Studio sits on the screen being recorded, it must never be captured. On Linux/niri it
  moves to the other monitor and comes back on pause; if that fails it hides.
  **On the Mac, decide the equivalent:** the native capture can exclude a window
  (`setContentProtection` / SCK excluded windows); prefer that over moving or hiding.

## Note on "native UI"

The pill and the Studio are the same React code on both platforms (`src/components/launch`,
`src/components/studio`). What is native on the Mac is capture (`nativeMacRecordingService`,
the ScreenCaptureKit helper), not the UI. Developing on the Mac is still the right call: it is
the main product, and window exclusion is cleaner there.

## Gap: what the pill has that the Studio lacks

Pill (`src/components/launch/LaunchWindow.tsx`, controls defined around line 2014–2100):

| Pill feature | Studio today |
|---|---|
| Source chip / screen picker (`sourceControl`) | missing (Record asks via the pill's picker) |
| Mic on/off + live level meter | missing |
| Camera on/off + **live camera preview** (`CameraPreviewWindow`, `useCameraPreviewFrameBridge`) | missing — only replay camera |
| System audio toggle (`audioControl`) | missing |
| Device settings (mic/camera choice, `HudDeviceSettings`) | missing |
| Notes / teleprompter (`openNotes`, `NotesWindow`) | missing |
| Transcript window | has its own transcript panel |
| Replay peek | has a bigger replay |
| Remove previous clip + **Undo toast** (`clip-removal-feedback`) | remove only, no Undo (bug 10) |
| Countdown | via pill |
| Pause / Resume / Stop / timer | has them |

Architecture today: the pill owns the take; every Studio button sends a command over IPC
(`electron/studio/ipc.ts` COMMANDS, `studioController.command`) and the pill acts. Adding pill
features to the Studio means either more commands, or (better) lifting the state the pill owns
(devices, source, toggles) into a shared store/main process so both windows render it. Decide
this first; it is the real work.

## "Webcam is frozen" — not root-caused

Seen by Olle on Linux in the Studio. Candidates, check in order:

1. During recording the replay is held (paused), so the camera shows a still frame. There is no
   live camera in the Studio at all. If he means the live view, the fix is the live preview row above.
2. Replay sync in `src/components/studio/StudioReplay.tsx` (the rAF tick, ~line 138): it re-seeks
   the camera whenever it drifts > 0.15 s. Camera files are variable frame rate (drops to
   ~28.6–29.5 fps under load) and MediaRecorder WebM seeks slowly, so it may re-seek every frame
   and never paint. Log seeks per second to confirm; fix by syncing with `playbackRate` nudges
   instead of seeks, and seeking only on large jumps.
3. `webcamOffsetMs` wrong for the clip, so target time is past the camera file's end.

## State of the branch

Fixed and lab-verified on Linux (details: `bughunt-2026-10-30.md`, `fix-verification-2026-10-30.md`):
replay crash mitigation (lazy media, pill-crash recovery that saves the take), dead Studio
buttons after pill death, replay audio leaking into the next clip, Stop-during-capture losing
the last transcript, old take's transcript on a new take, missing webcam in replay, Home/End
on the seek bar, record-from-Studio and stay expanded.

Still open: items 8–13 and 15–17 in `bughunt-2026-10-30.md`.

Linux-only pieces (don't port, find Mac equivalents): `electron/studio/niriStudioPlacement.ts`,
`electron/niriCaptureWindowGuard.ts`, `electron/niriCaptureWindowPolicy.ts`.

Gates at handoff: tsc clean, biome clean, vitest 2615 passed / 12 skipped.

## Start here

1. `docs/studio/architecture.md`, `docs/studio/ui-ux.md`, this file.
2. Run the app on the Mac, open the Studio from the idle pill, compare with the pill.
3. Propose the shared-state design for pill + Studio to Olle before building.
