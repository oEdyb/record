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
