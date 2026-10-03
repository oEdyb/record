# Webcam encoder contention on macOS

Decision (2026-09-16): on macOS the app launches Chromium with
`--disable-accelerated-video-encode`, so the webcam `MediaRecorder` uses Chromium's software
H.264 encoder (OpenH264, Constrained Baseline). The screen is captured and encoded natively by
the ScreenCaptureKit helper through VideoToolbox, so this switch touches no other encoder in the
macOS app. Windows and Linux are unchanged.

## Problem

A 4K/30 webcam clip recorded beside a screen recording came out with about 25 fps: single-frame
gaps scattered through the file. The camera track itself delivered a clean 30 fps into the
renderer (`camera.delivered_fps` telemetry and `requestVideoFrameCallback` timing agreed).

## Evidence

Standalone Electron 44.1.0 probe (same Chromium as the app), OBSBOT Meet 2 at 3840x2160/30,
6 s captures, frames counted with ffprobe:

| Condition | Hardware H.264 | Software H.264 | VP8 |
| --- | --- | --- | --- |
| Alone | 180 | 179-180 | 179 |
| Eight CPU busy loops | 180 | – | – |
| ffmpeg `h264_videotoolbox` encoding 60 fps beside it | 148-150 | 179-180 | 179 |
| Live Klippt `record` CLI screen recording beside it | 44-59 | 179-180 | – |

Renderer CPU during the encode phase: hardware about 15 %, software H.264 about 190 %, VP8
about 345 % of one core.

Chromium `video_track_recorder.cc` drops a frame whenever more frames are queued at the encoder
than its reported capacity ("Too many frames are queued up. Dropping this one."). Hardware use is
gated by `IsGpuVideoEncodeAcceleratorEnabled()`, which the switch turns off.

## Alternatives considered

- VP8 for the webcam: keeps frames but costs almost twice the CPU of software H.264, doubles
  file size at equal bitrate, and would need export decoder verification. Rejected for now.
- WebCodecs `VideoEncoder` with `hardwareAcceleration: "prefer-software"` plus a WebM muxer:
  per-track control without a process switch, but a larger change. Candidate if the software
  cost at 1080p turns out to matter.
- Native webcam capture in the Swift helper: still shares VideoToolbox; would trade drops for
  queueing latency. Not tested.

Sources: Chromium `third_party/blink/renderer/modules/mediarecorder/video_track_recorder.cc`
(frame-drop guard and `CanUseAcceleratedEncoder`), Chromium `media/base/media_switches.cc`
(`disable-accelerated-video-encode`), Electron `app.commandLine.appendSwitch`.
