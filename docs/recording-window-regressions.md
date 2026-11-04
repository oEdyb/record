# Recording window regressions

## Studio split disappearance

`StudioSeparator` treated pointer travel below 10% or above 90% as a collapse command.
The outer split then set transient `dockHidden`, removing the entire camera/replay dock;
the inner split saved a single-pane `view`. Neither action controls capture writers.

Resizing now always uses the existing bounded size setters. Home/End also resize instead
of collapsing. Explicit camera/replay view buttons remain available. Saved numeric split
and dock fractions already normalize on load; regression tests cover both extremes.
The old transient hidden dock can be recovered with the header's two-panel button.
No profile edit or restart is needed.

Verification: the new Studio keyboard regression fails against the original implementation
and passes after removing collapse. Studio, preference and Linux HUD unit tests: 63 passed.

## Webcam restore

The preview is frameless and `resizable: false`. On Electron 44.9.1, expanding
with `setBounds` updates Wayland's fixed min/max dimensions, but collapsing with
`setSize` leaves the expanded minimum in force. This reproduced under private
nested niri 26.04: 312×186 → 1200×700 → failed 312×186 request (still 1200×700,
minimum 1200×700, not maximized). Replacing the shrink with `setBounds` returned
312×186 and updated its min/max. Compact grip resizing uses the same correction.
No resizable/maximizable flags or Mac/Windows policies changed.

Reference: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
(`setBounds`, `setSize`, size constraints, Linux maximize flag limitations).
Wayland owns global placement; app bounds requests do not establish real compositor
position restoration. Native compositor maximize/fullscreen remains a separate check.

## Recording bar disappearing during capture

`NiriCaptureWindowGuard` revokes visibility if output/workspace/window isolation becomes
unsafe (including overview), or the event stream fails. Its HUD callback called
`LinuxRecordingHud.conceal`, which hid the bar without pausing the writer. This was
intentional capture privacy, not a timed close. Recovery previously depended on the tray
or recording shortcuts. Mid-take conceal now requests one pause, then restores controls
only after writer acknowledgement. Startup conceal still stays hidden while recording.

This code path is reproduced by a regression that fails before and passes after the
change. It is a supported cause, not a confirmed diagnosis of the reported incident:
the installed process sent stdout/stderr to `/dev/null`, its journal had no app logs,
and the inspected recent coredump list contained portal crashes but no Klippt crash.
No user recordings were inspected. A renderer crash remains a different path:
`main.ts` calls `stopTakeWithoutPill` to save and open review.
