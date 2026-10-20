---
title: Third-party notices
description: Open-source software in Klippt and where to get its source.
---

# Third-party notices

Klippt contains open-source software. Each copy of Klippt includes the full notices and license
texts in `Klippt.app/Contents/Resources/`: `THIRD-PARTY-NOTICES.md`, `THIRD-PARTY-INVENTORY.json`,
`LICENSES.chromium.html` and the `third-party-licenses` folder. To see them, right-click Klippt in
Applications, choose Show Package Contents, and open `Contents/Resources`.

Klippt is derived in part from [OpenScreen](https://github.com/getopenscreen/openscreen), which is
MIT licensed. Its copyright and permission notice ship in the app's `LICENSE` file.

## FFmpeg (LGPL)

Klippt uses FFmpeg 8.1.2 under the GNU Lesser General Public License v2.1 or later, built without
GPL or non-free components and linked dynamically. You may replace the FFmpeg libraries in
`Contents/Resources/electron/native/bin/darwin-arm64/` with your own build of the same version.

The complete corresponding source for each release is on our update server:

- [ffmpeg-8.1.2-macos-source.tar.xz](https://updates.dyberg.co/klippt/ffmpeg-8.1.2-macos-source.tar.xz)
- [web-demuxer-4.0.0-source.tar.gz](https://updates.dyberg.co/klippt/web-demuxer-4.0.0-source.tar.gz)
  and [ffmpeg-e38092ef9395-source.tar.gz](https://updates.dyberg.co/klippt/ffmpeg-e38092ef9395-source.tar.gz),
  for the bundled WebAssembly decoder, with
  [relinking instructions](https://updates.dyberg.co/klippt/web-demuxer-4.0.0-relinking.txt)
- Per-release build evidence: `native-ffmpeg-darwin-arm64-source-manifest.json`,
  `native-ffmpeg-darwin-arm64-configuration.txt` and `native-ffmpeg-darwin-arm64-relinking.txt`
  in the same folder

For a copy on physical media, email [support@klippt.app](mailto:support@klippt.app). This offer
is valid for three years after the last release that included the component.
