# Compact recorder notifications — October 27

Source `8c3838db993f51004829913977afda6d7204c63a`; AppImage inventory
`release/linux-port-20261027-8c3838db/`. [Measurements](result.json).

The old packaged no-camera error overlaps Setup: y268–321.5 inside panel y96–442,
and its right edge extends beyond the panel. The corrected normal-FUSE AppImage
places a 360×40 toast at y452, ten pixels beyond Setup and outside the controls.
Text is 12px; padding 10px/12px. One notice is visible at a time. The empty slot
releases its reserve. The check uses real private compositor keyboard input and
actual missing-device failure, not an injected error or DOM click.

138 tests across the affected recorder, geometry and shared Toaster suites pass.
Both typechecks, changed-file lint, docs/design and package policy pass. All 27
regular native ELFs match a4f92422; no full suite, native rebuild or media soak.
React Doctor repeats the existing geometry-effect cleanup finding; this slice
adds no subscription/timer. Desktop checks use private KWin, not physical Niri.

Screenshots: `/tmp/klippt-toast-before-no-camera.png`,
`/tmp/klippt-toast-packaged-no-camera.png`. Raw screenshots remain local.
The launcher points at this build; a running old app needs reopening.

Separate open defect: recorder UI appears in full-monitor footage on Niri.
This build does not claim own-window exclusion or automatic recorder hiding.
