# Studio flow bughunt — 2026-10-30

Built-app runtime pass, not a source-only review. **7 findings: 0 blocker, 2 major, 4 minor, 1 cosmetic.** Known entries in `docs/bugs.md` are excluded. No source fixes, commits or pushes.

Build: `release/studio-20261029-e750a47d/Klippt-Linux-1.9.5.AppImage`, compared at runtime with `release/linux-port-20261029-a9e39d01/Klippt-Linux-1.9.5.AppImage`. All input, pickers, playback and microphone routing stayed inside the private `studio-flow` KWin desktop. `studio-ui` and the host Klippt were not controlled.

Evidence directory, abbreviated **E** below: `/home/olle/dev/screenrec-linux/artifacts/studio-bughunt-2026-10-30/flow/`. `commands.jsonl` records lab commands, timestamps, responses and durations; `cdp.jsonl` records additional built-renderer observations and preload calls. `ui-timeline.json` gives readable text snapshots. Original media remains in the lab's profiles; manifests and transcript copies are in E. CDP used the lab app's explicit localhost debug port 9356, never the host browser.

## 1. Stop during capture leaves the final spoken clip permanently blocked from transcription

**Severity:** major. **Status:** reproduced twice, including a fresh one-clip take without an interruption race.

**Repro:**
1. Start the Studio build with the copied speech model and `Flow_Microphone` selected.
2. Record the 7.435-second speech fixture. Click **Stop recording while still recording**, without first pausing.
3. Wait at least five seconds, then open Transcript and press Refresh. Observe its snapshot after review has opened.

**Expected:** Stop commits and transcribes the final microphone clip; review can access its text.

**Actual:** Review opens with intact video, but the transcript stays `status: "blocked"`, with `text: null`, `error: null`. The transcript window says **“Pause the recording to transcribe the latest clips.”** Recording is already over. Manual refresh also stays blocked. A second three-clip run preserved clip 1's text but left clips 2 and 3 null after resume and active Stop. By contrast, Pause → wait for transcription → Stop retained all six clips' transcript entries.

**Regression comparison:** the **missing-final-transcript outcome is pre-existing**, and the new automatic Stop path fails to fix it. In the previous build, a fresh spoken take → active Stop → open Transcript reports “No clips yet. Record something first,” with `recordingId: null`, `clips: []`. The misleading, permanently blocked retained listing is specific to the new path. Do not describe this as a proven regression from previously working automatic Stop transcription: the previous build had no such automation.

**Evidence:** E/`simple-active-stop-transcript.json`, `active-stop-manual-refresh.json`, `blocked-after-stop-transcript.png`, `simple-active-stop-review.png`; second repro: `active-stop-final.json`, `helper-interrupt-after.json`, `studio-active-stop.log`. Baseline: `previous-active-stop-snapshot.json`, `previous-active-stop-after-refresh.json`, `previous-active-stop-transcript.png`. Successful paused-Stop contrast: `after-stop-snapshot.json`.

**Suspected cause:** `electron/recording/nativeMacRecordingService.ts:900` calls `onSessionStored` before `reset()` at :949. `electron/main.ts:1252` remembers a non-live listing, but the immediate refresh calls `electron/transcript/liveTranscript.ts:138`: `listing()` overwrites it with the still-present recorder listing. Its `live` flag is `this.isRunning() && !this.paused` (`nativeMacRecordingService.ts:233`). `liveTranscript.ts:174` therefore returns blocked. After reset, subsequent refreshes retain that stale live listing. This explains both the observed state and why Pause-before-Stop avoids it.

## 2. Pill renderer crash strands Studio's recording commands without a recovery state

**Severity:** major. **Status:** runtime-observed once; intermittent trigger, not a deterministic crash claim.

**Repro sequence observed:** With microphone and model enabled, record/pause two speech clips, then resume/pause a 1.300-second clip. Immediately resume again and pause after about 0.3 seconds, producing a 0.250-second clip. `cycle.py` records the sequence. Studio continued showing four clips and transcript updates. Clicking **Remove previous clip** then left Resume, Stop and Remove disabled with a pending spinner; the clip was not removed. Reading the hidden pill stopped answering. Switching to the pill did not restore usable controls. Restarting the lab app recovered the four durable clips into review.

**Expected:** recording commands remain usable; renderer failure is surfaced and offers recovery rather than leaving a waiting Studio.

**Actual:** the HUD renderer's Media thread trapped with **SIGTRAP**, PID 3943523, at 00:16:21 CET, immediately after the fourth tiny clip. Studio remained alive, but its command owner was gone. The later Remove click exposed the permanent pending state; it did not cause the earlier crash.

**Regression comparison:** **unresolved**. Four additional rapid ~0.3-second cycles in the previous packaged build completed, including removal, Undo and Stop. The longer second Studio run also completed. One crash versus several non-crashes does not establish introduction in e750a47d. The shared lab memory cap reached 6 GiB; `oom_kill` remained zero. Resource pressure remains a possible contributor. Cleanup-time SIGBUS dumps from stopping AppImage units are excluded from this finding.

**Evidence:** E/`renderer-crash.txt`, `memory-events.txt`, `studio-app.log`, `cycle.py`, `clip4-after-interruption.png`, `remove-desktop.png`, `removed-studio.png`, `commands.jsonl`. Baseline: `previous-race.py`, `previous-app.log`, `previous-remove-undo.png`, `previous-review.png`.

**Suspected cause:** the native Chromium Media-thread trap is not isolated to a source line. The unrecoverable Studio behavior has a clear seam: `electron/studio/studioController.ts:107` sends commands to the pill without acknowledgement/liveness recovery, and `src/components/studio/StudioWindow.tsx:67` clears pending only on another snapshot. No HUD `render-process-gone` recovery handler was found. These are suspected failure-handling causes, not a claimed cause of Chromium's trap.

## 3. Removing a clip in Studio hides its only Undo action in the pill

**Severity:** minor. **Status:** reproduced.

**Repro:** Record a spoken clip, pause, open Studio, then click Remove previous clip. Inspect Studio immediately. Switch to pill within four seconds and press Undo, then reopen Studio.

**Expected:** the removal notice and Undo are accessible in the same recording view that performed removal.

**Actual:** the clip, replay and transcript disappear correctly, but Studio offers no Undo or removal feedback. The hidden pill alone contains “Removed / 00:12 / Undo.” Its notice expires after four seconds, including time spent in Studio. Switching quickly to the pill and pressing Undo restores the clip, replay and original transcript correctly. A person remaining in Studio misses the restoration window.

**Regression comparison:** **new Studio-view failure**. In the previous build the same removal exposes the visible pill's Undo and restoration succeeds. Studio did not exist there.

**Evidence:** E/`remove-only-clip-studio.png`, `remove-only-clip-pill.png`, `undo-studio.png`, `after-undo-snapshot.json`; baseline `previous-remove-undo.png`. Immediate controls and timing are in `commands.jsonl`.

**Suspected cause:** Studio's transport forwards only `remove-last` (`src/components/studio/StudioWindow.tsx:173`). Feedback and the restore callback remain solely in `src/components/launch/LaunchWindow.tsx:1240`, :1257 and :2437; `REMOVED_CLIP_FEEDBACK_MS` is 4000 at :102. Hiding the pill hides this entire UI.

## 4. Resume does not cancel microphone extraction before starting capture

**Severity:** minor; actual capture-quality impact not established. **Status:** reproduced with a controlled timing hold. **This retains and upgrades item 1 from the earlier report**, whose original text is preserved in E/`previous-incomplete-report.md`.

**Repro:** Run E/`extraction-race.py` in the second Studio take. It watches only direct children of the lab app PID, catches the bundled FFmpeg command decoding a lab microphone clip into `/tmp/klippt-transcript/transcript-…wav`, and temporarily SIGSTOPs that one owned extraction child. Resume capture, inspect its state, then SIGCONT the extraction and pause again. The hold widens a short race; it does not replace the extractor or alter app code/media.

**Expected:** resume cancels outstanding extraction before acknowledging active capture.

**Actual:** FFmpeg PID 3981987 was still alive in state `T` after the app reported `phase: "recording"`, `hiddenForCapture: true`, `liveSinceMs: 1793316036751`. The new capture had already started. Releasing extraction allowed it to finish; a later pause retried the interrupted speech clip successfully without a clip error. A temporary blocked/transcribing state cleared. The hold proves missing cancellation, not how much normal extraction competes for CPU.

**Regression comparison:** **pre-existing overlap, incomplete new cancellation**. The previous packaged build's manually requested transcription was tested the same way: its FFmpeg PID 4000257 also remained in state `T` after Resume. The previous build did not automatically transcribe each pause. The new generation/error suppression handles the stale result more cleanly, but still does not kill extraction.

**Evidence:** E/`extraction-race.json`, `extraction-race.py`, `extraction-race-after.png`, `six-clips-snapshot.json`; baseline `previous-extraction-race.json`, `previous-race.py`, `previous-refresh-result.json`.

**Suspected cause:** `electron/transcript/liveTranscript.ts:128` increments generation and calls `stop()` at :133, which only stops/nulls the speech helper. `electron/transcript/microphoneWav.ts:12` owns an independent FFmpeg child with no cancellation input. The await at `liveTranscript.ts:241` continues; :246 can then dereference the nulled helper. The catch at :256 suppresses that stale-generation exception. There is no extraction cancellation to await before capture resumes.

## 5. Successfully transcribed silent clips remain “Waiting to transcribe” forever

**Severity:** minor. **Status:** reproduced on two silent clips.

**Repro:** With the model installed, finish a short silent microphone clip after spoken clips. Wait for the automatic pass to finish. Inspect Studio and the saved transcript cache.

**Expected:** a completed empty result is represented as no speech/completed, with no suggestion that work is still pending.

**Actual:** Studio says “Not transcribed yet. Transcribe now” and “Waiting to transcribe” indefinitely. The service is idle and the corresponding cache entry already contains `text: ""`, `words: []`, `error: null`. First take clip 4 and second take clip 6 both show this. This is distinct from the known trailing-silence hallucination bug: the helper correctly returned no words here.

**Regression comparison:** **new Studio presentation bug**. The previous build's standalone transcript renders its completed empty clip as blank, without “Waiting to transcribe” or a false incomplete action. Runtime snapshot and screenshot captured.

**Evidence:** E/`clip4-after-interruption.png`, `extraction-race-after.png`, `six-clips-snapshot.json`, `transcripts-six-clips.json`; baseline `previous-transcript-snapshot.json`, `previous-silent-transcript.png`.

**Suspected cause:** `src/components/studio/studioTranscriptModel.ts:40` only recognizes nonempty trimmed text. The fallback at :68–74 treats every completed empty entry as waiting. `src/components/studio/StudioWindow.tsx:112` then uses waiting sections to offer Transcribe now, despite the cache considering them complete.

## 6. Native pill dragging can leave Stop and Open Studio outside the screen

**Severity:** minor. **Status:** reproduced in both builds; KWin-specific test evidence.

**Repro:** While paused, drag the pill by its timer grip toward the extreme right of the 1920×1080 private desktop. E/`edges.py` drives an actual compositor drag ending at (1910,500), not an Electron setBounds call. Release and inspect the desktop. Repeat at the left edge.

**Expected:** the painted recording controls remain within the available display or collapse into a usable edge tab.

**Actual:** the timer grip follows the pointer, placing most trailing controls beyond the right edge. The screenshot shows Resume and the timer, with Stop partially cut and Remove/Replay/Open Studio/Settings off-screen. The left-edge case also clips the leading control. Switching Studio → pill does not repair placement. Dragging the grip back remains a workaround. Top/bottom placement showed no additional Studio-button overflow.

**Regression comparison:** **pre-existing**, confirmed by the previous AppImage at the same right-edge target. Studio adds another control that can be lost but does not introduce the placement behavior.

**Evidence:** E/`right-edge-before.png`, `right-edge-after.png`, `left-edge-before.png`, `left-edge-after.png`, `previous-right-edge.png`, `edges.py`, `lab-drag.c`, `commands.jsonl`. `lab-drag.c` preserves agent-lab's private-runtime validation.

**Suspected cause:** Linux uses the compositor's native drag region (`src/components/launch/HudControls.tsx:55`) while `src/components/launch/LaunchWindow.tsx:242` disables the minimizing/docking presentation on Linux. The compositor can place this oversized transparent HUD partly off-screen; no painted-pill clamp was observed. Exact Niri placement remains unverified.

## 7. Replay total rounds up while recording time rounds down

**Severity:** cosmetic. **Status:** reproduced; no cumulative lost-time evidence.

**Repro:** Pause a take whose committed duration has a fractional second of at least 0.5. Open Studio and compare recording transport versus replay total.

**Expected:** both displayed totals use the same rounding convention.

**Actual:** first clip duration 18.833 seconds displays **00:18** recording time and **00:19** replay total. Another clip at 11.866 seconds displays **00:11 / 00:12**. The six-clip take totals 67.748 seconds: transport 01:07, replay 01:08. The final review also shows 1:08 in its heading and 1:07 in playback. This confirms the earlier 00:20 versus 00:21 observation as display rounding, not evidence of a missing recorded second.

**Regression comparison:** **pre-existing**, copied into Studio. The previous build's pill replay showed 00:13 recording time against 00:14 replay total for a 13.500-second clip. Its replay uses the same round(total) expression.

**Evidence:** E/`no-model-studio.png`, `second-take-clip1.png`, `before-stop.png`, `after-stop-review.png`, `session-six-clips.json`, `media-durations.json`, `previous-peek-timer.png`, `ui-timeline.json`.

**Suspected cause:** `src/components/studio/StudioWindow.tsx:47` floors committed milliseconds into seconds; `src/components/studio/StudioReplay.tsx:284` rounds the total. Existing `HudClipPeek.tsx` has the same round(total) behavior. No timer drift beyond the fractional-second display boundary was established.

## Coverage

| Requested area | Result and evidence |
| --- | --- |
| 1. Pill layout at every dock position, screenshots before/after | **Tested free/left/right/top/bottom edge positions** and switches; `*-edge-before.png` / `*-edge-after.png`, plus `dock-{left,right,top,None}-{before,after}.png`. **True dock-tab variants blocked by this Linux build.** Command: `node …/cdp.cjs hud 'window.electronAPI.setHudDock("left")'` (also right/top) returns undefined; the follow-up DOM query finds no `[data-docked]`, platform is linux. `canMinimize = !isLinuxHud` / `dockedSide = canMinimize ? hudDock : null` at LaunchWindow.tsx:242–247 explicitly prevent these states. No tool error is claimed: this is an unsupported-state blocker, not a failed launch. Actual native dragging was exercised instead. Off-screen controls are finding 6. Known settings/Undo popup jumping is not re-reported. |
| 2. Record → pause → resume → pause, 3+ clips; timers vs files | **Tested.** First take 4 clips (18.833, 8.483, 1.300, 0.250 s), second take 6 clips totaling 67.748 s, plus a 3-clip active-Stop take. Session manifests and FFprobe in `media-durations.json`; commands and UI snapshots timestamped. Normal recording timers freeze on pause, resume and reflect removals. Rounding disagreement is finding 7. |
| 3. Remove previous clip and Undo; transcript/list | **Tested both builds.** Removed the only clip to zero, then restored via visible pill. Replay, clip list and original speech text returned; the original media stayed durable. Studio's missing Undo is finding 3. A separate Remove attempt after the renderer crash remained pending, finding 2. |
| 4. Per-clip words, placement, timing, interruption, rerun | **Tested.** Lab-only speech fixture `…/parakeet-tdt-0.6b-v2-int8/test_wavs/0.wav` (7.435 s) says “Well, I don't wish to see it any more, observed Phoebe, turning away her eyes. It is certainly very like the old portrait.” Repeated clips retained that text separately; the 29.740 s four-repeat WAV produced four repeats in clip 3. A distinct ~1 s sample produced “I love you” in its own clip. Automatic results appeared after pauses without opening Transcript. `cycle.py` resumed during an unfinished pass and committed another clip; snapshots show clips 3 and 4 both pending in the rerun, then cached with no clip errors. The widened extraction race retried clip 5 and returned idle; completed silent results are finding 5. Final interrupted/active-Stop failure is finding 1. Temporary loading states are not counted as stuck. |
| 5. No model: no unasked download; offered action | **Tested.** Initial lab profile had no stt-models directory, yet recorded and paused successfully; Studio offered Transcribe now without downloading. Clicking it explicitly created/downloaded the 639 MB model and produced the correct transcript. `no-model-studio.png` and timestamped controls/commands show before and after. The host ONNX model was subsequently **copied**, never moved or changed, into the lab's `profiles/electron/stt-models/parakeet-tdt-0.6b-v3-onnx`; a separate copy went into `profiles/previous/stt-models`. |
| 6. Stop → review; text; Studio/pill state | **Tested paused Stop and active Stop in both builds.** Paused Stop opened review, hid Studio and destroyed the pill; retained six transcript entries. Active Stop also opened review with durable media but failed final transcription, reproduced on 3-clip and fresh 1-clip takes. Transcript/Refresh did not recover it. Findings 1 and 7; `after-stop-snapshot.json`, `active-stop-final.json`, `simple-active-stop-transcript.json`. Review's `klippt-agent transcript` requires Clean cut enabled and returned `Clean cut is off. Call cleanCut.enable first.` This separate agent API limitation was not mistaken for loss of the retained per-clip service text. |
| 7. Logs, CPU, UI stalls under Parakeet | **Tested with stated cap.** Journals saved for each build; one genuine Media-thread SIGTRAP and stranded controls are finding 2. Fifty successful control snapshots had maximum observed round-trip 0.296 s; this excludes the dead HUD's unanswered requests. A 45 s private-process sample measured 13.62 CPU seconds across the app; observed helper lifetimes consumed 2.71 and 1.86 CPU seconds, peaking at ~1.24 GB RSS. `process-samples.jsonl` contains raw samples. One final active-Stop run warned of 31 superseded captured frames. These bounded observations do not establish unrestricted performance: all labs share a 2-core/6-GiB cap and another lab was running. Shared memory pressure counters were high, with zero OOM kills. |
| 8. Earlier extraction-cancellation candidate | **Confirmed with controlled timing hold** in the actual build and repeated in baseline; finding 4. Extraction survived Resume; later text recovered. No claim that ordinary short extraction produces measurable frame loss. |
| 9. Previous-build comparison for each finding | **Done**, using a separate lab userData profile. Active Stop and extraction overlap have pre-existing symptoms; Undo and completed-empty presentation are new Studio behavior; off-screen placement and rounding are pre-existing. Rapid baseline cycles did not reproduce the Media crash; its regression status remains explicitly unresolved. Baseline has no Studio button/API, verified in controls and preload API enumeration. |

## Earlier black replay observation

**Not reproduced with a known nonblack captured source.** A fullscreen, lab-owned animated fixture supplied a visible text/green-square image. Paused Studio screenshots after initial and subsequent clips, after Undo, and after the cancellation test all show recorded pixels. Observed video `readyState` reached 4 and its decoded dimensions were 1920×1080. `inspection-contact.png` is a contact sheet of inspected evidence.

The lab's bare desktop is itself black. Therefore a black replay from an otherwise empty lab is not sufficient evidence of a rendering defect. This run does not prove what caused the earlier probe's black frame, and does not rule out a transient first-frame race. No black-frame bug is claimed without reproduction.

## Test limits and handoff

No Mac, host Niri, physical-display, webcam, system-audio, long-soak or unrestricted performance claim. Linux docking states cannot be forced into a supported UI without changing the build. No source files were changed; the added C/Python/Node files in E are private test fixtures and evidence collectors. SIGSTOP/SIGCONT targeted only identified extraction children of this lab app. Shutdown-only AppImage dumps, harness parsing errors, an initially pending portal picker and a brief test-profile/debug-port overlap are setup/cleanup observations, not product findings.

Lab shutdown and final artifact checks are recorded in E/`handoff-checks.txt`.
