# Inspector redesign — September 8

## Brief and direction

Klippt's side panels are tools for arranging a recording, not a settings catalogue. The live
review covered Background, Video Effects, Layout, Cursor, Audio, Automatic, Captions, Transcript,
and selected zoom/caption panels. It found oversized position pads, camera controls below the
fold, repeated explanations, one-option choice sections, and inconsistent density.

Retain the existing graphite/light surfaces, steel selection color, body typography and numeric
font. Use the existing Radix foundation. Selection is a filled surface, never a tiny edge border.
The defining change is task grouping: Canvas/Screen/Camera and Voice/Pauses/Music/Delivery.
No new dependency, palette, decorative animation or media model is needed.

## Acceptance checks

1. Canvas, screen and camera settings are independently reachable without scrolling through the
   other tasks; camera size is near the start of its section.
2. Audio analysis is visible beside the pause preset; voice, music and delivery do not compete
   with the pause workflow. Unavailable cleanup has a visible reason.
3. Caption correction reads as a compact sequence of words; stable word IDs, timing, validation,
   save failure recovery and Undo stay intact.
4. Video Effects and Cursor use compact shared rows. Field help remains keyboard accessible;
   a sole cursor theme is not shown as a choice. Cursor size displays a real multiplier.
5. Empty automatic editing shows one explanation instead of a disabled form. Existing effects
   can still be reviewed when recording evidence is unavailable.
6. Task switching works with the keyboard, hides inactive controls from accessibility, and
   preserves input drafts. Controls remain usable at the supported minimum window width.
7. Inspect all eight panes in the real Mac app after changes, including light/dark rendering,
   caption selection and the selected zoom panel. Run relevant tests and install the signed app.

## Implementation references

- [Radix Tabs](https://www.radix-ui.com/primitives/docs/components/tabs): keyboard activation,
  associated panels and force-mounted draft preservation. Inactive mounted panels explicitly
  receive `hidden`, as well as the inactive style. Installed package/API used without an upgrade.
- [Radix Collapsible](https://www.radix-ui.com/primitives/docs/components/collapsible): considered
  for progressive disclosure; existing advanced disclosure remains sufficient. Do not hide every
  control in another accordion.
- Existing InspectorSlider, InspectorActionButton, AppSelect and design tokens remain the controls
  and visual foundation. Media callbacks and project persistence remain in their existing owners.

## Verification

Final full suite: 284 files passed, 2,944 tests passed and one skipped. App/test TypeScript
checks, lint, locale structure checks and Vite production builds passed. Lint retains the
existing oversized Cargo-Evidence.json warning. New translated-key structures use English
fallback text pending translation. Existing transcript keyboard-cut, gating and shared-media
checks also passed (18 focused tests).

Live Mac review used the isolated 46.4-second fixture, not the user's original project. All eight
panes and the selected zoom/caption panels were inspected. Layout, Audio and caption correction
were checked at the supported minimum width (768 logical px). Light and dark themes were
inspected. Camera and caption screenshots are in `artifacts/inspector-redesign-2026-09-08/`.

The shared Tabs test verifies keyboard activation, hidden accessibility state and preservation
of a draft across task changes. Live mouse switching was verified; the computer-use key API
rejected arrow-key names, so the final arrow-navigation check is automated evidence rather than
a claimed live Mac keyboard pass. No new animation was introduced. System Reduce Motion was
not toggled. Caption corrections continue to require one word per timed field; this redesign
makes that editing surface compact but does not add word insertion or retiming.

Preview/export engines and media files are unchanged. Cursor controls now display meaningful
units while retaining their stored/native units. The full native export from the preceding UX
pass remains evidence for that unchanged export path; this slice does not claim a new export
benchmark. Local installation status follows below.


## Local delivery

Installed at `/Applications/Klippt.app`, signed by Dyberg & Co AB (LF8KF3G42Q). Staged and
installed bundles passed `codesign --verify --deep --strict`. The previous app is preserved at
`Archived Apps.noindex/installed-before-panels-20260908.app` under Klippt Application Support.
This is a signed local development update; notarization/public release was not attempted.

The installed editor reopened the unchanged 20.3-second project with Saved state, its existing
captions and manual zoom. The simplified unavailable Automatic state and final Camera pane were
checked live. `installed-camera.jpg` is the installed-build screenshot. The canonical app is left
open on Layout → Camera. Vault validation reports nine pre-existing unrelated errors.
