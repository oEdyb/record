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
