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

## Eighth and ninth installations, 23:39 and 23:53

Olle's own take on the 23:10 build (recording 1791408627715, four clips, display and window
toggled several times in Setup) had no frame gaps and no warnings, but every window pick in the
picker felt slow. Two causes found in code and measured with an Electron script:

- A Display pick reads screens only and replaced the whole enumerated-source map, so the next
  window pick missed the map and re-enumerated every window with icons before the picker could
  close: 320 to 713 ms measured, 576 ms while the picker's own thumbnail read was running.
  `9b9ef366` merges reads by kind instead, and times the pick path as a `pick` row in
  `record-pause-continue-timing.jsonl`.
- Hovering Setup or opening the picker while paused on a window rebuilt the capture for the
  display on speculation. When Olle kept the window, Continue paid a second window stream
  start (2.1 s in his take). `48a01d1f` removes that prebuild and serialises timing-row writes,
  which had interleaved when a pick and its prepare ended in the same tick.

Packages `pick-20261007` (installed 23:39) and `hover-20261007` from `48a01d1f` (installed 23:53,
after Olle had quit the app). Same signing identity and identifiers; deep strict verification
passed. Previous apps kept at `backup-installed-20261007-2339` and `-2353`.

Driven take on the 23:53 build (recording at 23:54, Entire screen → Claude window → Display →
Claude window → Continue → Stop): every pick returned in 0 ms with `source-cached`, including the
window pick right after Display; no display prepare followed opening Setup; window stream starts
1362 ms and 949 ms, display 697 ms; Continue 156 ms; Stop 854 ms.

Open: the picker's thumbnail refresh (about 1.9 s of ScreenCaptureKit work for 28 windows) runs
on every open and overlaps the window stream start that follows a pick. Not yet measured as the
cause of slow window stream starts.

## Tenth installation, October 8, 00:12

Olle's take on the 23:53 build (recording 1791410548909, three clips) was clean: no gaps, no
warnings, every pick 0 ms. But each window pick still waited on the stream: starts of 3.1 s and
2.3 s, and Continue pressed 1.6 s after the pick waited 1.5 s and 0.6 s.

Benchmark with the real helper (scratch script, display and window requests, three runs each):
a display or window stream starts in 246 to 708 ms alone and in 2.4 to 2.5 s while the picker's
28-window thumbnail read is in flight; the `SCShareableContent` fetch itself waits about 2.2 s
behind that read. `d77a3ed3` makes a picker-sized read cheap (names and membership, no
thumbnails, pictures carried over by id) within 60 s of the last full read, so the hover
prefetch and the picker open no longer put two seconds of ScreenCaptureKit work in front of
the pick. Package `thumbs-20261008`; same signing identity and identifiers; deep strict
verification passed. Previous app kept at `backup-installed-20261008-0012`.

Driven take (recording at 00:12, Entire screen → Claude window → Display → Claude window,
Resume within about 100 ms of each pick): window stream starts 668 ms and 984 ms, display
449 ms; Continue 428 ms and 503 ms with `first-frame` after 74 ms and 46 ms; Stop 499 ms;
no gaps, no warnings. A stray click removed the second clip during the drive; the Undo toast
appeared as designed.

## Eleventh installation, October 8, 00:20

Olle's take on the 00:12 build (recording 1791411267578, five clips) was clean and every pick
0 ms, but the first window pick's stream took 8877 ms to start, with two `camera-interrupted`
warnings at 5.2 s and 6.3 s of that wait; later window starts took 1.9 s and 1.5 s. The helper
printed the warning text only to the console, so the reason was lost. `e88f1a4a` gives the
helper client an `onWarning` sink and appends every warning with its message, code, and time to
`diagnostics/helper-warnings.jsonl`. Package `warn-20261008`; same signing identity and
identifiers; deep strict verification passed. Previous app kept at
`backup-installed-20261008-0020`.

Olle's take on this build (recording 1791411853778, six clips, window picks of a Roblox
window): no gaps (max 17 ms), no clip warnings, every pick 0 ms. Record 329 ms, Stop 265 ms,
Pause 60 to 107 ms, Continue 41 to 55 ms when the stream was already up. Window stream starts
after the first: 378, 313, and 300 ms.

The one outlier was the first window pick: the replacement stream was created in 101 ms and
then `startCapture` blocked for 9013 ms. Three seconds later, while paused, the helper logged
`paused-source-unavailable` with ScreenCaptureKit error -3815, "Failed to find any displays or
windows to capture": the picked window had gone away. The next prepare took the
`previous-stopped` path and started a fresh stream in 378 ms. The slow start and the vanished
window point at the Roblox window itself (being created or replaced while it was picked), not
at the capture path, which started every stable window in well under half a second.

Open from earlier: the first clip's microphone track still starts 130 to 620 ms late
(318 ms here); offsets are compensated in the clip metadata.

## Twelfth installation, October 8, 10:33: mic hand-over experiment, reverted

Hypothesis: the first clip's microphone offset (100–900 ms on Record, under 10 ms on
Continue, across the last 25 recordings) came from the HUD's idle level meter releasing the
microphone at the Record click, at the moment ScreenCaptureKit opened it. Branch
`perf/mic-hold-through-record` (commit `7c02ae75`) kept the meter's stream open through the
take; package `michold-20261008`, signed by Developer ID Application: Dyberg & Co AB
(LF8KF3G42Q), installed over `backup-installed-20261008-1033`.

Olle's 10:39 take (recording 1791448735567, one clip, mic and camera on): Record 246 ms,
`microphoneAudioOffsetMs` 192, `systemAudioOffsetMs` 10. That is inside the baseline range, so
the delay is ScreenCaptureKit's own microphone start, not a device restart. The build was removed
at 10:41 (kept at `backup-installed-20261008-1041`), the 00:20 build restored from
`backup-installed-20261008-1033`, and the branch deleted. Removing the offset would need the
microphone captured by an AVCaptureSession warmed in standby like the camera; not scheduled.

## Thirteenth installation, October 8, 12:43: camera originals at 18 Mbps High

Branch `perf/camera-bitrate` (commit `dc6b976f`): the camera original bitrate policy is now
12 Mbps Standard and 18 Mbps High at 1080p (was 18 and 36), 20/30 at 1440p, 32/48 at 4K, with
the 1.7x 60 fps factor kept. Chosen from the bitrate ladder in
[hardware-usage-2026-10-08.md](hardware-usage-2026-10-08.md). Swift tests: 76 pass. Helper rebuilt
with `npm run build:native:mac`; the packaged helper's `__text` section and UUID match the fresh
build. Package `cambitrate-20261008`, Developer ID Application: Dyberg & Co AB (LF8KF3G42Q),
deep strict verification passed, installed over `backup-installed-20261008-1243`.

Agent-driven 33.9 s take on the installed app (recording 1791456231399, entire screen, camera,
mic, system audio, High): camera original 1920x1080 at 29.97 fps, 16.9 Mbps, 81 MB; screen
3420x2214 at 60 fps, 10.0 Mbps, 44 MB; Stop to review frame 675 ms; mic offset 337 ms. A 1:1
face crop at 15 s shows crisp hair and eyes. The 10:39 and 12:43 test takes stay in Olle's
recordings list.
