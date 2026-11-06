# Explicit recording lifecycles

## Renderer recorder

`src/hooks/recorderLifecycle.ts` owns recorder modes. `useScreenRecorder` subscribes to its immutable snapshot; native handle `paused` and `finalizing` properties are read-only projections. Media handles, elapsed clocks and clip payloads remain resources/data rather than additional mode flags.

| Event | Allowed transition |
| --- | --- |
| Record | idle → preparing → starting → recording |
| Cancel acquisition | starting → start-cancelling → idle, after acquisition cleanup |
| Pause | recording → pausing → paused |
| Continue | paused → configuring-resume → resuming → recording |
| Stop during dispatched Pause/Continue | pausing/resuming → stop-queued → stop-requested after acknowledgement → stopping → saving → idle |
| Stop during camera setup | configuring-resume → stop-requested; no Continue is dispatched |
| Restart | same finalization protocol with restart intent → restarting → starting |
| Source choice | idle/paused → selecting → previous phase; cancellation is named |
| Writer failure | owned take → failed → finalization; preserve completed originals |
| Browser window teardown | owned browser take → detached; suppress navigation from the torn-down window |

Save takes precedence over a queued discard/Restart before finalization dispatch. An explicit discard already sent to the main process remains irreversible, as before. Stop never rejects an outstanding capture acknowledgement: it waits and then finalizes. Harmless duplicate/stale transitions return false and log state/event. Startup cancellation retains exclusive ownership until the old operation settles, including immediate starts and Windows startup.

When Stop is already queued behind Continue, Linux does not acquire a new renderer camera writer after the native acknowledgement. The earlier committed camera sources remain attached. Opening and immediately closing that new writer produced an unreadable zero-sample camera file in the real-helper overlap test. Every source actually published by the flow is fully decoded.

### Verification contract

`scripts/recording-window-flow.mjs --fault=pause-stop`, `--fault=resume-stop`, and `--fault=resume-restart` use the real Linux helper on a private agent-lab desktop. The harness verifies the helper's parent PID/executable, suspends only that helper, observes command bytes queued in its stdin socket, invokes overlapping production controls, and resumes the exact PID in `finally`. The post-Stop receive queue must remain unchanged until the helper is resumed. Busy state, retained prefix source paths, pending Pause duration, full screen/camera/microphone decode and replay are checked. Restart invokes the production action directly to exercise an overlap the disabled button prevents through pointer use, then reopens Studio before saving the replacement take.

`KLIPPT_OVERLAP_BASELINE=1` records the same observations without asserting the new queue/busy behavior, so an installed pre-conversion executable can establish a baseline. It is a harness setting, not an application gate.

Hook regressions cover cancelled startup on Linux/macOS/Windows, a replacement start after cleanup, Windows Cancel→Restart, browser transport exceptions followed by Stop, and Stop queued behind native Pause. Machine tests cover illegal-transition logging, queued Save priority and finalization joining. Mac/Windows native runtime remains unproven on Linux.

The React external-store contract is https://react.dev/reference/react/useSyncExternalStore. Store subscriptions are stable; snapshots change only through the transition function. Native media and IPC behavior remains governed by the existing helper contracts and platform tests.
