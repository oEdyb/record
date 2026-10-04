# Creator recording loop — October 4, 2026

Status: UI implementation and checks passed on `codex/creator-recording-loop-2026-10-04`;
local main integration includes the prior 50 commits. Four-source capture acceptance remains open.
Baseline: `08c40316`. Every local branch and fetched private origin branch is already
an ancestor of baseline. No outstanding private branch needs conflict resolution.
The historical upstream branches are reference code, not product work to merge wholesale.
Existing untracked local-install artifacts and receipt are preserved.

## Acceptance

1. Record from review reacts immediately and admits only one pending navigation.
2. Save/library/record actions cannot race the recording workspace switch; errors unlock it.
3. Review shortcuts use the platform modifier exactly, respect focused controls and dialogs,
   ignore held action keys and preserve held frame stepping.
4. Expanded HUD controls have no artificial wait and reduced motion stays respected.
5. Real Mac recording, Pause/Continue, Stop, review, new recording and untouched source
   handoff pass using task-owned recordings. Record actual transition measurements.
6. Type checks, lint, i18n and full tests pass; inspect real app screenshots.

## UI constraints

Retain Klippt's existing dark surfaces, typography, spacing and accent tokens.
Use the current compact recording pill as the recognizable control. Show shortcuts
beside the existing actions; do not add another navigation system or editing tools.
Transitions never delay access to controls. Keep original sources and legacy projects.

Initial scope: review toolbar/shortcuts/navigation in NewEditorShell, HUD motion,
focused tests and runtime measurement harness. Window lifecycle changes require evidence
from the baseline before implementation.

## Research and decisions

- [Screen Studio shortcuts](https://screen.studio/guide/screen-studio-shortcuts) and
  [recording controls](https://screen.studio/guide/managing-recording-in-progress): keyboard
  access and a small persistent control are established recording patterns. Klippt already
  has these; improve discoverability and responsiveness rather than add an editor palette.
- [Ecamm isolated sources](https://support.ecamm.com/en/articles/6925577-recording-isolated-audio-and-video)
  and [OBS multitrack guide](https://obsproject.com/kb/multiple-audio-track-recording-guide):
  separate media supports outside editing. Preserve Klippt's existing original-source/OTIO handoff.
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window):
  ready-to-show describes renderer paint, not readiness of a lazy React control. Measure
  visible control readiness before choosing a window-lifecycle optimization.
- [React refs](https://react.dev/reference/react/useRef): synchronous event-handler guards
  complement visible pending state. Installed React 18.3.1 already uses this pattern for export.
- [Keyboard repeat](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/repeat):
  held keys repeat; navigation should run once while frame stepping can repeat.
- [CSS delay](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/transition-delay):
  the existing 280 ms entrance delay with hidden controls adds waiting unrelated to recording.

Expanded verified scope: the recordings browser now implements its advertised arrow/Enter
navigation, shows loading/errors, clears stale search on reopen and replaces internal IDs
with local times. Native menu actions obey the same dialog/focus boundaries as DOM shortcuts.
Record opens the compact pill through an explicit window entry hint; this carries no project
insertion context and Escape returns to review. Main/window routing and matching HUD tests
are included. New recorder copy follows the existing English recorder strings in all locales.

[Loom's pause/restart shortcuts](https://support.atlassian.com/loom/docs/use-looms-keyboard-shortcuts)
and [CleanShot's quick overlay/history](https://cleanshot.com/features) reinforce immediate
control and retrieval as useful patterns. Klippt already has pause/continue and retained sources.
This slice prioritizes making those controls reachable and predictable; it does not add cloud
sharing, AI editing, annotations, or automatic destructive restart.

## Verification evidence

Evidence root: `artifacts/creator-loop-2026-10-04/`. All desktop runs use task-owned development
profiles and recordings; `/Applications/Klippt.app` and existing Resolve projects are untouched.

The UI smoke exercises the real Electron application at 1200 and 400 CSS pixels, library
keyboard opening, native-menu dialog guards, loading/error states, repeated pending navigation,
failure recovery, three compact-recorder round trips and Escape return. Failure-state injection
replaces only the specific IPC replies, restoring the original handlers before real navigation.
The final smoke asserts no renderer page errors. Screenshots are inspected, not merely saved.
Independent review found the native-menu focus bypass and a startup Escape race; both are fixed.
The fresh follow-up reports zero remaining findings and 87 focused tests passing.

Desktop timings include automation and variable host load; they are not a controlled speed
comparison. The final rebuilt smoke (`ui-final/report.json`) measured 810–946 ms to a ready compact
recorder and 122–215 ms back to review. The intentional 280 ms control entrance delay is removed
in code. The final narrow footer wraps as two intact rows; empty/loading/error states and the
expanded HUD with reduced motion were inspected.

All eight checks in `final-checks/summary.json` passed: full suite (377 files, 4,108 tests,
one existing skip), app/test/workbench TypeScript, lint, i18n, docs and design checks. Lint retains
two existing warnings: the CLI flush test's empty callback and the oversized Cargo evidence file.

### Failed capture evidence retained

- `capture/report.json` and `capture-final/report.json`: High four-source recording failed
  after truthful Start when the existing eight-frame / 133 ms backlog limit was exceeded.
  The host load averages were 17.5 and 29.0. Load is a hypothesis, not a proven root cause.
  No native media code was changed in this UI pass, and the cadence contract was not relaxed.
- `capture-standard/report.json`: two Standard recordings, repeated Pause/Continue and
  immediate paused Stop completed; source files matched the originals. The run is **failed**
  because the chosen fixture was silent and cannot establish the required system-audio signal.
- `capture-standard-verified/report.json`: the audible rerun failed startup because the camera
  delivered 1280×720 after a 1920×1080 configuration. It is not counted as accepted capture proof.
- `capture-diagnostic/report.json`: instrumented High startup timed out waiting for the standalone
  microphone original. No recording acknowledgment or cadence failure occurred. The requested
  microphone was the default device with no resolved identity in the diagnostic. Stage timings do
  not prove whether input failed to arrive or an append stalled; no speculative native fix is made.
- `capture-screen/report.json`: **passed** two real recordings, repeated Pause/Continue, immediate
  paused Stop, playback, finished-video export and review/navigation smoke. This is screen-only
  evidence and must not be presented as an accepted four-source run.

These failures must remain visible beside successful UI checks; a green UI smoke does not prove
High four-source capture reliability. Long recordings and new Resolve import/playback are not
rerun by this UI slice; October 3 evidence remains historical evidence, not fresh verification.

Next capture investigation: record the resolved microphone identity and input arrival versus
append completion before changing capture behavior. The current evidence does not prove a native
regression or an intrinsic machine limit. Keep this follow-up separate from the UI merge.

### Build boundary

The full platform-native directory rebuilt successfully. Production TypeScript and Vite renderer,
main and preload builds pass. `npm run build -- --publish never` was attempted with an isolated
output directory; packaging correctly stopped at the existing helper-provenance guard because the
rebuilt cursor helper's hash differs from the staged manifest. No guard was bypassed, manifest
rewritten, application installed, release published or remote branch pushed. A new install needs
fresh staged helper provenance and the existing Developer ID identity check.
