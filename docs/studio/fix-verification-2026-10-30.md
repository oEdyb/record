# Studio fix verification — 2026-10-30

**Result: 3 PASS, 3 FAIL.** Verification of the packaged Linux build, with no tracked source edits, fixes, build, commit or push.

Build: `release/studio-fixes-20261030-64fdf2d4/Klippt-Linux-1.9.5.AppImage`, source `refs/build/studio-fixes` = `64fdf2d4` (full ref in `build.json`). Compared the fix diff with `e750a47d`; the old binary was not rerun because the detailed original reports already establish these reproductions.

All evidence below is relative to **E = [artifacts/studio-bughunt-2026-10-30/verify/](../../artifacts/studio-bughunt-2026-10-30/verify/)**. Original runtime state, screenshots, copied media, FFmpeg output, journals and adapted drivers are retained there. The owning lab was `fix-verify`, CDP port **19371**, private KWin 1920×1080, default video decoding, synthetic-camera flags. No host desktop input, audio, picker, clipboard or Klippt socket was used.

## Six checks

| # | Check | Result | Runtime result and evidence under E |
| --- | --- | --- | --- |
| 1 | Memory/crash mitigation and replay lifetime | **FAIL** | After 22 resume/pause cycles with pill replay never opened, HUD has **zero video elements and no Media player events** (`after22-unopened.json`, `closed-unopened.jsonl`). Pill first-open plays; same single screen element survives close/reopen with **no load events** (`pill-stable-identity.json`, `pill-stable-{playing,closed,reopened}.json`). But hidden Studio retains a loaded, playing video (`hidden-confirmed.json`, `hidden-one-second-later.json`, `hidden-media-clean.json`). 25 clean cycles in Studio mode plus 25 clean cycles in pill mode completed without spontaneous renderer death (`studio-open.jsonl`, `closed-confirmed.jsonl`); additional earlier cycles also completed. |
| 2 | HUD crash recovery and unanswered-command timeout | **FAIL** | SIGKILL of the trace-identified, cgroup-validated lab HUD initially saves all clips, opens review and hides Studio. Repeated with **74 clips** and with **2 webcam clips**. Then the app **quits about 15 seconds later**, twice (`run1-app.log`, `run2-app.log`, `crash-review.json`, saved session manifests). Separate controlled HUD SIGSTOP proves Resume/Stop/Remove disabled while pending and enabled again after 5.7 s (`timeout-pending.json`, `timeout-recovered.json`). |
| 3 | Replay audio isolation on Resume and Switch to pill | **FAIL** | Resume from Studio and from pill pauses replay before native recording. New screen, mic and system files measure **−91 dB mean/peak** in both first 0.6 s and first 1 s (`audio-results.json`, `audio-levels.json`, `audio-*.log`, `media/`). Source speech has **−18 dB mean, 0 dB peak** (`replay-source-levels.log`). But **Switch to pill does not stop playback**: hidden video keeps `paused:false` and its time/source advances (`hidden-confirmed.json`, `hidden-one-second-later.json`, `speech-positive-hidden*.json`). |
| 4 | Stop during capture, single and three spoken clips | **PASS** | Active Stop, without final Pause, ends transcript **idle** with final spoken text. Single take has 1/1 text; multi take has **3/3 text**, no blocked status or clip errors (`active-stop-single.json`, `active-stop-three.json`, `three-current.json`, saved `.session.json` manifests). |
| 5 | Previous-take transcript must not show/copy in new take | **PASS** | After transcribing A, renamed only the lab model copy, recorded and paused B. Snapshot deliberately retains A's transcript recording ID, but B's actual Studio shows **Waiting to transcribe / Transcribe now**, no A words, and **Copy disabled** (`stale-before.json`, `stale-take-b.json`, `stale-copy.json`, `stale-private-desktop.png`). Model restored afterward. |
| 6 | Webcam files and overlay in Studio | **PASS** | With camera enabled before a fresh take, paused Studio clip carries `webcamVideoPath` and `webcamOffsetMs:0`. Two healthy videos load, screen 1920×1080 and camera 3840×2160; screenshot visibly shows green synthetic-camera overlay (`camera-fresh.json`, `camera-fresh.png`). Screen and webcam fully decode with FFmpeg exit 0 (`screenVideoPath-decode.txt`, `webcamVideoPath-decode.txt`, copied originals in `media/`). |

A row is FAIL if any explicitly requested subcheck fails; passing Resume audio isolation does not conceal the separate Switch-to-pill failure.

## FAIL details and causes

### 1 and 3: Studio visibility does not follow its native window

Reproduction: record/pause, Open Studio, seek/play, click **Switch to pill**, wait a full second and inspect both windows and media. `hidden-confirmed.json` records native Studio `visible:false`, but renderer `document.hidden:false`, `visibilityState:"visible"`. The video remains readyState 4, unmuted and playing. One second later it has progressed from clip 2 to clip 4. A separate long-clip repeat progresses from 0.652 s to 2.686 s while hidden (`positive-hidden.json`, `positive-hidden-later.json`).

The pinned source explains this mismatch: `electron/windows.ts:1221` configures Studio with `backgroundThrottling:false`; `src/components/studio/StudioReplay.tsx:113–120` relies exclusively on `visibilitychange` / `document.hidden` to unmount video and stop playback. In this actual build those document values never become hidden when the BrowserWindow hides. `StudioController.backToPill()` hides the window without publishing an explicit replay hold. Thus the new visibility-based cleanup is not reached. These two failed rows share the same observed mechanism. A private sink-monitor recording during the speech-bearing hidden replay measures **−20.5 dB mean, −7.9 dB peak** (`hidden-speech-playback.wav`, `hidden-speech-levels.log`), confirming that sound also continues, not just the video clock. An earlier monitor sample preceded the speech and is not used as audible-playback evidence.

Resume is a passing contrast: recorded events show hold/pause before recording. For the Studio-triggered case, pause at **1793319654332** precedes recording at **1793319654773**; for the pill-triggered case, pause at **1793319659237** precedes recording at **1793319659680**. The new clips' first-second audio is silent in every delivered original, and their source replay contains real speech.

### 2: recovered review is followed by an unintended app quit

Reproduction: paused take with 2+ committed clips, Studio open; identify HUD's CDP frame via `TracingStartedInBrowser`, resolve its `processId`, verify `/proc/PID/cgroup` belongs to `agent-lab-fix-verify-client-*` and cmdline contains `--type=renderer`, then SIGKILL only that PID. `fault.cjs`, `identify-hud.cjs`, `fault-pid.json`, `process-trace.json` retain the method and final target identification. Never inferred a PID from a generic Electron renderer name.

Initial recovery is real: populated review opens and Studio hides. The final repeat's review says **2 clips**, and its saved manifest retains both screen and webcam originals. The earlier run saved **74 clips**. Then, with no further input in the second repeat, the app exits:

- **01:22:39:** `[hud] the recording pill crashed: killed 9`.
- **01:22:40:** review opens with 2 clips (`crash-review.json`).
- **01:22:55:** `Stop before quit did not finish in 15000 ms ... quitting.`
- Same instant: `Renderer camera handoff deadline expired.`
- Subsequent lab agent command reports Klippt is not running; compositor screenshot shows only the fixture (`crash-recovered-desktop.png`).

Source-supported cause: the new `stopTakeWithoutPill()` stops native capture but leaves the renderer handoff pending. `isNativeMacCaptureRunning()` at `electron/ipc/handlers.ts:216` still returns true while `rendererRecordingStop.pendingRecordingId()` is non-null. Showing recovery review closes the old, quit-protected HUD (`electron/main.ts:793–796`, `:1189`). Its close guard runs `stopBeforeQuit()`, waits for the dead renderer's handoff, times out after 15 s, and calls app quit (`electron/recording/quitCaptureGuard.ts`, `nativeMacRecordingService.ts:427`). This matches both journals, including the camera-disabled first crash. The 15-second wait is not a new native media crash or OOM.

`crash-after-delay-windows.json` was collected before that timeout and still shows review; it is not evidence that review survived the full recovery interval. The later journal and compositor capture establish the exit.

## Requested regressions and other observations

- **Pill replay opening: PASS.** First open creates one screen player (camera off), with readyState 4 and playback. A clean single-source close/reopen keeps the same element and records **zero** `emptied`, `loadstart`, or `loadedmetadata` events (`pill-stable-identity.json`). Earlier tiny-clip toggle probes legitimately crossed sources because opening seeks to the last five seconds; their load events are not claimed as a same-source reload regression.
- **Studio seeking after hide/show: PASS for playhead preservation.** Explicitly paused at 5.000 s, hid, reopened: still 5.000 s, readyState 4 (`final-seek-before-hide.json`, `final-seek-hidden.json`, `final-seek-restored.json`). This passed while the player remained loaded, so it does not prove restoration after successful unloading.
- **Studio Home/End: PASS.** Home selected first clip at 0; End selected last clip at total, slider now=max; ArrowLeft also moved backward (`studio-home.json`, `studio-end.json`, `studio-before-hide.json`).
- No additional independently established product issue beyond the failures above. Enabling camera midway through an existing take did not yield webcam originals in that clip; the camera check was correctly rerun with camera enabled **before** fresh Record and passed. This setup difference is not asserted as a new regression.

## Method, boundaries and cleanup

Drivers were adapted from the supplied `crash/k.py`, `matrix.py`, `capture-media.cjs` and `studio-ui/drive.cjs`; lab name and CDP port were changed only in evidence scripts. Actions are timestamped in `actions.jsonl`; cycle records contain actual enabled Pause/Resume controls. An early attempted hidden-HUD Playwright click timed out waiting for visibility; subsequent explicit hidden-renderer actions used the existing agent/UI surface or forced lab CDP clicks. One cycle run overlapped a diagnostic, so the clean `closed-confirmed` 25-cycle run was added to establish unambiguous pill-mode coverage. It is the clean run counted in the primary matrix.

Private audio: null sink `verify_speech`, remapped source `verify_mic`, default source set only in the lab. Speech fixture reused from `.../parakeet-tdt-0.6b-v2-int8/test_wavs/0.wav`. All test output stayed on the lab's private `agent_lab_audio` graph. The host model was copied into lab `profiles/electron/stt-models`; only that copy was renamed/restored. Synthetic flags prevent physical-camera access. The private Kitty green fixture distinguishes valid capture from the lab's black desktop.

Signals were limited to cgroup-validated lab HUD renderers: SIGSTOP/SIGCONT for timeout and SIGKILL for crash. No model or media was deleted. Original media remains in the lab profile, with relevant manifests and measured/decoded originals copied into E. No old-build comparison, Mac, Niri, physical devices, long soak, allocation-limit injection or unrestricted performance claim. These bounded no-crash cycles do not prove elimination of the original unexplained allocation failure.

Application unit tests, typecheck, lint and packaging were not rerun: this task tests an existing immutable AppImage and adds documentation/evidence only. Documentation check and final lab shutdown are recorded in `docs-check.txt` and `shutdown.txt`. Existing dirty tracked-source changes belong to the implementation work and were left untouched.


## Round 2 — 3309dcc1

**Result: A PASS, B PASS, C PASS.** Verification only of `release/studio-fixes-20261030-3309dcc1/Klippt-Linux-1.9.5.AppImage`, source `3309dcc1d236a5ba2c3878b5c6d304073ddb6187` (`refs/build/studio-fixes`). No source edits, build, commit, push or host-app operation. The preceding Round 1 findings remain the historical result for `64fdf2d4`.

Round 2 evidence is relative to **E2 = [artifacts/studio-bughunt-2026-10-30/verify2/](../../artifacts/studio-bughunt-2026-10-30/verify2/)**. `build.json` and `appimage-sha256.txt` identify the tested package. Private lab: `fix-verify2`, CDP **19381**, KWin 1920×1080, synthetic-camera flags, private `verify_speech` sink and `verify_mic` source. The previous drivers were copied with only lab, port and evidence-directory substitutions; supplementary `round2-*.cjs` drivers implement the requested timing, native close, 65-second observation and save checks.

### A — hidden Studio replay: PASS

Tested **Switch to pill**, **Esc**, and **native window close** (private compositor Alt+F4). Each started with unmuted, playing speech from the recorded original. The positive sink-monitor samples measure approximately **−21.2 dB mean / −3.0 dB peak**; these establish actual output before hiding.

- First observed zero attached Studio `<video>` elements: **25 ms**, **25.2 ms**, and **175.1 ms**, respectively, including native-close input overhead. Sampling interval was 25 ms; these are observation bounds, not exact teardown latency.
- Native Studio visibility and snapshot `shown` become false. No videos return during the subsequent three-second monitor capture. The detached player is paused with its `src` attribute removed; its clock remains zero, and the displayed take position remains fixed.
- All three hidden sink-monitor samples measure **−91 dB mean and peak** (digital silence).
- Reopening recreates a readyState 4 player at **23.223629**, **23.211231**, and **23.332455 seconds**. Those positions match the hide point within the action/sampling interval; native close includes 100 ms focusing plus the compositor key action. Clicking Play advances the restored player in every case.

Evidence: `a-results.json` (25 ms samples, native windows and restored/playing states), `a-{switch,escape,native-close}-{playing,hidden,later,restored,replaying}.json`, `a-*-{audible,silent}.wav`, `a-audio-levels.json`, and `a-restored.png`. Initial default-buffer monitor attempts yielded empty positive samples; they are retained in `short-monitor-attempt/` and are **not** used for the audio verdict. The decisive repeat uses three-second captures with `parec --latency-msec=20` and contains real audible and silent samples.

### B — HUD crash recovery: PASS

Repeated with **three clips, camera off**, then **two clips, camera on before Record**. `identify-hud.cjs` identifies the HUD frame and process through tracing; `fault.cjs` checks `/proc/PID/cgroup` for `agent-lab-fix-verify2-client-*` and the renderer command line before SIGKILL. Only those two lab HUD renderers were signaled. Studio was open and each take was paused.

- Review opens with all **3/3** and **2/2** clips; Studio hides. Recovery clears the active Studio snapshot to idle/zero clips, so the verdict uses the actual populated review and durable session manifests, not that reset snapshot.
- Lab `klippt-agent ping`, `windows`, and final `controls` still respond at **65.253 s** and **65.688 s** from the pre-fault timestamp. Both report the same main app PID, **167804**. No UI input occurs during either observation interval.
- `run-app.log` records both intentional renderer deaths and contains **no `Stop before quit` timeout, camera handoff deadline, or quit** during either recovery interval.
- Normal **Save video → Separate files → Save files** completes through the private native folder picker in both runs. All **9 camera-off originals** and **8 camera-on originals** are byte-identical to their saved copies; both source bundles include their timelines. All four saved camera-run screen/webcam videos fully decode with FFmpeg exit 0.
- Closing each Save dialog and choosing **New recording** creates a fresh pill. Each replacement pill records and pauses a new clip. After the final new take is stopped, private Alt+F4 closes the native review window; `normal-close.json` confirms its page is closed and the editor is absent from window enumeration. Hidden Studio remains alive until lab shutdown; this is not claimed as an application-quit test.

Evidence: `b-{no-camera,camera}/` contains target PID/cgroup, traces, before/recovery states, review screenshots and timed `heartbeats.json`; `b-*-saved.json`, `b-save-integrity.json`, saved source bundles, copied `recording-*.session.json`, `b-camera/decode-results.json`, `b-camera-before.png`, `c-fresh-pill.json`, `c-before-first-open.json`, `normal-close.json`, and `run-app.log`.

### C — quick regressions: PASS

**Resume audio:** Resume was invoked once from Studio and once from the pill while Studio replay was unmuted and playing the speech-bearing portion at about 21 seconds. All three originals from each new clip (screen mix, microphone, system audio) measure **−91 dB mean/peak over the full first second**. Evidence: `audio-{studio,pill}-before.json`, `audio-results.json` (pause/hold/recording events and committed paths), `c-audio-levels.json`, `c-*-first1.log`, and copied originals in `media/`. `round2-resume.cjs` supplements the original audio driver by seeking to the known speech interval.

**Pill first-open:** In the fresh camera-off take after the second recovery, the unopened pill has zero videos. Its first Replay action through the existing lab agent creates one loaded, unpaused player; samples advance **0.381037 → 0.784704 → 1.284992 s**, readyState 4. Evidence: `c-before-first-open.json`, `c-first-{opened,advancing,later}.json`, corresponding DOM captures, `c-fresh-windows.json`, and `c-pill-first-open.png`. Earlier forced-click camera probes did not establish an open replay panel and are not counted; the final check uses the normal lab agent control.

### Round 2 boundaries and cleanup

All input, native pickers, audio and screenshots stayed inside `fix-verify2`. The host desktop, clipboard, physical audio/camera, host Klippt process/socket and `~/.config/Klippt` were untouched. No files were deleted. Original media remains in the private profile and the relevant originals/source bundles are retained under E2. Existing dirty source work was left untouched.

Only these packaged runtime checks and the repository documentation check were run; no unit suite, typecheck, lint, repackaging, physical-device, exact Niri or Mac claim. `docs-check.txt` records the documentation gate. `shutdown.txt` records `agent-lab stop fix-verify2` and the final stopped status.
