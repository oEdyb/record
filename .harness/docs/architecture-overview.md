# Klippt architecture notes

This is the short map for repository agents. Read [`../../HANDOFF.md`](../../HANDOFF.md) for current
state and [`../../AGENTS.md`](../../AGENTS.md) for product rules. Use
[`../../technical-documentation/architecture/overview.md`](../../technical-documentation/architecture/overview.md)
for the complete process model.

## Process layout

Klippt has four main runtime boundaries:

1. **Electron main process** in `electron/` owns windows, trusted IPC, project/media grants,
   recording orchestration, native helpers, entitlements, updates, and export publication.
2. **React renderer** in `src/` owns the editor, HUD, source selector, timeline, inspector, and
   project interactions. Production pages load from `klippt://app` with sandboxing and
   `webSecurity` enabled.
3. **Native capture helpers** under `electron/native/` own platform capture and media writing:
   ScreenCaptureKit/AVFoundation on macOS, WGC/Media Foundation on Windows, and PipeWire/portal on
   Linux.
4. **Native compositor** under `crates/` owns preview composition and export rendering through the
   `compositor_view.node` N-API boundary. Platform GPU backends include Metal, D3D11, and WGSL.

## Recording flow

```text
HUD -> source and device setup -> countdown -> native capture helper
    -> fragmented clip files + role metadata + sidecars
    -> project document -> editor timeline
```

Pause finalizes one clip while the logical recording session stays active. Continue creates the next
clip. Remove previous clip changes project state without deleting recoverable media. Stop opens the
same project in the editor.

## Preview and export

The project document maps into one native scene contract. The editor preview pulls RGBA frames from
an offscreen native compositor view. Export uses the same scene semantics at the chosen output
resolution. Preview size is capped to the visible CSS panel; export resolution stays independent.
The export publisher writes to a same-directory stage, verifies the result, synchronizes it, and
atomically replaces the destination.

## Security boundary

Renderer resources and approved media use `klippt://app`. Local media URLs represent opaque grants,
not arbitrary paths. Privileged IPC validates the exact origin, top-level frame, sender, role, and
payload before it reaches application logic. Navigation, webviews, unexpected windows, and unrelated
permission requests fail closed. Production fuses require the integrity-checked ASAR.

## Change impact

- Recording changes usually cross React, Electron, and one native helper. Split broad work before
  implementation.
- Editor-only changes stay in the renderer when they do not change the project or scene contract.
- Preview or export changes need parity tests and a real Mac check.
- Native helper changes need a rebuilt helper. A Vite/Electron build can run stale native code.
- New privileged actions must use the central trusted IPC wrapper and the narrowest preload surface.

Current gaps and the next slice are in [`../../HANDOFF.md`](../../HANDOFF.md).
