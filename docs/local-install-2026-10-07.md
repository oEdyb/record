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
