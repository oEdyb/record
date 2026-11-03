# Blur investigation, 2026-11-03

Frames were lost when the PC rebooted at 21:52; these numbers come from the session log.

- Capture, helper with NVENC, PipeWire source through a stub portal, no compositor: luma PSNR 40.5 dB, Laplacian ratio 0.976, 1px grating contrast 1.0. No visible loss.
- Export at 1:1 (padding 0), 1080p: NVENC 41.4 dB, ratio 0.987; libopenh264 37.6 dB, ratio 0.971.
- Export at default padding 50 (screen at 0.8x): 24.05 dB against a Lanczos reduction. 2560x1440 source to 1080p at padding 50 (0.6x): 22.2 dB. Text has uneven stroke weight.
- The result matches a 2-tap GPU bilinear model at 39.2 dB, so the suspected cause is a single linear fetch with no mips.

Initial status before the follow-up below: the shader change was NOT verified. `downscale_sharpness_linux` fails with and without it (spread 255).

Not covered: real niri, any fractional scale (nested niri cannot screencast: no GBM device), VA-API cap (encoder would not open here), motion at shipped bitrates.

## Resolved: controlled export comparison

The test was wrong: `set_scene` does not populate `LiveParams`. Without
`set_live_params(live_params_from_scene(&scene))`, its padding stayed zero.
The corrected static C1 test fails on the original shader (column spread 223 at
0.8x, 255 at 0.6x), and passes with footprint averaging (111 and 50). The 1:1
control stays 255. Missing GPU/ffmpeg now fails explicitly rather than passing
by skipping. C1 avoids unrelated fixture animation and motion blur.

The Linux video texture has one mip level and a linear sampler. A single fetch
therefore does not integrate the source footprint when reducing. The existing
branch shader averages multiple linear samples over that footprint; it is now
verified rather than speculative. This reduces aliasing and uneven stroke
weights, rather than sharpening already blurred capture. No encoder change.

Fresh paired exports, NVIDIA RTX 4070, Vulkan compositor, h264_nvenc at 8 Mbps,
30 fps, first decoded luma frame versus FFmpeg Lanczos source reduction:

| Source / padding / scale | Original shader | Footprint averaging |
| --- | ---: | ---: |
| 1920x1080 / 0 / 1.0x | 57.958586 dB | 57.958586 dB |
| 1920x1080 / 50 / 0.8x | 35.546493 dB | 36.616220 dB |
| 2560x1440 / 50 / 0.6x | 30.331135 dB | 37.692432 dB |

The padding-zero MP4s are byte-identical, SHA-256
`77164d70e5b77929958ec7b27d2b260ccffd49a893e57e61b48acd8e83691486`.
The earlier frames were lost: these are regenerated static terminal-like text
and grid inputs, using the same luma PSNR/Lanczos method, not a remeasurement
of the lost 24.05/22.2 dB inputs. They must not be compared across fixtures.
The source is lossless H.264, decoded by the real export path. Padded output
is cropped to its 1536x864 screen rectangle before comparison. This measures
actual encoded output, not just shader readback. Averaging is not exact Lanczos.

Reproduction tooling: `scripts/measure-export-quality.py generate <cache-dir>`
creates identical `before/` and `after/` inputs. Set `KLIPPT_QUALITY_DIR` to each
variant directory and run compositor integration test `measure_export_quality`
with `--ignored --nocapture`, once with the original shader and once with the
fixed shader. Run `scripts/measure-export-quality.py compare <cache-dir>`.
The normal `downscale_sharpness_linux` tests separately check the grating.
All heavy commands must use the shared flock and systemd MemoryMax=12G scope.
Artifacts and logs for this run are in `~/.cache/klippt-work/`.

Contracts checked: [WGSL texture sampling](https://www.w3.org/TR/WGSL/#textureSampleLevel)
and [FFmpeg scaler Lanczos](https://ffmpeg.org/ffmpeg-scaler.html).

Still unverified: real niri capture, fractional desktop scaling, Mac desktop
parity, VA-API and moving footage at shipped bitrates. The Linux-only shader
change does not claim to fix compositor/capture scaling outside the app.

Verification follow-up: the release Rust suite passed 268 tests (two ignored),
including all three GPU sharpness regressions. The JavaScript suite finished
3,335 passed, 12 skipped, six failed: the existing dependency-approval SSH
signature fails in `check-approved-dependencies` and `generate-release-inventory`.
These policy, key, signature and verifier files match main; this change does not
alter approval or bypass the failing gate. The broad suites ran on `24304c0c6`,
before incorporating main's later remux and Clean cut updates by rebase.
Installation is explicitly deferred while the PC is in use for a game; the
existing `~/Applications/Klippt` and settings remain untouched.

Merged code: `81e64b124e7ead13de03a0dea9801a5f5234505b` on main.
Local capture, Parakeet, compositor addon and TypeScript/Vite rebuilds passed.
A complete installable package was not produced: `beforePack` rejected missing
Whisper/ggml assets. The installed helper manifest names an older source commit,
so it was not copied and relabelled as this build. Packaging that helper with
valid current-source provenance, and then reinstalling, remain deferred with
the installation while the PC is being used for a game. No package guard was
bypassed and the installed app was not launched or replaced.
