# Studio UI build contract (2026-10-30)

Build the approved Studio design in React, replacing today's reduced Studio
(`src/components/studio/StudioWindow.tsx`). The design is approved; port it, do not redesign it.

## Design source of truth

- Mockup: `.takes/studio/F-combined/mockup.html` (open it, click every state) and its
  `DESIGN.md` (layout per state, keyboard map, "Build requirements" section — those rules are
  binding). `FIX-RESULTS.md` lists review fixes already folded into the mockup.
- Later change, binding: the bottom bar uses the **pill's own controls** (same components,
  glyphs, order, tooltips): `HudCompactRecordButton`, `HudCompactPauseButton`,
  `HudCompactTimer`, `HudStopButton`, `HudRemovePreviousClipButton` from
  `src/components/launch/HudControls.tsx`. No Studio-only recording actions (no "Redo &
  resume"). Backspace = remove previous clip (paused / review only) with the pill's
  "Removed · Undo" feedback, driven by `snapshot.pill.undoClipIndex`.
- Not in v1: "Record more" after Stop. After Stop the Studio is the read-back; **Finish** sends
  `"finish"`, which hands the take to the existing review window (save/export, Add clip).

## Data and commands (already implemented — use, don't change)

- Snapshot: `electron/studio/types.ts` `StudioSnapshot` via `window.electronAPI.getStudioSnapshot()`
  and `onStudioUpdated()`. Phases: `idle | recording | paused | review`. `setup` = mic/camera/
  system audio/cursor/quality/source as main stores them. `pill` = the pill's locks, Remove
  predicate, Undo clip index, countdown, saving.
- Commands: `window.electronAPI.studioCommand(cmd)` with `StudioCommand` from the same file.
  Recording: record/pause/resume/stop/remove-last/undo-remove/pill/finish. Setup:
  toggle-mic/toggle-camera/toggle-system-audio/open-notes/choose-source and
  `{kind:"select-mic"|"select-camera", deviceId, name}`, `{kind:"set-quality"}`,
  `{kind:"set-cursor"}`. The pill applies them with its own checks; the result comes back in
  the next snapshot. Disable setup controls when `pill.controlsLocked` or phase is `recording`.
- Live camera: `src/components/studio/useStudioLiveCamera.ts` (canvas ref + `active`). Pass
  `active=false` when the camera pane is hidden or the window is hidden (`snapshot.shown`).
  Never call `getUserMedia` for the camera.
- Mic level: `useAudioLevelMeter` (`src/hooks/useAudioLevelMeter.ts`) for the selected mic
  while mic is on.
- Devices: `useMicrophoneDevices`, `useCameraDevices` (`src/hooks/`).
- Source: in `idle`, show a picker in the Studio using `SourcePicker`
  (`src/components/launch/SourceSelector.tsx`) or `electronAPI.getSources` +
  `electronAPI.selectSource` (main broadcasts the change; the pill follows it). While paused,
  send `"choose-source"` (the pill switches source mid-take). Locked while recording.
- Notes: text lives in `localStorage["notes"]` (shared with the Notes window; read with
  `loadInitialNotesContent`, follow `storage` events). "Open notes" sends `"open-notes"`.
- Transcript: `snapshot.transcript` (per-clip text and `words` with clip-relative times);
  sentence building in `src/components/studio/studioTranscriptModel.ts`.
- Replay: `StudioReplay.tsx` (camera sync already fixed via `src/lib/followCamera.ts`).
  Keep its `hold` rule: replay never plays while capture runs or resume is pending.
- Layout persistence: add a `studioLayout` field to `src/lib/userPreferences.ts`
  (view, split, order, dock side, dock width fraction, live mode, guides) with normalization
  and tests, instead of a raw localStorage key.
- Mac window: native traffic lights at (14, 13) over the title strip
  (`titleBarStyle: "hiddenInset"`). Leave ~80 px clear at the top-left on macOS
  (`electronAPI.getPlatform() === "darwin"`); the strip is a drag region, controls are not.

## Boundaries

Edit only `src/components/studio/**`, `src/lib/userPreferences.ts` (+ its test),
`src/i18n/locales/*/launch.json`, and `src/App.tsx` routing if needed. Do not touch
`electron/**`, `LaunchWindow.tsx`, `useScreenRecorder.ts`, or the hooks above. If an API is
missing, stop and report it instead of adding one. Keep new files under ~300 lines; split
components (shell, setup bar, document, dock, panes, transport bar, keyboard).

## Rules

- "Every screen speaks once": no taglines or helper text. Keep labels, errors, aria-labels.
- TypeScript strict, no `any`, functional components, top-level hooks, match surrounding style.
- All new strings in all 13 locales (`npm run i18n:check` passes; translate, don't copy English).
- Accessibility rules from the mockup's DESIGN.md "Build requirements" are part of done.

## Done when

1. `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run lint`,
   `npm run i18n:check` pass; `npm run test` passes with no skipped or weakened tests.
2. New pure logic (layout prefs, keyboard routing/guards, view/split rules, transcript
   sentence seek) has unit tests in `src/components/studio/`.
3. Component tests render each phase from a fake snapshot and assert the right controls,
   commands sent, and disabled states (pattern: `src/components/launch/LaunchWindow.test.tsx`).
4. A short note at the top of `StudioWindow.tsx` is not needed; instead list what was built and
   anything not matched to the mockup in your final report.
