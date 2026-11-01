# Studio architecture research

Research only, 2026-10-29. No app, build, input, clipboard or audio interaction. Paths and lines refer to the inspected working tree; concurrent edits may shift them. Recommendations below are proposed behavior, not implemented guarantees.

## Decision

Keep capture and the existing HUD renderer alive. Add a separate Studio renderer backed by main-process take snapshots. Reuse the camera bitmap relay and finished-clip replay. Do not promise live screen preview until the native capture helper exports frames. On KDE, an always-available full-size Studio on the captured monitor conflicts with keeping recorder UI out of the recording: Electron does not provide Linux capture exclusion. This is a product constraint, not a layout problem.

## 1. Capture exclusion and source selection

`electron/windows.ts:107` calls `setContentProtection(true)` unless disabled by environment/macOS compatibility flags. It contains no Linux compositor exclusion implementation. Electron documents that API for macOS and Windows, not Linux: https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable . Treat it as no privacy guarantee on Linux.

`electron/windows.ts:181` only tests whether a point intersects visible private UI rectangles (painted HUD rectangles, camera bounds, additional windows). It does not change PipeWire pixels or exclude a window. Add Studio to these rectangles for telemetry privacy, but do not confuse that with capture exclusion.

`electron/native/pipewire-capture/src/portal.rs:353` requests Monitor | Window; `:388` opens the portal PipeWire remote; `:399` obtains the selected stream node. The user/compositor picker chooses the actual source. Electron displayId alone does not establish which display the portal selected. Source readiness distinguishes window crops in `source_selection.rs:32`.

Existing second-display work is Niri-specific: `electron/niriCaptureWindowGuard.ts:110` rejects without NIRI_SOCKET and a node id. It observes compositor state and output metadata (`:159`), rather than excluding pixels. `electron/windows.ts:276` uses this admission to leave a camera window visible only when outside capture, otherwise hides it. `docs/linux-port-2026-10-26.md:1290` describes the shared per-window policy and explicitly disclaims atomic exclusion and physical two-monitor validation. This does not establish KDE support.

Recommendation: paused Studio can open anywhere. During monitor recording, allow it only with positively established safe output placement, otherwise return a structured unavailable reason and retain the existing capture-safe controls. For KDE, implement and verify compositor-specific source/output mapping before claiming second-display safety; Wayland global window coordinates and programmatic placement are restricted. Merely having two displays is insufficient. For selected-window capture, permit Studio only when the source is positively identified as a different window and backend behavior is verified. Recheck on resume, source replacement, output removal and window movement. Hide/revoke on unknown state. Never silently pause or change the source just to open Studio. If unconditional same-monitor Studio is required, accept visible UI in footage explicitly or fund a compositor-specific solution; the current stack cannot guarantee both.

Portal contract: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html . Stream source metadata is optional and the remote FD grants access; a node id alone is not access authority. Prefer stable PipeWire serial when supported by the installed portal version.

## 2. Camera ownership

`src/hooks/useCameraPreviewStream.ts:117` opens getUserMedia. `LaunchWindow.tsx:199` passes its existing webcamPreviewStream to useCameraPreviewFrameBridge. `electron/ipc/handlers.ts:3580` explicitly describes Linux/macOS webcam recording as browser-owned, unlike Windows native DirectShow.

CameraPreviewWindow does not open a camera: `src/components/launch/CameraPreviewWindow.tsx:175` onward receives transferred ImageBitmaps, paints a canvas and acknowledges consumption. `electron/windows.ts:229` creates a MessageChannelMain between HUD producer and camera consumer. `src/hooks/useCameraPreviewFrameBridge.ts:99,195` supplies backpressure and transferable frames.

Extend this relay to a Studio consumer with its own port and one-frame-in-flight budget. A transferred bitmap cannot be transferred twice; produce separate bitmap instances or activate only the visible consumer. Never open a second getUserMedia camera as the architecture: V4L2/driver sharing is device dependent and unnecessary. Hidden HUD must remain mounted and retain stream/MediaRecorder ownership. Verify Chromium background throttling does not starve its frame production. Stop relay delivery when Studio hides; camera recording continues independently.

## 3. Screen preview

The inspected native capture/events/main modules expose no renderer screen-preview frame channel. pipeWireNodeId passed to setCameraPreviewCaptureHidden is a compositor admission identifier, not screen pixels. Camera relay frames contain camera imagery only. No verified renderer stream can be reused as a live screen monitor.

Cheapest honest first release: show selected-source identity while live, and the latest committed clip when paused. Label replay as replay; do not represent a desktop thumbnail as the captured stream. This is a scoped partial delivery of the goal.

Full delivery: add a bounded low-rate preview tap inside the existing helper's authorized capture pipeline, downscale before transport, discard when hidden or backpressured, and keep it entirely off the encoder critical path. Transfer via a dedicated binary transport, not base64 JSON stdout. Reuse the existing portal session/FD; no second picker. Prototype and measure copy/DMABUF costs before choosing format. Do not open Chromium getDisplayMedia as an assumed prompt-free shortcut. Paused helper preview continuity is a separate capability to verify; fall back to the committed frame when no fresh buffers arrive.

## 4. State and commands

Main owns durable truth: take id, monotonically increasing revision, phase (preparing/recording/pausing/paused/resuming/stopping/stopped/failed), committed clips, source safety, active clip identity, committed duration and active monotonic start time. Include screen/webcam paths, webcam offsets and removed status. Derive elapsed from committed duration plus active interval; renderer timers only animate it. Replay playhead and sidebar selection remain local Studio state.

NativeMacRecordingService is the capture authority (`electron/recording/nativeMacRecordingService.ts:200` exposes microphone-only transcript listings, so add a separate full take snapshot). Renderer webcam attachment completion must update clip readiness; native pause success does not prove the webcam file is finalized. Studio replay only accepts committed, readable assets.

Do not make presentation.recordedClips in useRecordingHudPresentation the permanent cross-window authority. Initially main may merge validated renderer camera-finalization notifications, but never mirror arbitrary renderer state. Studio must recover via getSnapshot after reload, then subscribe by revision.

Commands: Studio -> typed preload -> sender-validated main command router -> existing HUD controller for renderer-owned camera orchestration -> native service IPC -> committed snapshot. Existing `electron/main.ts:241,481` HUD pause/stop commands are the migration seam. Do not directly invoke native pause/stop from Studio and bypass webcam finalization. Serialize commands, reject stale take ids and duplicate operation ids, and return acknowledged results. Extract a shared command controller rather than duplicating LaunchWindow logic.

## 5. Automatic transcription

`electron/ipc/handlers.ts:2586` awaits service.pause(); schedule transcription only on success and after committed clip metadata is available. `nativeMacRecordingService.ts:437-459` finalizes pause and exposes its clip. Queue a refresh independently of whether Transcript or Studio is open.

Stop: `nativeMacRecordingService.ts:883` calls onSessionStored(session), then `:934` resets; `handlers.ts:3070` currently stores the session only. Capture an immutable transcript listing from finalized session clips there, including final microphone paths and durations. Do not defer reading the service until after reset. `handlers.ts:229` currently reads only service listings. `liveTranscript.ts:131` retains the last observed nonempty listing; it cannot preserve a final clip it never observed. Maintain active and last-finalized take listings in a small main repository.

`electron/main.ts:1235-1254` wires ensureModels and broadcasts only to transcriptWindow. Broadcast to both subscribed windows. Add a non-downloading model-presence check: automatic jobs run only when model files/helper are ready. Missing model becomes needs-model, with an explicit download action outside capture. No surprise 650 MB download. CPU budget must be explicit; one worker/job, bounded helper thread count, no auto work during active capture.

`liveTranscript.ts:117` coalesces refreshes to the in-flight pass: add a dirty/rerun flag so a second pause/Stop cannot lose newly finished clips. `:165` blocks initial live jobs; `:213` checks live only between clips. Resume during extraction/transcription can therefore leave that entire operation competing with capture. It should not corrupt a finalized input, but can cause capture pressure. Cancel extraction and helper work before acknowledging resume, using generation checks to discard late results; requeue interrupted clips at next pause. stop() at :125 only stops the helper, so extraction also needs cancellation. Guard against prior-take results contaminating a new take, removal during a job, and retries after errors. Existing helper-unavailable error is Mac-specific and needs Linux wording.

## 6. Window lifecycle

Create Studio lazily once per app lifetime; hide/show across switches, destroy only at app shutdown. A switch changes presentation, never recording ownership. Keep the HUD renderer alive while its BrowserWindow is hidden. Main owns desired mode separately from capture-guard visibility so a pause callback cannot accidentally show both windows. Existing Linux capture UI integration is at `handlers.ts:2973` and windows.ts privacy/visibility methods.

Open/focus Studio only after readiness and safety checks; hide pill after Studio is ready. Back hides Studio and restores pill through the existing capture guard, not unconditional show(). Closing Studio means Back. Escape means Back unless consumed by a focused control; keep existing global pause/stop shortcuts routed through the same controller. Do not register competing globals per window. Pending operations disable conflicting controls.

Restore prior safe output and normal bounds where supported; never infer monitor safety from requested setBounds. On KDE require verified compositor placement, not optimistic coordinates. If safety is revoked, hide Studio and restore safe controls without changing capture state. On Stop retain Studio until media finalization succeeds, then hide it before the existing review window is presented; retain final snapshot/transcript jobs for review. Stop failure keeps recoverable controls visible. New take clears replay selection and advances generation. Replay defaults muted while recording to avoid system-audio recapture; audio requires an explicit product decision.

## 7. Small implementation slices

Keep new modules under roughly 300 lines; existing oversized files receive wiring only.

1. Add `electron/studio/types.ts`, `takeRepository.ts`, `takeRepository.test.ts`; wire committed lifecycle events in nativeMacRecordingService and handlers. Tests: phase/error transitions, webcam late attachment, clip removal, reset preserves final clip, stale take rejection.
2. Extract `src/components/launch/useRecordingCommands.ts` from LaunchWindow. Add `electron/studio/ipc.ts`, sender authorization and serialized operations. Proposed channels: studio:get-snapshot, studio:snapshot, studio:command, studio:set-mode. Typed preload methods getStudioSnapshot/onStudioSnapshot/studioCommand/setRecordingView, with unsubscribe support. Update existing electron preload and renderer API declarations at their actual locations. Tests: hidden HUD command delivery, camera finalization ordering, duplicate Pause/Stop, Pause immediately followed by Stop.
3. Add `electron/studio/window.ts`, `captureSafety.ts` and tests; route Studio in the existing renderer entry. Integrate windows.ts capture guards without claiming KDE exclusion. Tests: no verified safe output, source change, hotplug, movement, failed creation, close/back, one visible presentation. Ship paused Studio first, with its recording restriction explicit.
4. Add `src/components/studio/StudioWindow.tsx`, `useStudioSnapshot.ts`, `StudioReplay.tsx`, `StudioTranscript.tsx`, CSS. Extract shared replay timeline/camera helpers from HudClipPeek without duplicating them. Test segmented boundaries, removed/empty clips, offsets, subscription reload and stale revisions.
5. Add `electron/transcript/autoTranscript.ts` and `transcriptListingRepository.ts`; update liveTranscript.ts cancellation/rerun, main.ts fanout and handlers lifecycle wiring. Extend liveTranscript.test.ts with fake extraction/transcriber promises: resume mid-job, Stop reset final clip, pause while refresh in flight, missing model never downloads, no mic, removal, new take and late old results.
6. Extract camera relay transport into a small shared module; extend useCameraPreviewFrameBridge for multiple consumers or active-consumer switching. Test bitmap ownership, independent acknowledgements, slow/closed consumer, hidden HUD, renderer reload. Live camera is then reusable without reopening V4L2.
7. Add native preview as a separately measured slice across pipewire capture/shim/events and a dedicated renderer frame receiver. Tests: bounded memory, dropped preview frames never block recording, no second portal session, source replacement resets frame identity, pause freshness. Only this slice completes the live-screen requirement.

Before shipping: authorized isolated KDE portal recordings must visibly prove selected-source identity, Studio exclusion/placement behavior, camera continuity, replay file integrity, resume cancellation and Stop/review handoff. Test monitor and window sources, one/two displays, camera disabled, no microphone and helper/model missing. No such runtime verification was performed for this research. Unit tests and builds were intentionally not run.
