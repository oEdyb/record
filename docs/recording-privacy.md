# Recording privacy and source loss

HUD privacy owns visibility only. `LinuxRecordingHud` has no transport capability.
`LinuxHudLifecycle` serializes placement, cancellation and visibility recovery through one
explicit state value and one transition function. A retry can reveal controls once capture
has paused or the isolation guard proves them safe; it cannot send a recording command.
An explicit Open app request while controls are concealed shows a status dialog whose
wording distinguishes a covered location from unavailable monitoring. Clips that start
covered enter recovery immediately. Visibility retry ticks restart failed observers.

`NiriCaptureWindowGuard` also has one state value and one transition function. A covering
cast conceals the HUD but leaves the compositor event subscription alive. The guard retains
its last known floating-window footprint while the HUD is unmapped. It evaluates that
footprint against current casts, workspaces and outputs before restoring the window.
Restoration does not focus the window. Deliberate Hide, Studio handoff and Stop retire the
subscription. Invalid compositor data or a disconnected observer fails closed.

Removing a PipeWire producer does not necessarily disconnect its consumer. The C shim
subscribes to registry removal of the selected node and sends source loss through the same
generation-filtered stream callback as terminal stream errors. Normal paused/connecting
stream states remain nonterminal. Listener teardown precedes session deallocation.

The renderer defers interruption handling while transport is busy. Linux source death saves
a live take and requests a native alert only after accepting that event. A user-paused take
remains paused and can select a replacement source. Sleep and low-disk handling retain
their existing policy. Transport diagnostics record controls, Studio, explicit keyboard
shortcuts and interruption reasons, including legacy Linux IPC.

## Verification boundary

The renderer regression fails with the HUD implementation from `966e4be3a` and passes with
the fix. Repeated guard tests include window unmap/remap, six actual observer callbacks,
and live and user-paused renderer state. A private KWin recording also exercises real
concurrent portal clients; this does not establish Niri recording behavior.

On installed Niri 26.04 (`8ed0da4`), an isolated nested monitor cast fails in `StartCast`
with `no GBM device available`. Its Winit and headless backends both return no GBM device.
Consequently real Niri base/fix recording parity remains unproven. Do not substitute the
KWin test or synthetic cast events for that evidence. Restoration uses the last known
floating-window position. If Niri remaps the window elsewhere inside a capture, it may
appear briefly before the observer conceals it again. This position risk remains unproven.

Primary contracts inspected:

- [Electron BrowserWindow visibility](https://www.electronjs.org/docs/latest/api/browser-window).
- [PipeWire stream negotiation](https://docs.pipewire.org/page_streams.html).
- Vendored PipeWire 1.0.5 registry interface in the helper's `vendor/` directory.
- [Installed Niri backend GBM contract](https://github.com/niri-wm/niri/blob/8ed0da4/src/backend/mod.rs).
- [Installed Niri headless backend](https://github.com/niri-wm/niri/blob/8ed0da4/src/backend/headless.rs).
