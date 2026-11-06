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

## Renderer camera handoff

`RendererRecordingStop` owns one unbound/bound/waiting/acknowledged/failed state. Matching renderer, take ID and token are required for completion. Stale acknowledgement rejects/logs without replacing the current owner. Rebinding fails the old waiter and removes its listeners before the next handoff proceeds. Crash, close, send failure and the shared quit deadline settle the current operation once.

Repeated `wait` calls join the same promise and first deadline, including a duplicate caller whose own signal is already aborted. They cannot overwrite the camera save waiter. Regression tests cover that join and a superseded owner's stale acknowledgement/abort while the next handoff remains live. Existing quit, renderer-crash, source attachment and recorder tests retain the durable handoff behavior.

## Windows Stop client

The main-process Windows Stop client uses `CaptureStopLifecycle`: waiting → terminating → settled, or waiting → settled on a close/error. Grace-period exit waits use the same one-shot state authority. Stale close/error/deadline completions reject/log; the retained original result cannot change. The timeout still allows the helper's own shutdown budget, escalates by exact PID, and re-reads finalized output after termination so a playable file wins over a timeout diagnosis.

Unit regressions cover stale callbacks after settlement and a finalized path reported during forced termination, including listener/timer cleanup. This proves the TypeScript client on Linux. The C++ WGC/D3D/Media Foundation lifecycle is unchanged: this PC's actual `c++ -std=c++20 -fsyntax-only electron/native/wgc-capture/src/main.cpp` check fails on missing `Windows.h`. Native conversion/runtime proof requires a Windows worker.

## Export publication and cancellation

`PublicationLifecycle` owns preflight → rendering → final capacity drain → verification → syncing → publishing → committed → done. Rendering owns the capacity timer and one idle/checking/failed capacity substate. Failure enters cleanup and then failed or cleanup-blocked. No cleanup transition is legal after the final rename has committed: a throwing notification cannot turn a saved file into a failed export or remove it. Initialization recovery has a separate uninitialized/recovering/ready/failed owner and preserves the shared promise and existing no-retry semantics.

`ExportCancellationRegistry` replaces separate active and pending-cancel maps with one per-ID state: unregistered, pending cancellation, active or cancelled. Registration consumes an early cancellation. A duplicate ID cannot replace a live controller, and cleanup must present the same controller. The existing 60-second tombstone policy, insertion-order eviction and 256-entry pending bound remain unchanged.

The export UI retains its single phase, now as a discriminated state with one transition function. Begin rejects overlapping jobs; the dialog honors rejection. Backward phase messages reject/log, and active resets cannot erase the cancel owner. Completed/error payloads are coherent with their phase. The test fixture now resets through the public abandon action instead of writing mode fields directly.

The Rust cancellation AtomicBool is one independent request bit and its immutable registration token has RAII cleanup; those stay unchanged. Source-copy busy is one independent on/off value for a separate operation. Neither needs an additional parallel mode value.

Tests reject early publication, post-commit cleanup, duplicate IDs, wrong-controller finish and overlapping UI runs. An observer-failure filesystem regression retains the committed bytes without calling staging cleanup. Private flows exercise real native cancellation after frame progress and a read-only destination followed by permission restoration and fresh-process journal recovery. These do not establish Mac/Windows encoder runtime behavior.

## Project editing, persistence and reconciliation

`projectLifecycle.ts` owns the view, draft and transaction as parallel regions in one immutable value. Loading retains the previous settled view and an opening epoch. Editing is editable, externally owned, blocked with an exact recovery reason, or recovering with a matching owner and reusable copy. Dirty/clean, status, error, busy and sync-pending are derived snapshot getters; the pending request, draft checkpoint and recovery copy no longer live in module globals. Draft data and its checkpoint publish in one store notification. Test-only seed helpers construct a lifecycle; production does not translate writes to the removed flags.

`transitionProject` rejects and logs illegal moves by throwing before publication or persistence. A queued write cannot dispatch after its local-request admission rejects. Uncertain commits retain their exact request, rebased candidate and base through failed receipt lookup, failed copy loading and retry. A rejected write that was never dispatched creates no uncertain receipt to query. External commits pass a private owner directly to the shared edit operation; the public edit method cannot accept a reusable guard as ownership. There is no temporary global guard handoff.

Opening epochs also guard create defaults before persistence, ordinary load/create/save/asset publication and transaction activation. Navigation/Clear cannot abandon a queued guarded receipt. A completed refresh releases its own loading view even if a newer gesture changed the document, without restoring the old document, revision, draft or warning. A different opening keeps its own view. Existing serial queues, CAS validation, bounded lineage/rebase algorithm, durable receipts, Undo and explicit recovery choices remain intact.

`ProjectActivity` replaces independent active counts, waiters and finished flags with explicit idle/active per-project ownership. Mutations and queued saves carry distinct operation tokens; duplicate completion rejects/logs without releasing another mutation or idle waiter. Migration owns one unstarted/running/complete/failed promise; transaction publication has staging/renamed/synced phases, preserving uncertain-commit recovery after rename.

Pstack interrogation used two configured Codex reviewers and real filesystem receipt probes. The parent reproduced the failures before fixing write admission, stale create/asset paths, external ownership and refresh completion; activation received the same opening check. Regression tests preserve uncertain candidates and recovery copies and prove duplicate/stale rejection. Three stale-load fixture assertions now require a settled view and unchanged project data instead of demanding object identity with a completed loading state. One adversarial oracle was corrected: once the third write is prevented, it must have no receipt lookup; the original probe and red output remain in external evidence. Installed-copy acceptance remains part of the final application sweep.

## Linux HUD privacy and recovery

`LinuxHudLifecycle` owns visible, concealed, recovery, preparation and cancelled-preparation phases. Preparation owns its unique token, pending versus explicit concealment and any new recovery request; recovery owns its Pause dispatch state and retry timer. The former transitioning/concealed/pause/recovery flags, independent generation/operation counters and nullable timer authority are removed.

Only the transition function changes this value. A stale proof, completion or timer rejects/logs without changing the replacement. Showing controls while the authoritative capture service is active rejects/logs. A late retained-placement result cannot erase an explicit concealment, Hide or revocation. Cancellation retires the earlier preparation but retains a fresh recovery request until that admitted operation settles; it then sends Pause and retries after 500ms. A deliberate unmap still dismisses instead of pausing. Non-Linux behavior and unmap-before-capture ordering remain unchanged.

Two pstack Codex interrogations reproduced the cancelled-operation recovery regression on the conversion and confirmed the same probes passed on baseline. Parent reproduced it red and fixed it. Their late-proof probes also exposed existing proof-overwrites-concealment paths; these now retain the explicit concealment. Other exploratory expectations that also failed on baseline were excluded as regressions. Tests retain legal stopped-writer acknowledgement behavior; no new acknowledgement nonce or UI policy was introduced. Runtime Niri capture, physical output changes and devices remain unproven; final private installed acceptance is separate.

## Recovery journal, clip edits and camera ownership

`RecoveryJournalLifecycle` admits and serializes take-owned snapshots, Remove/Undo, publication and discard. It rejects stale generations and writes after terminal publication. `JournalFileLifecycle` separately owns the actual per-path write queue, including post-Stop camera attachment and journal consumption, so an update cannot resurrect a cleared journal. Snapshots passed to that filesystem boundary are copied at admission.

`ClipJournalLifecycle` owns the acknowledged clip list and `ready → changing → ready` edit protocol. A failed durable write enters `needs-recovery → reconciling`, with an owned retry deadline. The candidate is never the visible clip list before durable acknowledgement. An ambiguous rename/directory-sync failure therefore pauses clip edits while recording, Continue, Stop and Save remain available. Automatic reconciliation reads the existing journal, checks the changed clip's recording/path identity, then restores the acknowledged membership in journal metadata with current captured originals. It never deletes, rewrites or remuxes media. New clips recorded during recovery remain admissible. A failed helper Stop overlays acknowledged membership onto disk recovery rather than applying an uncertain rejected removal. Studio derives its plain “Clip edits are paused.” message and Remove/Undo availability from this main-process state.

The camera ledger holds per-recorder finalization and file ownership in one transition-controlled entry. A preserving release may still receive a saved acknowledgement; `releasing-attached` and `attached-unclosed` protect the original while its descriptor is closing or needs retry. Repeated acknowledgements cannot discharge a failed close. A new take has a separate identity; retained older cameras are only released, even when the newer take is discarded. Cleanup attempts every owned recorder and reports failures without forgetting the failed owners. Conflicting discard/release moves reject and log; equivalent requests join.

Regression coverage includes real filesystem rename/sync faults, concurrent metadata, automatic reconciliation, failed helper Stop, stale owners, continued capture and Save during a persistent journal fault, camera descriptors surviving failed close, repeated acknowledgements, and later-take cleanup isolation. Pstack findings were reproduced before fixing their integration paths. The private `--fault=clip-recovery` flow uses the real Linux helper and an obstructed private journal path: capture keeps growing, Stop saves every track, full decoding passes and finalized original hashes remain unchanged. Installed-copy acceptance is part of the final sweep. No physical-device, macOS or Windows runtime claim follows from these checks.

## Linux encoder drain and MP4 closure

`encoder_lifecycle.rs` owns video-empty/video-staged, audio-open, draining, interrupted-drain and finished encoder readiness, and allocated/configured/writing/finalizing/closed mux phases. Failed mux health is carried inside those phases until repair; the former staged/header-written/write-failed fields are removed. Repeated completed drains are idempotent. Input after drain, packets before the header, duplicate headers and streams added after writing are rejected and logged. A previous write error never prevents remaining drain packets, trailer/close or damaged-tail repair. An interrupted drain can be retried. FFmpeg send/receive and flush bodies retain their existing call order; native pointers remain RAII resources.

Native tests exercise actual software video/AAC encoding, exact frame counts and full all-track decoding, repeated AAC drain interruptions, a real FFmpeg mux rejection followed by successful draining, and explicit finish versus Drop. The two isolated ENOSPC tests retain readable fragments. Independent pstack probes compare decoded current/baseline audio and verify the unchanged FFmpeg flush bodies. These checks do not prove permanent storage failure, sudden power loss or every hardware encoder. A real Linux-helper Continue/Stop overlap and the final installed-copy flow supply the capture integration checks.

## Workspace windows, review handoff and quit

`WorkspaceLifecycle` owns current/editor resources, editor readiness, warm workspace transitions, compact/Studio-frame layout modes and the prewarm deadline. Window cleanup is registered once per resource; a stale ready/closed/deadline callback cannot replace the newer editor or complete its transition. Layout ownership replaces the old overlapping WeakSets. Source/device/notes window references remain independent resources outside this high-risk family.

`ReviewHandoffLifecycle` owns awaiting-window, awaiting-renderer and idle phases, the monotonic handoff identity and its deadline. Only the current renderer/token can reveal the review; cancellation retires the deadline. `EditorCloseLifecycle` owns clean, dirty, confirming, saving and temporarily-forced closure per window. Permanent, sender-bound IPC handlers preserve the valid pending reply when another window sends a response. Close attempts while confirmation or save is pending stay blocked. Dirty notifications are accepted only from an owned editor; an unrelated HUD cannot clear its unsaved work. `RendererRecoveryLifecycle` coalesces crashes per exact renderer while admitting a different renderer's recovery; it retains the save job and its outcome.

`QuitCaptureLifecycle` replaces the Stop/completing/system-shutdown flags. A running capture finishes before ordinary quit; repeated requests join that Stop. A vetoed or thrown quit returns to the open phase so another take is protected. System shutdown bypasses the wait and retains the existing recovery-journal policy. These transitions do not claim sudden-power-loss durability.

Regression tests execute the production main-process functions/IPC handlers with controlled Electron effects and verify wrong-window replies, pending close/save, stale handoff/ready/deadline, warm reuse, renderer overlap, shutdown and failed Stop/quit. Pstack's two demonstrated conversion regressions and the inherited dirty-sender gap were reproduced and fixed. Final installed-copy control, Stop/review and crash/relaunch flows provide the runtime acceptance; physical devices and macOS/Windows runtime remain separate proof.
