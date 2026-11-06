# Studio renderer implementation — 2026-10-30

Functional renderer port implemented inside the assigned boundaries. No commit, push,
Electron launch, native capture pass, or installed-app replacement was performed.
Existing camera-sync changes in StudioReplay.tsx and useStudioLiveCamera.ts were preserved.
The API and pill engineer's files were not edited.

## Files

Paths in this section are relative to src/components/studio unless otherwise stated.

- StudioWindow.tsx — snapshot-driven four-phase shell, commands, layout and recording hold.
- StudioWindow.module.css — warm serif reading surface, calm live view, responsive dock and capture row.
- StudioHeader.tsx — drag strip, macOS traffic-light clearance and text/dock/window controls.
- StudioSetup.tsx — source picker, input toggles, selected-mic meter and device/quality/cursor commands.
- StudioDialog.tsx — native modal focus containment, Escape dismissal and opener restoration.
- StudioNotes.tsx — safe text rendering of saved notes, following storage updates.
- StudioCamera.tsx — relayed camera canvas, live identity, dimming and framing guides.
- StudioDock.tsx — Replay/Both/Camera views, pane order and camera-only playback transport.
- StudioSeparator.tsx — pointer/keyboard resizing, accessible values and collapse focus recovery.
- StudioReplay.tsx — sentence play requests, keyboard playback, rate and skip controls; retains camera sync.
- StudioSeekBar.tsx — bounded seeks, time-valuetext and isolated slider keys.
- StudioTranscript.tsx — native sentence buttons, aria-current, following, removal focus recovery and Now.
- StudioRail.tsx — duration-weighted clip navigation and sparse labels for long takes.
- StudioTransport.tsx — shared pill controls, authoritative Remove/Undo state and Finish handoff.
- studioCommandState.ts — one pending command authority, logged rejection, correlated completion and timeout release.
- studioCommandState.test.ts — duplicate/stale rejection and unrelated-snapshot regressions.
- studioLayout.ts — pure dock bounds, pane rules, shortcut guards and sentence navigation.
- studioReaderAnchor.ts — preserves a visible sentence across explicit layout changes.
- useStudioKeyboard.ts — document-scoped shortcuts with editing, modifier, composition and modal guards.
- useStudioSnapshot.ts — subscription cleanup and elapsed time derived from acknowledged capture state.
- useStudioTranscriptStatus.ts — existing transcription download/error/manual-refresh behavior.
- StudioWindow.test.tsx — fake-snapshot phase, command, lock, replay-hold, sentence, shortcut and cleanup tests.
- studioLayout.test.ts — bounds, pane visibility, sentence navigation and shortcut-guard tests.
- studioTranscriptModel.test.ts — updated the existing fixture for the supplied setup/pill API.
- src/lib/userPreferences.ts — normalized, persisted studioLayout, including shortcut opt-out.
- src/lib/userPreferences.test.ts — malformed layout and persistence tests.
- src/i18n/locales/{ar,en,es,fr,it,ja-JP,ko-KR,pt-BR,ru,tr,vi,zh-CN,zh-TW}/launch.json — translated Studio labels and keyboard maps.
- IMPLEMENTATION.md — this handoff and remaining differences.

## Differences from the mockup

Binding contract differences:

- Uses the actual pill controls and their order instead of mockup recording buttons.
  There is no Studio-only redo or Record more action. Finish sends `finish` to the
  existing review window rather than displaying an in-Studio export handoff.
- Preferences live in userPreferences.studioLayout rather than the mockup's raw key.
- Native traffic lights are left to Electron; the renderer reserves their space.

Other differences and limitations:

- Option menus use the shared AppSelect, rather than native select elements. The existing
  repository design-policy test rejects native selects. AppSelect handles menu keyboard input.
- Existing replay media styling, recorded-camera inset and native recording aspect ratio
  are retained rather than reproducing the simulated 16:10 screen and recorded chip exactly.
  Replay's clip counter is its position in the take; transcript/rail labels retain clip identity.
- Transcript keeps a single clip-start label rather than the mockup's start/end/duration row.
  Only the active sentence has a hanging time; the rail has no separate viewport indicator.
  These are remaining visual gaps, not API blockers.
- Dock defaults use a responsive persisted width fraction and minimum pane sizes rather
  than exact 440/560-pixel presets. Pause starts at half width and can be resized.
- Playback speed is shown as a readout and changed with comma/period, rather than a popup.
  Pane controls use browser title tooltips, not the mockup's dock-contained delayed tooltips.
- Mic level is a labelled meter in setup, not an animated arc around the shared Record button.
  Live metering is opt-in through V. There is no independent system-audio level display.
- Setup uses generic microphone/camera labels; device names are offered inside Devices.
  The source control uses the real source name. Notes use safe plain text derived from the
  shared saved HTML, rather than the mockup's numbered, styled sample notes.
- Title is Studio plus the acknowledged phase; it does not invent a take title or date.
- Countdown uses the supplied boolean state and the pill's cancellable Record action;
  there is no renderer-owned countdown or fabricated numeric count.
- Status announces phase, transcript completion count and removal availability. Explicit
  restoration wording is not separately announced. Reader anchoring is implemented for
  explicit layout changes; resizing and font reflow have not been visually verified.

The approved HTML was opened in headless Chrome and all four phases were clicked.
The existing fix verifier exercised sizes, view modes, dock side, device dismissal,
slider and separator keys before failing on its obsolete `[data-a="redo"]` selector.
Screenshots from that mockup exercise were saved under /tmp/studio-mockup-check.
No screenshot comparison of the implemented renderer was performed. Pixel parity,
actual camera relay, actual audio metering, native focus behavior, capture, playback
of real media and export remain unverified by this renderer-only test pass.

## API gaps

No command API was added or changed. The supplied API covers the implemented actions.
It does not expose numeric countdown progress, independent system-audio input levels,
a take title/creation timestamp, or selected device display names in the snapshot.
Those display details were not fabricated. Device enumeration supplies option names.

## Verification

- PASS: `npx tsc --noEmit`
- PASS: `npx tsc -p tsconfig.test.json --noEmit`
- PASS: `npm run i18n:check` — all 12 translations match English, six namespaces.
- PASS: `npx vitest --run src/components/studio src/lib/userPreferences.test.ts scripts/check-design-policy.test.mjs` — 53 tests.
- PASS: `npx biome check src/components/studio src/lib/userPreferences.ts src/lib/userPreferences.test.ts src/i18n/locales/*/launch.json` — 38 files.
- PASS: `git diff --check`
- FAIL: `npm run lint` — existing .takes/studio HTML/script diagnostics outside the edit boundary; expanded diagnostics show 135 errors and eight warnings.
- FAIL: final `npm run test` — 311 files passed, three failed, six skipped; 3,231 tests passed, eight failed, 12 skipped.

The eight full-suite failures are outside Studio:

- scripts/check-approved-dependencies.test.mjs: one failure, approval list omits parakeet-linux Cargo inputs.
- scripts/check-cargo-graphs.test.mjs: two failures, graph policy omits parakeet-linux/Cargo.lock.
- scripts/generate-release-inventory.test.mjs: five failures cascading from that stale dependency policy.

The earlier full run also caught native-select policy violations introduced here; those
were fixed with AppSelect, and its targeted gate and final full-suite test now pass.
No tests were weakened, deleted or newly skipped. The existing suite's skipped tests
were left unchanged. No build/native gates were run because this is a renderer-only
slice and Electron launch was explicitly excluded.

## Primary-source check

Checked React's effect cleanup contract and MDN's focusable separator contract before
implementation. Subscriptions clean up, and separators expose orientation, controlled
panes, bounds and updated values rather than acting as visual-only drag handles.

- https://react.dev/reference/react/useEffect
- https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/separator_role

## Handoff

This is a functional implementation, not a claim that all design acceptance conditions
are complete. Remaining visual/accessibility differences above require a follow-up;
repository-wide lint and supply-chain policy failures also block a green acceptance run.
