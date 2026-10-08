# Hardware usage of a five-minute four-source recording, October 8, 2026

Measured on the installed app (build of October 8, 00:20, `main` at `bc9004f3`) on Olle's
Apple M5 MacBook (4 performance + 6 efficiency cores), driven by the agent while Olle was away:
Entire screen (3420x2214 at 60 fps, High), camera (1920x1080 at 30 fps), microphone and system
audio. Recording 1791451121506, one clip of 311.6 s. Record took 313 ms, Stop to review frame
1163 ms, no helper warnings. Process CPU was sampled with `ps` every 2 s
([samples and script](../artifacts/hardware-usage-2026-10-08/)); `powermetrics` needs sudo and
was not used, so there is no energy or GPU figure. `pmset -g therm` reported no thermal or
performance warning at any time.

## CPU, percent of one core, mean over the take (max in parentheses)

Recording, 144 samples:
- capture helper (Swift): 32.0 (35.4)
- replayd (ScreenCaptureKit daemon): 14.9 (23.9)
- cameracaptured: 14.2 (16.8)
- VTEncoderXPCService: 7.1 (8.2)
- Electron helper + renderer + main: 4.7 + 4.6 + 0.6 (19.2 peak in the helper)
- All of the above together: 101.5 (112.8), about one core of ten.
- WindowServer: 54.4 (84.8), up from 38.6 idle; coreaudiod 16.4, up from 12.1.

Idle with the HUD open (camera preview and mic meter on), 8 samples before Record:
- cameracaptured 11.5, replayd 8.6, capture helper 3.6, renderer 3.0, Electron helper 2.6,
  main 1.0; together 41.0.
- The replayd and helper share is the standby helper's shareable-content refresh every 4 s.

## Disk

- Screen MP4: 1200 MB, 31.8 Mbps actual (cap 136 Mbps for High), 58.6 fps measured.
- Camera MOV: 1338 MB, 36.0 Mbps, 1920x1080 at 30 fps. High doubles the 18 Mbps base for
  1080p, so the camera original is written at 36 Mbps.
- Microphone 9.4 MB, system audio 0.2 MB (256 kbps AAC).
- Total 2.55 GB for 5.2 minutes, about 29 GB per hour at this screen content (a mostly static
  desktop; busier screens push the screen file toward the 136 Mbps cap).

The test recording was left in Olle's recordings list and is his to delete.

## Camera bitrate ladder, same day

Fifteen-second segments of two camera originals (1920x1080) were re-encoded with the same
VideoToolbox H.264 encoder in realtime mode at 4, 8, 12, 18 and 24 Mbps and scored against a
ProRes copy of the 36 Mbps source with ffmpeg's `ssim` and `xpsnr` filters (no libvmaf in the
bundled ffmpeg). "Dark" is a night take of Olle at 24 fps with heavy sensor noise; "bright" is the
daylit static room from the five-minute take.

XPSNR luma, dB (SSIM): dark 4: 28.5 (0.880), 8: 31.3 (0.911), 12: 33.3 (0.931), 18: 35.5 (0.950),
24: 37.4 (0.963); bright 4: 30.7 (0.932), 8: 32.7 (0.945), 12: 34.2 (0.954), 18: 36.0 (0.964),
24: 37.7 (0.972). At 2x zoom of a 480x270 detail crop of the bright take, 4 Mbps is slightly
soft on fine texture and 8 Mbps upward is not distinguishable from the source by eye. The dark
take spends its extra bits reproducing sensor noise. Current policy: Standard writes 18 Mbps for
1080p30 and High doubles it to 36 Mbps.
