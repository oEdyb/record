# Third-party notices

Klippt is licensed under the GNU Affero General Public License v3.0 only
([LICENSE](LICENSE)). It contains code derived from OpenScreen, which is MIT licensed. The
upstream copyright and permission notice are preserved in
[third-party-licenses/OpenScreen-MIT.txt](third-party-licenses/OpenScreen-MIT.txt). Both files
ship inside the application resources.

Each package also ships `THIRD-PARTY-INVENTORY.json`. The release gate regenerates
that file from the locked npm, Cargo, Swift, model, FFmpeg, WebAssembly, and bundled
asset inputs. A stale inventory or a third-party component without a licence claim
stops the build. Reviewed full licence texts are in `third-party-licenses/`. The
content-addressed `third-party-licenses/Cargo-Evidence.json` catalog preserves the exact
licence, notice, and declaration evidence for every locked third-party Cargo package. If a
published crate omits its full licence text, the catalog includes a reviewed, source-bound
supplement with the complete standard terms and copyright notice.
Electron's complete, version-matched Chromium notice ships as `LICENSES.chromium.html`. The
sections below call out native, copyleft, and separately
distributed components that need extra release attention.

---

## FFmpeg — shared libraries and tools

- **Components**: the FFmpeg command-line tool and shared `avcodec`, `avformat`, `avutil`,
  `avfilter`, `avdevice`, `swresample`, and `swscale` libraries under
  `resources/electron/native/bin/<platform>-<arch>/`. The exact set depends on the target.
- **Used by**: the native D3D11, Metal, and Vulkan compositor paths and native capture paths.
- **License**: **GNU Lesser General Public License v2.1 or later**
  (<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>). FFmpeg's own
  licensing page: <https://ffmpeg.org/legal.html>.
- **These are LGPL builds, not GPL builds.** Each target is configured without
  `--enable-gpl` and without `--enable-nonfree`, and links no GPL-only library
  (x264, x265, xvid, vidstab, rubberband, frei0r, …). `scripts/fetch-ffmpeg.mjs`
  verifies this before vendoring — it reads `ffmpeg -L`, `-buildconf` and
  `-encoders` and refuses any binary that reports otherwise.
- **Windows and Linux upstream binaries**: BtbN/FFmpeg-Builds, release
  `autobuild-2026-07-31-14-10`, the `*-lgpl-shared-8.1` assets. Pinned by
  SHA-256 in `scripts/fetch-ffmpeg.mjs`; the digests there identify the exact
  artifacts we ship.
  <https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-31-14-10>
- **macOS build**: Klippt builds FFmpeg 8.1.2 from the official release source. The package
  records the exact configuration reported by its own `libavutil` binary.
- **Corresponding source**: every release publishes the official FFmpeg 8.1.2 source, the
  exact FFmpeg commit `9b6c8969e05b4f0b29f0f85cd501be6b3e582e6b` used by BtbN, and
  BtbN build scripts commit `a99e8230eae00d1cee38f23076a7a1f55cd984e2`.
- **Target evidence**: each shipped target includes a source manifest, its exact embedded
  configure string and build command, hashes for every packaged FFmpeg file, and replacement
  instructions. A release fails if these files are absent or if the packaged build reports
  `--enable-gpl`, `--enable-nonfree`, a static build, or inconsistent configurations.
- **Relinking**: as required by the LGPL, these are dynamic libraries. You may
  replace them with your own build of the same FFmpeg version by overwriting the
  matching files in `resources/electron/native/bin/<platform>-<arch>/`. Re-sign the outer
  application package after a local modification when the platform requires it.

## whisper.cpp and ggml

- **Components**: `whisper-stt-server` and its ggml backend sidecars, under
  `resources/electron/native/bin/<platform>-<arch>/`.
- **License**: MIT — <https://github.com/ggml-org/whisper.cpp> and
  <https://github.com/ggml-org/ggml>.
- Built from source by `scripts/build-whisper-stt.sh`; the pinned upstream
  revision is in `electron/native/whisper-stt/CMakeLists.txt`.
- The speech model (`ggml-*.bin`) is **not** bundled — it is downloaded into the
  user's data directory on first use by `electron/stt/modelManager.ts`.

## FluidAudio and NVIDIA Parakeet TDT 0.6B v3

- **Component**: `klippt-parakeet-stt`, the primary local multilingual
  transcription helper on Apple Silicon.
- **FluidAudio**: version 0.15.6, Apache License 2.0 —
  <https://github.com/FluidInference/FluidAudio>.
- **Speech model**: `FluidInference/parakeet-tdt-0.6b-v3-coreml`, derived from
  NVIDIA Parakeet TDT 0.6B v3 and distributed under Creative Commons
  Attribution 4.0 — <https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml>.
- The model is not bundled. Klippt downloads only the INT8 runtime graph into
  the user's data directory. Every file URL is pinned to commit
  `7dd20fe6b1797d35f5e3307e8b1732d9a178edfe` and verified by SHA-256 in
  `electron/stt/modelManager.ts` before publication to the live cache.

## DeepFilterNet and libDF

- **Component**: the development-only `klippt-clean-voice` evaluation helper and its embedded
  DeepFilterNet 3 model. The helper is not part of the release payload until the creator-corpus,
  timing, preview/export parity, and long-session gates pass.
- **Upstream**: <https://github.com/Rikorose/DeepFilterNet>, based on v0.5.6 commit
  `978576aa8400552a4ce9730838c635aa30db5e61`. Klippt pins
  <https://github.com/oEdyb/DeepFilterNet/commit/b0fa238a331fb5cc39c5555d3538008dd88c0aef>,
  which adds only upstream commits `9524a0f` and `be00f46` so three zero hops can flush the
  standard model delay without an audible state clock. The embedded model SHA-256 is
  `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616`.
- **Engine source licence selected for evaluation**: MIT. Copyright (c) 2021 Hendrik Schröter.
- **Distribution status**: excluded. The exact embedded model artifact does not enter a
  package until its redistribution right is confirmed in writing. Klippt's helper glue code is
  AGPL-3.0-only like the rest of Klippt.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

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
  standalone `resources/web-demuxer.wasm`, used for streaming media demuxing.
- **Binary**: 3,150,317 bytes; SHA-256
  `f33a4d44f60dc2e6ca63b06063ae6de575b2b86cd45d92378e21bd8a01ff12d7`.
  The release gate requires it to be byte-for-byte identical to the full-build
  WebAssembly file in the locked `web-demuxer@4.0.0` npm package.
- **Wrapper source and licence**: MIT, commit
  `91721712b063bd65ac5963aa4e03e7eda4b17eff` —
  <https://github.com/bilibili/web-demuxer/commit/91721712b063bd65ac5963aa4e03e7eda4b17eff>.
- **FFmpeg source and licence**: GNU LGPL 2.1 or later, commit
  `e38092ef9395d7049f871ef4d5411eb410e283e0` —
  <https://github.com/FFmpeg/FFmpeg/commit/e38092ef9395d7049f871ef4d5411eb410e283e0>.
- **Toolchain**: Emscripten 3.1.60, Linux amd64 image
  `emscripten/emsdk@sha256:4a26506945f16291db0dbe5831bcd2748548f2f09c56bdc7de9a3ab2370ec127`.
- **Exact FFmpeg configuration**:
  `--target-os=none --arch=x86_32 --cc=emcc --ranlib=emranlib --disable-all`
  `--disable-asm --enable-avcodec --enable-avformat --enable-protocol=file`
  `--enable-decoder=h264,hevc,vp9,vp8`
  `--enable-demuxer=mov,mp4,m4a,3gp,3g2,mj2,avi,flv,matroska,webm,m4v,mpeg,asf,mpegts`.
- **Corresponding source**: every release publishes these immutable files beside
  the installers on both the Klippt update host and its GitHub release:
  `web-demuxer-4.0.0-source.tar.gz`, `ffmpeg-e38092ef9395-source.tar.gz`,
  `web-demuxer-4.0.0-source-manifest.json`, and
  `web-demuxer-4.0.0-relinking.txt`. The release manifest records their sizes and
  SHA-512 hashes. `supply-chain/web-demuxer.json` records their upstream SHA-256 hashes.
  The same offer contains the three native FFmpeg and build-script archives listed above;
  target-specific manifests select the applicable archives.
- **Relinking**: the WebAssembly file is outside `app.asar`. A recipient can rebuild
  it from the published wrapper and FFmpeg source with the exact manifest, then replace
  `resources/web-demuxer.wasm`. A locally modified macOS app must be re-signed after
  replacement. Klippt's terms must not prohibit reverse engineering needed to debug an
  LGPL-covered modification.

## Other reviewed runtime and asset rights

- **Electron and electron-updater**: MIT. Their exact versions and transitive npm graph come
  from `package-lock.json` and appear in `THIRD-PARTY-INVENTORY.json`. The exact
  `LICENSES.chromium.html` from the locked Electron runtime is copied outside `app.asar` and
  hash-checked after packaging.
- **Geist and Geist Mono**: SIL Open Font License 1.1. The complete `OFL.txt` is
  preserved beside the source font files and the asset group is recorded in the inventory.
- **Klippt icon and product mark**: original Klippt artwork, introduced
  in repository commit `272293b08db37f8d1f9868ba887dded1267e05fe`.
- **Default cursor sprites and bundled wallpapers**: OpenScreen repository contributions
  covered by the preserved upstream MIT licence.
- **Legacy Sweezy cursor packs**: not distributed or selectable. No
  redistribution grant was recorded, so builds copy only the reviewed default sprites.

## OpenScreen-derived native helpers

`wgc-capture` (Windows Graphics Capture), the ScreenCaptureKit helper (macOS),
the PipeWire helper (Linux) and the compositor addon are part of this repository
and are covered by [LICENSE](LICENSE) (AGPL-3.0-only), with the OpenScreen-derived parts also
under the preserved OpenScreen MIT notice.

---

Before release, direct notice or source requests to the Klippt support channel.
Do not send Klippt product support requests to the OpenScreen project.
