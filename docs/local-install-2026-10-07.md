# Signed local installation — October 7, 2026

Olle asked to install the `perf/camera-prewarm` branch after a camera blackout turned out to
come from the previous installed build (Oct 6), not the dev app.

## Build

Runtime code through `57d8baf8`. Native change since the previous package: the ScreenCaptureKit
helper only (late side sources no longer fail a take; camera interruptions are reported as
`camera-interrupted` warnings; `recording-started` carries `epochMs`). The helper manifest was
recreated for that commit; the compositor addon, Whisper, Parakeet and FFmpeg payloads are the
Oct 6 builds, unchanged in source.

Packaged with `npm run build-vite && npx electron-builder --mac --dir --arm64 --publish never`
into `.local-install.noindex/camera-20261007`. Signed Developer ID Application: Dyberg & Co AB
(LF8KF3G42Q); app and helper identifiers unchanged; deep strict codesign verification passes on
the packaged and the installed bundle. ASAR SHA-256: `a3cb5bb2c3a2b441fb3b6d086f4b09492eaa8d146b68e35d1b00a20c49f748c0`.

## Installed

The previous app was not running. It is kept at
`.local-install.noindex/backup-installed-20261007-2150/Klippt.app`. The new app launched with a
standby capture helper from the new binary; the HUD shows Entire screen, system audio,
microphone, camera and Record.

Not yet verified on this build: a real recording pass. The first take should be read from
`diagnostics/record-start-timing.jsonl` and any `camera-interrupted` warnings.

## Second installation, 22:02

Reinstalled from `a42dafa9` after the first take on the 21:46 build showed Record taking 1.8 s,
all of it in `SCShareableContent`. The helper now keeps a window-list snapshot young in standby
and while paused and reuses it when it still matches the live target. Same signing identity and
identifiers; deep strict verification passes. Previous app kept at
`.local-install.noindex/backup-installed-20261007-2202/Klippt.app`.

Driven test take on the installed app (recording 1791403354509, Entire screen, camera, mic,
system audio): Record click to recording-started 306 ms with `shareable-content-cached`; Pause;
Continue 35 ms; Stop; two clips, 18.5 s and 10.8 s, no camera frame gaps in either webcam file.
Olle's earlier six-clip take on the 21:46 build also had no camera gaps.

## Third, fourth and fifth installations, 22:15 to 22:34

Three more packages of the same branch, each over the previous one after confirming no take was in
progress: `.local-install.noindex/stages-20261007` (the rebuild stage events name the snapshot
rejection and the replacement steps, and a new output size starts a new stream instead of
resizing the live one), then `bounds-20261007` from `7fbaa86d` (a window pick no longer rebuilds
twice because the resolved bounds moved, and windows are looked up by id). Same signing identity
and identifiers; deep strict verification passed each time. Previous apps kept at
`backup-installed-20261007-2215`, `-2225` and `-2234`.

Driven test take on the `7fbaa86d` build (recording 1791405280393, Entire screen → Claude
window → Entire screen, camera, mic, system audio):

- Record click to recording-started 269 ms, `shareable-content-cached`.
- Pause 63 ms. Window pick: prepare 333 ms (`shareable-content-cached`, stream start 286 ms),
  Continue 40 ms with no second rebuild.
- Pause 61 ms. Display pick: prepare 422 ms (stream start 384 ms). Continue clicked 66 ms after
  the pick, so it waited for that rebuild and then spent 595 ms in `screenshot-seed` because the
  new stream had not delivered a frame yet; Continue returned at 999 ms.
- Stop 262 ms to stop-returned, review first frame 512 ms.
- Three clips (12.1 s, 7.0 s, 6.7 s); webcam files have no gap above 35 ms.

Open: a Continue pressed within ~300 ms of a source change can pay for an `SCScreenshotManager`
capture (about 600 ms) instead of the first stream frame. A human pick-then-Resume gap is longer,
so the earlier measured 214 ms + 45 ms display-back stays the typical case.

## Sixth installation, 22:53

Package `.local-install.noindex/seed-20261007` from `95a1712e`: Continue now waits up to 300 ms
(20 ms polls) for the replaced stream's first frame and only then falls back to the
`SCScreenshotManager` capture. Same signing identity and identifiers; deep strict verification
passed. Previous app kept at `backup-installed-20261007-2253`.

Driven test take (recording 1791406432193, Entire screen → Claude window → Entire screen, Resume
pressed within ~70 ms of each pick). This take ran while the computer-use screenshot tool was
timing out on ScreenCaptureKit ("did not call back within the watchdog window"), so the whole
capture stack was contended; the absolute numbers are not comparable to the 22:34 take.

- Window pick: `resume-stage:first-frame` after 55 ms, no screenshot seed. Before the change
  the same sequence spent 595 ms in `screenshot-seed`.
- Display pick: Continue seeded from the cache directly (prepare had finished 1.7 s earlier).
- Stream starts under contention: window 2.0 s, display 1.6 s. Record 872 ms, Stop 836 ms.
- Clip 1 microphone offset 902 ms (late side source); clips 2 and 3 about 15 ms.
- Clip 3 (66 s, Entire screen): screen file has 13 gaps above 250 ms (max 1.9 s) and the
  webcam file 9 gaps (max 2.1 s) at matching times. Camera frames are delivered on the
  recorder's sample queue with `alwaysDiscardsLateVideoFrames = true`, so a stalled screen
  path discards camera frames instead of delaying them. Two helper warnings were raised
  (pause at 402 ms, Continue at 791 ms); their codes were not captured, which `2e7bfb80`
  fixes for the next take by naming the code in the timeline stage.

## Seventh installation, 23:10

Package `.local-install.noindex/camq-20261007` from `599e2418`: the camera's
`AVCaptureVideoDataOutput` now delivers on its own queue and forwards each frame to the recorder
queue asynchronously, so a stalled recorder queue delays camera frames instead of making
AVFoundation discard them. A dropped frame raises `camera-interrupted` with Apple's reason
(`FrameWasLate`, `OutOfBuffers`, `Discontinuity`) at most once a second. Same signing identity
and identifiers; deep strict verification passed. Previous app kept at
`backup-installed-20261007-2310`.

Driven test take (recording 1791407455699, Entire screen → Claude window → Entire screen, Resume
within ~100 ms of each pick, screenshots taken throughout). The capture stack was not contended
this time, so this take proves no regression, not the stall case:

- Record 276 ms to recording-started; Stop 695 ms to stop-returned.
- Window pick: prepare 941 ms (stream start 833 ms), Continue 458 ms with `first-frame` 23 ms
  after the stream started.
- Display pick: prepare 462 ms, Continue 484 ms with `first-frame` after 23 ms.
- Clip 1 microphone offset 278 ms; clips 2 and 3 under 10 ms.
- No helper warnings. Screen files max gap 17 ms; webcam files max gap 100 ms, none over 250 ms.

Open: reproduce the 22:53 stall (window picker open plus repeated ScreenCaptureKit screenshots)
on this build and read the `camera-interrupted` reasons.
