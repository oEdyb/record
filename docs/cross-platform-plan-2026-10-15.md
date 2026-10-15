# Windows and Linux plan (research, 2026-10-15)

Olle decided on 2026-10-15 that Klippt should not stay Mac-only. This note records the research and
the delivery order. Nothing here is built yet.

## Decision

One clip-native capture contract, one shared TypeScript recording service, and one native helper
per platform. The macOS helper's JSON-line protocol is the contract. Windows comes first because
its helper is further along and its market is larger. Linux follows on the same contract.

## What exists today

- **Windows.** `electron/native/wgc-capture` (C++, WGC + Media Foundation + WASAPI + DirectShow)
  records one file per take. Pause subtracts time inside that file (`main.cpp:95-105`). Mic and
  system audio are mixed into the screen MP4. No clips, no `clip-finalized`, no JSON errors, no
  recovery journal, no quit guard, no standby. Electron waits on legacy text lines
  (`handlers.ts:1442-1486`, `nativeWindowsCaptureStop.ts:73`). Main-process state is about twelve
  module globals (`handlers.ts:842-879`).
- **Linux.** `electron/native/pipewire-capture` (Rust, ashpd 0.9 + PipeWire shim) with a
  VAAPI → Vulkan → openh264 ladder (`encoder.rs:9-13`). Pause freezes a clock
  (`capture.rs:206-208`). The portal never persists the pick (`portal.rs:215-237`). Packages:
  AppImage, deb, rpm, pacman, AUR, Nix; Flatpak is a spike.
- **macOS reference.** The contract in practice: spawn with a JSON request or `--standby`; stdin
  `pause` / `resume` / `stop` / `reconfigure`; events `recording-started`, `original-started`,
  `clip-finalizing`, `clip-finalized`, `recording-paused`, `recording-resumed {clipIndex}`,
  `recording-stopped {clips[]}`, `warning`, `error {code}`. Clip removal and the recovery journal
  live in TypeScript (`nativeMacRecordingService.ts:452-493`, `nativeMacRecoveryJournal.ts`).
  `NativeMacRecordingService` already reaches the helper only through a `Pick` of the client
  (`nativeMacRecordingService.ts:41-52`), which is the seam to widen.

## Upstream OpenScreen

Merge base `c477979d` (2026-08-15). Upstream has 63 commits in `wgc-capture` since then and we
have none, so the C++ can fast-forward. Take, in order:

1. A/V sync: `13366eba`, `85aeaf08`, `95fa7363`, `27efde0e`, `e8b85444`, `4ebe3ce7`, `f9c40355`,
   `7e6cde3f`. Fragmented-MP4 sample durations made a 10-minute take 217-383 ms short against
   audio (upstream #1164); our copy uses the same sink (inferred affected, not measured).
2. Audio devices and mixer: `50866fd0`, `af5d8fd3`, `025b2b2a`, `ebfec67e`, `d108bdd5`,
   `343c4078`, `42d15e67`, `fe28dafe`.
3. Performance and color: `e9430049`, `9e45f7c7`, `1f5d9d8f`, `c7298340`, `3847cf3b`.
4. Webcam real mode: `d93a2b1a`, `6286fd4c`, `9c55596e`, `1a0b369f`, `6974e30e`, `c6d3064b`.
5. Packaging: arm64 `496253c2`, `c3e2e98a`; HUD on Windows 10 `5922656b`, `923a2c42`.

Upstream has no Windows clip-per-pause and no Windows recovery journal. Stop-hang issue #252 is
still open upstream.

## Windows stack

- **Capture.** WGC with a free-threaded `B8G8R8A8` frame pool; pace from `SystemRelativeTime`
  (QPC) because `MinUpdateInterval` is 24H2+. Minimum Windows 10 2004 (19041).
- **Own windows hidden.** Electron `setContentProtection(true)` maps to `WDA_EXCLUDEFROMCAPTURE`
  (19041+). Verify in a real recording; no source states WGC honors it.
- **Yellow border.** Removal needs consent plus a manifest capability (`IsBorderRequired`,
  20348+). Untested for an unpackaged NSIS app.
- **Encode.** MF SinkWriter with `IMFDXGIDeviceManager` and the hardware MFT, CPU MFT fallback.
  Direct NVENC/AMF/QSV only if benchmarks demand it.
- **Clips.** One writer per source per clip. Keep the D3D device, device manager and encoder
  alive across Pause; create only the sink and file at Continue. Encoder reuse across sinks is
  unverified and must be prototyped first, because instant Continue depends on it.
- **Audio.** Separate mic and system files. Process loopback excluding our PID on 20348+, plain
  loopback below. Recover from `AUDCLNT_E_DEVICE_INVALIDATED` with silence fill. QPC timestamps;
  correct drift slowly over 60 minutes.
- **Camera.** `IMFSourceReader` to NV12, preferring native NV12/YUY2 over MJPEG.
- **Signing.** Azure Artifact Signing (EU organizations eligible, about $9.99/month, identity
  validation 1-20 business days). EV no longer bypasses SmartScreen. Sign the helper and DLLs too.
  NSIS + electron-updater, x64 and arm64. Microsoft Store as a second channel later.
- **Testing.** One real Windows 11 PC with an NVIDIA or Intel GPU is the gate. A Parallels
  Windows 11 ARM VM on the Mac covers capture logic and the CPU path (no hardware encode, per a
  2025 forum report). GitHub runners: unit tests and packaging only. This Mac already has UTM VMs
  "Koett Windows 11" (ARM64) and "Koett Fedora 44" (GNOME Wayland), used for Koett's
  cross-platform checks; reuse them for the VM steps.

## Linux stack

- Keep the Rust helper. Upgrade ashpd (0.9 → 0.13), use `persist_mode=2` with a stored token and
  a "choose again" control, so Pause/Continue never re-prompts.
- Clips: close and reopen files inside one portal session.
- Keep the encoder ladder and move to fragmented MP4 (upstream #944: plain MP4 loses a crashed
  take).
- **Product gap.** Wayland has no general way to exclude the app's own windows. Either capture a
  window source by default or document that the HUD must sit on another display. Olle decides.
- Market: Linux is 2-9% of desktops depending on source; no data on paid creator tools.

## Delivery order

Each step ends in a check that runs before the next starts.

1. **Start the clocks (Olle, no code).** Azure Artifact Signing identity validation; a Windows
   waitlist line on the site; a Windows 11 test PC.
2. **Shared contract on the Mac.** Move the Mac request, event and clip types to a shared
   protocol module, turn the `Pick` into a `CaptureHelper` interface, inject clip and original
   path templates. Check: full suite plus a real Mac take with pause, Backspace and quit.
3. **Fast-forward `wgc-capture` to upstream** (the five groups above). Check: Windows CI build
   and helper unit tests.
4. **Windows clip-per-pause in C++** with the contract's events and error codes, separate mic and
   system files. Check: Parallels VM take with three clips and a Backspace.
5. **Route Windows through the shared service** and delete the Windows globals and handlers,
   with recovery, quit guard and startup restore on win32. Check: kill the helper mid-take in the
   VM and reopen the take.
6. **Real PC gate.** 5, 30 and 60 minute takes, all four audio combinations, repeated
   Pause/Continue, hardware encode, own windows absent, drift under one frame. Then signed
   x64/arm64 NSIS to a closed beta from the waitlist.
7. **Linux** on the same contract after Windows ships.

## Sources

Microsoft Learn: GraphicsCaptureSession, IsBorderRequired, MinUpdateInterval,
SetWindowDisplayAffinity, MF_SINK_WRITER_D3D_MANAGER, MFCreateFMPEG4MediaSink, loopback recording,
AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, Artifact Signing quickstart (2026-10-08), SmartScreen
reputation (2026-05). Electron BrowserWindow `setContentProtection`. xdg-desktop-portal ScreenCast
docs. Parallels KB 129497. Tella Windows changelog, Cap release notes, screen.studio FAQ.
