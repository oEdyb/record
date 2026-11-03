# OpenScreen → Klippt upstream sweep, 2026-11-03

Follows [the 2026-10-31 sweep](openscreen-upstream-sweep-2026-10-31.md), which covered upstream
through `b4432a85ac6917351e5d2974381f265f4e909e1f`. This one covers upstream/main through
`7aa7b9df2` (v2.2.1) plus PRs and issues opened or updated since 2026-10-31.

## Ported

| Upstream | Klippt | Note |
|---|---|---|
| `bfd5bc329` (#1453) keep the user's `--enable/--disable-features` on Wayland | cherry-pick | Clean. |
| `8ecc76b77` (#1460) tag the MP4's colour matrix, primaries, transfer, range | by hand | Linux tags BT.601 limited because Klippt converts with swscale defaults (no `yuv.wgsl`, no VA-API encoder); macOS and Windows shaders are BT.709 limited. Linux test added. |
| `7fda7c30f`, `3af33042d`, `4cc2d878e` (#1442) accept the system language prompt on Enter | cherry-pick, adapted | Klippt renders the prompt once; the popover test opens device settings, Klippt's popover. |
| `31d081da6` OpenScreen LICENSE copyright line | notice update | `third-party-licenses/OpenScreen-MIT.txt` matches upstream/main `LICENSE`. |

## Skipped

- `5ae165e46` (#1451) shared wgpu device in Linux compositor tests: works around a Vulkan-Loader
  1.4.341 crash on Ubuntu 26.04 CI runners. Klippt's CI does not run Linux compositor tests.
- `2477d0368`, `5e87ff394` (#1469, #1470) CLI v2 export keeps render settings: `src/cli/exportProject.ts`
  and `loadCliProject.ts` do not exist in Klippt.
- `a2d4489d8` … `79ead01d9` (#1463) Windows updater UAC series: builds on upstream's silent NSIS
  install (#1439, not in Klippt) and adds `windows-update.ts` and MCP recorder hooks Klippt lacks.
  Windows is not a tested Klippt target.
- `87f3f83f1` website copy, release chores (#1466, #1471), RC update check (#1448).
- Open feature PRs: #1472 Polish locale (Klippt's locale keys differ), #1443 cursor size %, #1417
  touchscreen cursor, #1382/#1381 recording management, #1331 OS log folder, #1288 floating camera.

## Listed, not ported

- **[PR #1446](https://github.com/getopenscreen/openscreen/pull/1446)** / **[issue #1445](https://github.com/getopenscreen/openscreen/issues/1445)**
  COSMIC Wayland: `error alloc buffers: Invalid argument`, then black frames. Klippt's helper offers
  the same shm + modifier EnumFormats and asks for DmaBuf-only buffers when the modifier format wins
  (`electron/native/pipewire-capture/csrc/pw_shim.c`), so the same failure is likely. The PR builds on
  upstream's DMA-BUF import and shm-retry path, which Klippt does not have; a fix needs a new retry
  and a COSMIC machine to verify.
- **[PR #1406](https://github.com/getopenscreen/openscreen/pull/1406)** Hyprland recording with cursor
  positions and GPU import: large (+4825), open, unreviewed.
- Open Linux reports to watch: [#1450](https://github.com/getopenscreen/openscreen/issues/1450)
  exported video quality, [#1452](https://github.com/getopenscreen/openscreen/issues/1452) camera not
  detected on Ubuntu 26.04 Wayland, [#1465](https://github.com/getopenscreen/openscreen/issues/1465)
  desktop recording quality.
