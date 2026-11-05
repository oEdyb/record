# Studio Record drop investigation

Investigated source `6b09a4fb5`. No installed application was driven and no
application-support data was accessed or changed. The observed intermittent drop
was not reproduced. **The cause of those two drops remains unproven.** No behavior
fix or new behavior test is included: choosing one of these paths without runtime
evidence would ship a guess.

## Confirmed contract gap

`electron/agent/agentServer.ts` returns `{sent: command}` after a boolean callback.
`electron/main.ts` returns that boolean after parsing and calling
`StudioController.command`; it does not wait for receipt or writer start.
Consequently `{sent: "record"}` proves command acceptance only, even when a later
step returns without doing anything.

`StudioController.snapshot()` derives phase from the main-process take and stored
review. An idle phase does not establish that the renderer has cleared its
`starting`, `saving`, or internal pending-start flags.

## Ranked candidates

Ranking is by fit to the report and code reachability, not measured probability.

1. **Pill delivery during recreation or loading.**
   `StudioController.open()` calls `ensurePill()` when no pill exists; after Finish,
   `switchToHudWrapper()` creates a hidden pill and loads its renderer.
   `main.ts` implements `sendToPill` as
   `currentHudWindow()?.webContents.send(channel, payload)`. A missing pill drops
   the call, and there is no application acknowledgement or readiness queue.
   `preload.ts` registers an ordinary event listener only when LaunchWindow's
   effect subscribes. Record does not ensure the pill again. This fits a later
   request succeeding after the first was lost. Waiting 2–3 seconds reduces this
   likelihood but does not prove the renderer was subscribed. There is no evidence
   that recreation/loading actually overlapped either failed request.
2. **Renderer rejects Record while main reports idle.**
   `LaunchWindow.tsx`'s `onHudStartRecording` silently returns for
   `recording || starting || saving`; `handleRecordButtonClick` also returns for
   `saving`. Main's idle take is independent of those flags. In
   `useScreenRecorder.ts`, a pending start also returns for
   `pendingStartRunId`, `recording`, or `sourceSelectionInFlight`; `startRecording`
   returns for existing writer handles or another start. A pending state clearing
   between presses fits the four-second retry. No captured flag values establish
   which guard, if any, fired.
3. **Record is diverted into a hidden source panel or loses a selector failure.**
   When `hasSelectedSource` is false, Record opens the source selector instead.
   On Mac, granted access sets the inline source panel open. Studio normally hides
   the pill. Permissions explicitly call `studioPillNeedsUser`; source-panel
   opening has no equivalent reveal. A successful panel open therefore need not
   be visible from Studio. A rejected selector promise is swallowed; non-open
   results other than portal ownership clear the pending action without an error.
   This can leave idle indefinitely. There is no evidence the source was missing
   in either occurrence.
4. **Start await remains pending or an older run leaves a lock.**
   The start flow awaits source lookup, cursor access, helper availability and
   native start. After `startRecording` returns it also awaits an animation frame
   before clearing `countdownActive`, then countdown-overlay IPC before clearing
   `pendingStartRunId`. A normal stop clears native recording state separately.
   An unresolved await can leave idle with a renderer lock after a finished take
   or failed start. The Mac pill uses `backgroundThrottling: false`, so being
   hidden alone is not proof of a stalled animation frame. A pending native start
   also needs distinguishing from a request that never reached native capture.

The main-process `take.running` guard cannot explain a consistently idle take
without a state transition around the command. Linux source-selection cancellation
is not a leading explanation for this Mac report. Countdown cancellation can
consume a toggle, but the HUD start guard normally rejects a countdown first.

`runWithCapturePermissions` either invokes the action or opens a permission panel
with a retained action. `settlePermissions` deliberately waits until
`permissionStep` is ready; the panel explicitly reveals the pill. This is a
user-visible permission wait, not evidence of a silent drop. Reopening permissions
from the source picker does not retain Record as its pending action.

The export process skips the GUI single-instance lock and runs through `runCli`.
No direct call from that process to the GUI's Studio or pill state was found.
Shared storage/resource effects are not ruled out, but export is not a demonstrated
cause.

## Smallest useful diagnostic change

Carry a bounded numeric request token from Studio through `hud-start-recording`
into the start flow. Keep a bounded main-process ring readable from the existing
local agent socket; no new files or media/device names are needed.

- At dispatch: token, time, main phase, pill/window id or absence, loading and
  destroyed state. Record renderer navigation/exit against that window id.
- At receipt: token, `recording`, `starting`, `saving`, source-ready/selected
  booleans, and permission-step kind. Emit the actual guard or selected branch.
- At the hook: token and guard booleans, then existing start timing stage names;
  include selector result/rejection, permission wait, cancellation, and cleanup.
- At native first-frame confirmation or failure: token, recording id or bounded
  error. A token with dispatch but no receipt identifies delivery; receipt without
  hook entry identifies routing; hook entry without native start identifies the
  exact pending stage. A timeout should record the last stage, not retry Record.

After a failed attempt, read that ring before another press. Build the regression
test around the evidenced path. A later fix must expose failure to both Studio
and CLI and confirm success only from the actual writer; receipt alone is not
recording success. Do not automatically retry a toggle, which could cancel a start.

## Primary contract checked

[Electron webContents.send](https://www.electronjs.org/docs/latest/api/web-contents#contentssendchannel-args)
describes asynchronous main-to-renderer delivery, not recording completion. The
installed source pins Electron 44.9.1; the missing acknowledgement above is visible
in the application's own code and does not depend on assuming an Electron bug.

## Verification

- `npx vitest --run electron/studio/studioController.test.ts electron/agent/agentServer.test.ts src/components/launch/LaunchWindow.test.tsx src/hooks/useScreenRecorder.nativeStopFailure.test.tsx`:
  four files passed, 245 tests passed. These are existing mocked tests; they do
  not reproduce or explain the installed Mac drop. jsdom emitted unimplemented
  media-method notices; no actual playback or capture was started.
- `npx tsc --noEmit`: exit 0. This checks types, not IPC receipt or native capture.
- `node_modules/.bin/biome check electron/studio/studioController.ts electron/studio/studioController.test.ts electron/agent/agentServer.ts electron/main.ts src/components/launch/LaunchWindow.tsx src/hooks/useScreenRecorder.ts`:
  six files checked, no fixes, exit 0. These inspected sources are unchanged.
- Dependencies were initially absent; first `npx` attempts failed before running
  tests/typechecking. `npm ci --ignore-scripts --no-audit --no-fund` installed the
  lockfile dependencies locally; subsequent commands above passed. npm warned
  that the available Node 26.5.0/npm 12.0.1 differ from the repository's pinned
  Node 22.22.1/npm 10.9.4. No native build or application launch was performed.

Decision: preserve runtime behavior until a failed request is traced. Only this
investigation note changed; no new test claims to establish the unknown cause.

## November 5: diagnostic continuation

Fetched main `172acfab8aea07ffe95a42edce2928e57c5da0ff` into a separate worktree.
The sync branch tip `990d5543f` is not an ancestor, but its two affected Rust
files match main exactly. Main contains the implementation as `291af252c` and
the system-audio regression as `6b09a4fb5`; no duplicate merge is required.
Fresh standalone `rustc --test` on `audio_ring.rs`: 9 passed in 71.13 seconds,
including three simulated three-hour clock tests. This is simulation evidence,
not a fresh desktop recording. The prior Studio thread reports a 618-second
Mac take with raw drift −8 ms, exported drift +3 ms and no system-audio gaps
while its tone played; those measurements have not been independently rerun here.

Added a bounded 256-entry main-process trace available through
`studio.record-trace` on the existing private local agent socket. Numeric tokens
follow Studio dispatch, window/loading state, renderer receipt and guards,
source routing, recording hook entry/stages, native writer result and cleanup.
Window navigation/process exit/destruction are recorded. No new on-disk trace,
media, device names or raw error messages are collected. Diagnostic code only;
the original intermittent drop has not yet been reproduced or fixed.

Diagnostic checkpoint: 172 focused tests passed. Full suite: 3,396 passed,
6 failed, 5 skipped; all six failures are the existing invalid dependency
approval signature. The private Linux desktop suite did not run on this Mac.
No approval key was accessed and no gate was changed. ScreenCaptureKit,
compositor, Parakeet, Whisper and LGPL FFmpeg were freshly rebuilt. The unsigned
development app could not enumerate screen sources; it was quit and is not
counted as recording verification. The user's running installed app was left
running and its take was idle when inspected.

## Reproduced cause and fix

The signed diagnostic build reproduces two concrete drops on this Mac:

1. After a real Studio recording, Stop and Finish, the editor is visible and no
   pill exists. `studio.command record` returns `{"sent":"record"}`, but token 23
   records `pillPresent:false`, a null delivery window and no renderer receipt.
   Phase remains idle after two seconds.
2. `studio.open` followed immediately by a real Studio Record button click
   (`ui.click`, exact accessible label) also drops. Token 24 sees the same missing
   owner and no receipt; Studio remains visible and idle after 2.5 seconds.

`open()` asking for the pill does not establish that its asynchronous window
handoff has produced a loaded, subscribed renderer. `command("record")` neither
ensured that owner nor waited for it; optional `webContents.send` silently did
nothing. This demonstrates the missing-owner delivery failure class. It does not
prove that each of the two historical November 3 drops had exactly this cause.
Twenty slower New recording → Studio → Record cycles did not drop before the fix.

Record now creates the owner, waits for the renderer's explicit subscription,
and dispatches exactly once. Only the current owner's matching request token can
complete it. A helper process being alive or a Studio snapshot saying recording
is insufficient: success requires the native start API's confirmed writer result
and the matching main-process recording ID. Busy guards, selector/permission
handoffs, native failure, and a 30-second unconfirmed start return a real error to
Studio and the local CLI. The timeout records its last stage in memory, does not
retry a toggle, and does not claim that a still-pending native start was cancelled.
A source/permission handoff remains visible and may start after the user acts.

## Fixed signed-build evidence

The fixed signed test copy uses an isolated profile. The user's original
`/Applications/Klippt.app` process was never stopped or replaced. Direct launches
were attributed to the invoking host and denied screen access; LaunchServices
`open -n -a ... --env ...` returned granted screen, mic and camera permission.
No permission database was reset, no fuse changed and no approval key accessed.

- The missing-owner CLI reproduction now waits for delivery/receipt and returns
  `{"success":true,"recordingId":...}` at writer confirmation: 960 ms from request.
- Immediate Studio open + Record now confirms the writer in 631 ms, starting
  with no pill. No second press is needed.
- Twenty fixed New recording → Studio → Record → Stop → Finish cycles all make
  real screen clips. Main's process-state polling bounds are 234–305 ms versus
  234–321 ms before the fix; these are not writer-confirmation latencies.
- Duplicate Record returns `Recording is already running or starting` without
  stopping the current take.
- Selecting a disposable native window, closing only that window, then pressing
  Record produces a visible Studio failure toast. The matching native start
  fails after 229 ms; the real `scripts/klippt-agent.mjs studio-do record` command
  also exits 1 with an error. No recording is reported successful.
- A decode checkpoint read 41 complete test MP4 files (128.311669 seconds total)
  through the rebuilt bundled ffprobe and FFmpeg without errors. More test files
  were created after that checkpoint; it is not a claim that every later file
  has been checked.

Current verification: 277 focused tests pass across eight affected suites;
full suite 3,402 passed, 6 failed (the same invalid approval signature), 5 skipped.
Both typechecks, lint (one existing oversized-file warning), i18n and docs pass.
Standalone Rust clock tests pass 9/9. No new 10-minute Mac comparison was needed
because the requested sync implementation and regression already match main.
Native capture success tests to this point used screen only; physical mic/camera
sync and a new long hardware take remain unproven. Source-loss tests exercise
actual writer failure and both Studio and CLI reporting, not only mocked guards.

Local evidence: `artifacts/mac-record-sync-20261105/` (ignored private media and
JSON traces). All diagnostic and fixed app bundles passed the repository's
Developer ID app/helper identity guard. No release was published.

Additional physical-source check on the fixed signed copy: screen, camera,
microphone and system audio enabled together; Record, Pause, Continue, Pause
immediately followed by Stop, and review playback all ran through Studio controls.
Two clips committed at 505 ms and 1,092 ms. All eight separate originals fully
decode: screen H.264 3420×2214; camera H.264 1920×1080; mic/system AAC 48 kHz.
Source durations for the short clip are screen 0.519730 s, camera 0.420000 s,
mic 0.352000 s and system 0.439979 s, with original offsets retained. This proves
short-clip capture/recovery and playback, not measured spoken mic/camera sync.
