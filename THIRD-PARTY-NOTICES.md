# Third-party notices

Klippt contains code derived from OpenScreen. OpenScreen is MIT licensed. The
upstream copyright and permission notice are preserved in [LICENSE](LICENSE),
which ships inside the application resources.

Packaged Electron applications also redistribute production npm dependencies.
Their license texts remain in the packaged dependency tree where supplied. The
release process must generate and review the complete dependency inventory from
`package-lock.json`. The sections below call out native, copyleft, and separately
distributed components that need extra release attention.

---

## FFmpeg — shared libraries (Windows only)

- **Components**: `avcodec-*.dll`, `avformat-*.dll`, `avutil-*.dll`,
  `swresample-*.dll`, `swscale-*.dll` and their siblings, under
  `resources/electron/native/bin/win32-*/`.
- **Used by**: the native D3D11 compositor addon, which links against them at
  load time.
- **License**: **GNU Lesser General Public License v2.1 or later**
  (<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>). FFmpeg's own
  licensing page: <https://ffmpeg.org/legal.html>.
- **This is an LGPL build, not a GPL one.** It is configured without
  `--enable-gpl` and without `--enable-nonfree`, and links no GPL-only library
  (x264, x265, xvid, vidstab, rubberband, frei0r, …). `scripts/fetch-ffmpeg.mjs`
  verifies this before vendoring — it reads `ffmpeg -L`, `-buildconf` and
  `-encoders` and refuses any binary that reports otherwise.
- **Upstream binaries**: BtbN/FFmpeg-Builds, release
  `autobuild-2026-07-31-14-10`, the `*-lgpl-shared-8.1` assets. Pinned by
  SHA-256 in `scripts/fetch-ffmpeg.mjs`; the digests there identify the exact
  artifacts we ship.
  <https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-31-14-10>
- **Corresponding source**: FFmpeg n8.1.2, commit `9b6c8969e0`, from
  <https://github.com/FFmpeg/FFmpeg>. The build configuration and scripts that
  produced these exact binaries are published at
  <https://github.com/BtbN/FFmpeg-Builds>.
- **Relinking**: as required by the LGPL, these are dynamic libraries. You may
  replace them with your own build of the same FFmpeg version by overwriting the
  DLLs in `resources/electron/native/bin/win32-*/`.

## whisper.cpp and ggml

- **Components**: `whisper-stt-server` and its ggml backend sidecars, under
  `resources/electron/native/bin/<platform>-<arch>/`.
- **License**: MIT — <https://github.com/ggml-org/whisper.cpp> and
  <https://github.com/ggml-org/ggml>.
- Built from source by `scripts/build-whisper-stt.sh`; the pinned upstream
  revision is in `electron/native/whisper-stt/CMakeLists.txt`.
- The speech model (`ggml-*.bin`) is **not** bundled — it is downloaded into the
  user's data directory on first use by `electron/stt/modelManager.ts`.

## Microsoft OpenMP runtime — `vcomp140.dll` (Windows only)

- **Component**: `resources/electron/native/bin/win32-x64/vcomp140.dll`.
- **License**: redistributable under the Microsoft Visual C++ Redistributable
  terms accompanying Visual Studio; the copy shipped is taken from the
  `VC\Redist\MSVC\<version>\x64\Microsoft.VC<nnn>.OpenMP\` directory of the
  Visual Studio installation that builds the release, never from `System32`.
- **Why it ships**: the ggml backends above are compiled with OpenMP and import
  it. It is **not** part of Windows, so without it `whisper-stt-server` dies in
  the loader before `main()` on any machine that has no Visual C++
  Redistributable, and transcription and captions fail with no usable error.
  Staged by `scripts/stage-vcomp-runtime.mjs`; `scripts/before-pack.cjs` refuses
  to package if it is missing while anything still imports it.

## PipeWire — headers (Linux only)

- **Components**: header sources under
  `electron/native/pipewire-capture/vendor/pipewire-1.0.5/include/`, compiled
  into `openscreen-pipewire-helper` (the Linux cursor/capture helper) under
  `resources/electron/native/bin/linux-*/`.
- **License**: **MIT** — <https://gitlab.freedesktop.org/pipewire/pipewire>.
  Every vendored file keeps its upstream `SPDX-License-Identifier: MIT` header,
  and the project's licence text is copied alongside them as `COPYING`.
- **Upstream**: PipeWire release 1.0.5. Only the header subset the helper
  includes was vendored; `vendor/README.md` records exactly what was copied and
  how to reproduce the selection.
- **No PipeWire binary is redistributed.** The helper resolves
  `libpipewire-0.3.so.0` with `dlopen` at runtime, from the user's own system,
  so nothing of PipeWire's ships inside our installers beyond the compiled
  result of its headers (inline functions and struct layouts).

## Mediabunny

- **Component**: `mediabunny` 1.40.1, used to mux edited audio and video.
- **License**: Mozilla Public License 2.0 —
  <https://www.mozilla.org/MPL/2.0/>.
- **Source**: <https://github.com/Vanilagy/mediabunny>.
- Klippt currently uses the upstream package without modifying its source. Keep
  the package license and notices in every distribution. If its source is
  modified, publish those modified MPL-covered files as the MPL requires.

## web-demuxer and FFmpeg WebAssembly

- **Components**: the `web-demuxer` 4.0.0 JavaScript package and
  `web-demuxer.wasm`, used for streaming media demuxing.
- **Wrapper license**: MIT — <https://github.com/bilibili/web-demuxer>.
- **FFmpeg-derived WebAssembly**: LGPL-covered code. Confirm the exact FFmpeg
  configuration, corresponding source, notices, and relinking method before a
  paid distribution. Do not treat the npm wrapper license as covering the
  bundled FFmpeg-derived binary.

## OpenScreen-derived native helpers

`wgc-capture` (Windows Graphics Capture), the ScreenCaptureKit helper (macOS),
the PipeWire helper (Linux) and the compositor addon are part of this repository
and are covered by [LICENSE](LICENSE).

---

Before release, direct notice or source requests to the Klippt support channel.
Do not send Klippt product support requests to the OpenScreen project.
