# Blur investigation, 2026-11-03 (unfinished)

Frames were lost when the PC rebooted at 21:52; these numbers come from the session log.

- Capture, helper with NVENC, PipeWire source through a stub portal, no compositor: luma PSNR 40.5 dB, Laplacian ratio 0.976, 1px grating contrast 1.0. No visible loss.
- Export at 1:1 (padding 0), 1080p: NVENC 41.4 dB, ratio 0.987; libopenh264 37.6 dB, ratio 0.971.
- Export at default padding 50 (screen at 0.8x): 24.05 dB against a Lanczos reduction. 2560x1440 source to 1080p at padding 50 (0.6x): 22.2 dB. Text has uneven stroke weight.
- The result matches a 2-tap GPU bilinear model at 39.2 dB, so the suspected cause is a single linear fetch with no mips.

Status: the shader change on this branch is NOT verified. `downscale_sharpness_linux` fails with and without it (spread 255).

Not covered: real niri, any fractional scale (nested niri cannot screencast: no GBM device), VA-API cap (encoder would not open here), motion at shipped bitrates.
