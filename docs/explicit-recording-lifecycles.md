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

## Main native recording service

`electron/recording/nativeRecordingLifecycle.ts` owns acquisition, helper ownership, prepared/live/paused/configuring/resuming/failed phases, source-selection reservation, metadata admission, shared Stop and the one-time quit result. Old mode fields in `NativeMacRecordingService` are derived getters. Source/session identifiers, cursor clocks, committed clips and generation identities remain payload data. Promise chains serialize durable work; their presence does not define the current capture phase.

Stop reservation wraps the current take. A late Pause/Continue/fatal event updates the wrapped writer phase without clearing that reservation. Reset drops helper ownership but retains the shared Stop promise until that exact operation settles. Source-picker cancellation remains outside the queue. A quit result is collected once; an invalid source request cannot erase it. A failed helper lookup releases startup ownership so Record can retry.

The existing `NativeMacHelperClient` command/acknowledgement implementation and service durability tests are the contract reference for ordering. The conversion retains first-frame checks, initial recovery-before-helper creation, original metadata admission through helper finalization, live helper checks, persistence before published clips, renderer handoff and generation filtering. Regression tests reject/log a new start while Stop is reserved and cover late acknowledgements, fatal/reset during Stop, lookup retry and invalid selection after quit.

## Linux clip writer

`electron/native/pipewire-capture/src/clip_lifecycle.rs` owns the capture writer in its enum. Waiting carries the first-frame deadline; staged owns an unacknowledged writer; writing owns an acknowledged writer; paused carries startup history and a compatibility writer when retained; draining transfers the writer once to finalization; between/stopped own none. A failure wraps the prior phase and retains its writer for Stop. Initial Continue before the first acknowledgement is distinct from Continue after an acknowledged clip.

The transition function rejects/logs illegal Continue without releasing the writer. Stop always extracts/drains an owned writer before its terminal transition. Existing screen/source readiness checks, frozen pause boundary, original-source notifications, canonical clip commits, compatibility pause/resume and failed-tail recovery remain in their original order. The first-frame timeout belongs only to waiting, so a static acknowledged source cannot inherit it.

The native regression deliberately issues illegal Continue on a real software writer, then Stops and fully decodes its retained screen file. Existing clip tests also cover source PCM readiness, paused audio exclusion, short clips, static Continue, source replacement, late originals and failed clip retention. Capped private tmpfs tests explicitly exercise ENOSPC during capture and at Stop; neither test writes to a real recordings volume.
