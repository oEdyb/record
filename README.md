# Klippt

Free, open-source Linux screen recorder that records in clips, with local speech cleanup and no
account.

Record in clips, pause and continue, drop a bad
clip while you record, review the take, then save the untouched source files or one finished video.
Speech-based cleanup ("Clean cut") runs a local Parakeet speech model on your machine. Your audio
and video never leave it. Clean cut has one optional extra, the Claude check, which is off until you
turn it on in the Clean cut panel. When on, the recording's transcript text (words, not audio or
video) is sent to Claude by running the `claude` command-line tool you have installed, under your
Claude account and Anthropic's terms. Without it, nothing is uploaded.

Linux is the main platform. macOS also works. There is no trial or telemetry.

## Built on OpenScreen

Klippt is a fork of [OpenScreen](https://github.com/getopenscreen/openscreen).
[Siddharth Vaddem](https://github.com/siddharthvaddem) created OpenScreen.
[Etienne Lescot](https://github.com/EtienneLescot) and the OpenScreen contributors maintain the
current continuation. Inherited code keeps its MIT notice, in
[`third-party-licenses/OpenScreen-MIT.txt`](third-party-licenses/OpenScreen-MIT.txt). Klippt as a
whole is AGPL-3.0-only. It is a separate project.

Klippt changed the recording flow to clips with pause and continue and clip removal, added a Linux
PipeWire capture helper, added Clean cut with a local Parakeet speech model, added untouched source
handoff, added the `.klippt` project format, and removed the inherited third-party cursor packs.

![Recording review on Linux](artifacts/linux-port-2026-10-26/cursor-preview/review.png)

## Status

Early and usable. The recorder, review, clip removal, source handoff, and MP4/GIF export work on
Linux (Wayland, PipeWire) and macOS. There is no signed public release yet; build it yourself.

Known limitations:

- Wayland cannot hide Klippt's own windows from a full-display recording. Record a window, or put
  the controls on another display.
- Speech models download from `huggingface.co` the first time you use Clean cut or the transcript
  (several hundred MB). That request carries no recording data.
- The Windows capture helper exists but is not tested right now.
- Klippt makes no automatic network calls for updates. Choosing Check for Updates in the tray menu
  contacts `updates.dyberg.co`, which has nothing to serve until the first signed release, so the
  check reports an error for now.

## Build and run on Linux

You need Node `22.22.1`, npm `10.9.4`, Rust/Cargo with rustfmt (rustup's default install has it), a C compiler, libclang, EGL/GLES headers, and
patchelf 0.18 or newer. At runtime you need PipeWire, an XDG ScreenCast portal for your desktop,
and a Vulkan driver for the compositor preview. niri uses the GNOME portal backend.

```fish
npm ci
npx install-electron --no
npm run fetch:ffmpeg
npm run build:native:linux
npm run build:native:compositor:linux
npm run dev
```

Packages (AppImage, deb, pacman, rpm): `npm run build:linux`. Output lands in `release/<version>/`.

## Build and run on macOS

You need Xcode command-line tools, Node `22.22.1`, npm `10.9.4`, and Rust/Cargo.

```fish
npm ci
npm run build:native:mac
npm run build:native:parakeet:mac
npm run fetch:ffmpeg:mac
npm run build:native:compositor:mac
npm run dev
```

`npm run build:mac` makes a DMG; signing and notarization need your own Apple Developer ID. See
[`technical-documentation/engineering/build-and-packaging.md`](technical-documentation/engineering/build-and-packaging.md).

## Checks

```fish
npx tsc --noEmit
npm run lint
npm run test
```

## More

- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to send a change.
- [`AGENTS.md`](AGENTS.md): product and engineering rules.
- [`technical-documentation/`](technical-documentation/README.md): architecture and testing.

## License

Copyright (C) 2026 Olle Dyberg. Licensed under the GNU Affero General Public License v3.0 only;
see [`LICENSE`](LICENSE).

Bundled components and their licences are listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
