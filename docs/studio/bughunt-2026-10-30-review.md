# Studio correctness review — 2026-10-30

Scope: commit e750a47d against its parent. Static end-to-end code review only; app not launched, tests and typecheck not run. No source edits.

## Verified findings

1. **Safety revocation during resume leaves Studio mapped until capture starts**
   - Severity: blocker
   - Location: electron/studio/studioController.ts:133; electron/recording/nativeMacRecordingService.ts:634
   - Scenario: Studio is admitted off-output by beforeCaptureResumes. While service.resume is awaiting disk checks, permissions, reconfiguration or helper.resume, the user moves Studio onto the captured output (or output topology changes). The guard calls revoke, but capturing() still returns false because the service remains paused until helper.resume resolves. revoke clears outside without hiding the window. The helper starts recording before paused becomes false and the handlers publish changed; only then does apply hide Studio. Frames can contain Studio, including transcript/replay.
   - Live reproduction: On Niri with two outputs, pause and place Studio off the captured output. Resume and immediately move it onto that output during resume preparation. Inspect the first frames of the new clip. A delayed helper resume acknowledgment makes the interval deterministic.

2. **Stop overwrites the retained non-live listing and skips the final clip transcript**
   - Severity: major
   - Location: electron/transcript/liveTranscript.ts:138; electron/recording/nativeMacRecordingService.ts:898
   - Scenario: Stop directly from recording with a microphone and an installed model. onSessionStored fires before reset, while the helper/take is still running and paused is false. main remembers the stopped session with live:false, then immediately calls refreshAfterClip. run synchronously calls listing(), which replaces that remembered value with transcriptClipListing() having live:true. Pending final clips enter the blocked branch. Reset emits studio.sync via recording-state change, but no further transcript refresh, so the final clip remains untranscribed. If an earlier pass is still in flight the scheduling can differ; the failure is deterministic with no pass in flight.
   - Live reproduction: With the model installed, record one mic clip and press Stop without Pause. Open the standalone transcript and inspect the blocked snapshot and missing final text; explicitly refresh after Stop to contrast.

3. **A new take displays and copies the previous take’s transcript**
   - Severity: major
   - Location: src/components/studio/studioTranscriptModel.ts:33
   - Scenario: buildStudioSections matches transcript entries solely by clip.index and never compares snapshot.recordingId to snapshot.transcript.recordingId. The transcript service retains its previous snapshot between takes. With automatic transcription unavailable (for example remove the installed model between takes), refreshAfterClip returns without publishing any new snapshot. Pause clip zero of the new take: the old clip-zero text and words are paired with the new clip. Copy includes old text, and sentence clicks seek unrelated moments in new footage. With an installed model this also occurs transiently before the new pass publishes after cache loading.
   - Live reproduction: Transcribe take A, then make the model unavailable without restarting the app. Record and pause take B with different speech. Open Studio: its first clip shows A’s text and Copy copies it.

4. **Replay audio continues through resume preparation and the first captured frames**
   - Severity: major
   - Location: src/components/studio/StudioWindow.tsx:71; src/components/studio/StudioWindow.tsx:141
   - Scenario: Play a committed clip while paused, then press Resume. send only sets pending; the resuming event calls sync while the take still reports paused. Replay hold stays false throughout beforeCaptureResumes and service.resume. Even hiding the BrowserWindow does not pause its media. Only the changed event after helper.resume resolves changes phase to recording and triggers the renderer effect that pauses playback. Playback can therefore reach the microphone/system audio in the new clip.
   - Live reproduction: Play an audible prior clip in Studio, then Resume with system audio capture enabled. Inspect the new clip’s opening audio for the prior replay. Repeat with speakers and microphone capture.

## Plausible — not promoted to verified findings

- electron/niriCaptureWindowGuard.ts begin awaits monitor.ready, outputs query and initialized in Promise.all. Its one-second deadline resolves only initialized and invalidates admission; it cannot bound either other promise. A stalled query/readiness promise would stall the newly awaited resume IPC indefinitely. The concrete subprocess failure conditions were not established in this pass.
- StudioReplay retains failed across source changes, so a transient source error can disable later valid clips. A real source-error scenario was not established in this pass.
