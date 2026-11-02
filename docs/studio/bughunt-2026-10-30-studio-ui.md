# Studio UI bug hunt — 2026-10-30

Live built-app pass on `feat/studio`, commit `e750a47d`, using
`release/studio-20261029-e750a47d/Klippt-Linux-1.9.5.AppImage`.
Private desktop: **studio-ui**, KWin, 1920×1080. The studio-flow lab was not controlled.
No tracked source edits, fixes, commits or pushes.

**Findings below: 3 major, 3 minor; 0 blocker, 0 cosmetic.** Existing review items 2–4
were also reproduced and are confirmed separately, without duplicate findings.
All numbered findings have runtime evidence; suspected causes are source-level explanations,
not substitutes for reproduction.

Evidence prefix **E** = `artifacts/studio-bughunt-2026-10-30/studio-ui/`.
Screenshots are private compositor captures, paired where possible with renderer/native snapshots.

## Findings, most severe first

1. **Studio's take snapshot omits recorded webcam files**
   - **Severity:** major.
   - **Repro:** launch the AppImage with Chromium's synthetic camera (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`); enable webcam, microphone and system audio. Source → Virtual-0 → Record; play private speech; Pause → Open Studio. Inspect the Studio snapshot after camera finalization. Repeat Continue/Pause, then Stop and inspect the stored session/review.
   - **Expected:** committed Studio clips include their finalized `webcamVideoPath` and offset, allowing replay to composite the recorded camera.
   - **Actual:** take `1793316181703` has a finalized, decodable `clip-0001-webcam.mp4`, but the paused Studio clip has no webcam path or offset; the renderer has only the screen video. The same omission persisted across further clips. After Stop, the stored session contains the webcam paths and review visibly displays the green synthetic camera.
   - **Evidence:** E`31-camera-ready.json`, E`37-camera-two-paused.json`, E`47-camera-session.json`, E`47-synthetic-camera-original.png`, E`47-stopped-review.png`.
   - **Suspected cause:** `electron/recording/nativeMacRecordingService.ts:208` copies `this.clips` without merging `this.originals`. `registerRendererWebcam` at `:1090` registers into originals; the final session merges these, while `studioTake()` does not. `src/components/studio/StudioReplay.tsx:65` requires the missing field to render the overlay.
   - **Status:** **reproduced in runtime metadata**, with successful camera media and review verification. This camera-specific diagnostic run used `--disable-gpu`; Studio did not map in that variant. Thus the missing camera data is confirmed; an on-screen Studio camera-overlay comparison in that variant is blocked, not claimed. The other visible Studio tests below used GPU rendering.

2. **Removing the viewed last clip leaves an impossible clip number and playhead**
   - **Severity:** major.
   - **Repro:** record/pause three clips. Open Studio, drag the seek bar near the end of clip 3, then click Remove previous clip.
   - **Expected:** replay selects a remaining clip, clamps its playhead to the shorter take, and updates its clip label.
   - **Actual:** screenshot shows **“Clip 3 of 2”**, **`01:01 / 00:48`**, while transport correctly shows `00:47`. Earlier pass also produced `01:01 / 00:46`. A remaining video's pixels can appear underneath the stale label and playhead.
   - **Evidence:** E`60-selected-clip-removed.png` and `.json`; E`57-live-matrix.json` entries `third-selected-before-removal` / `third-removed`; independent runtime repeat E`46-replay-matrix.json`.
   - **Suspected cause:** `src/components/studio/StudioReplay.tsx:63` clamps only the selected source lookup. Its `clipIndex` and `position` state survive removal; the total-change effect at `:88` does not seek once `touchedRef` is true.
   - **Status:** **reproduced**, confirming previous Studio-UI item 2.

3. **One unavailable replay source disables playback of healthy clips**
   - **Severity:** major.
   - **Repro:** with several committed clips, select the last clip. Temporarily rename only its lab-owned screen file; reload that video's same media URL with a unique query to bypass cached bytes. Wait for the real media load error, restore the file, then pointer-seek to clip 1.
   - **Expected:** the valid clip loads, the old error clears, and Play works again.
   - **Actual:** failed source reports `DEMUXER_ERROR_COULD_NOT_OPEN`. Clip 1 subsequently loads with `readyState: 4`, correct duration and visible fixture pixels, yet **“Unable to play this clip”** remains and playback stays disabled. Merely choosing a valid clip does not recover it.
   - **Evidence:** E`64-playback-source-error.png` / `.json`; E`65-valid-clip-after-error.png` / `.json`; exact reversible fault procedure E`source-error.cjs`.
   - **Suspected cause:** `src/components/studio/StudioReplay.tsx:55` initializes `failed`; `:188` sets it true, but source changes never clear it. `:233` disables Play on that flag.
   - **Status:** **reproduced with an explicit missing-file fault**, confirming previous Studio-UI item 1 and the review report's plausible “failed” replay state. No actual user media was altered; the lab file was restored in `finally`.

4. **Transcript errors show raw FFmpeg output without a retry action**
   - **Severity:** minor.
   - **Repro:** pause a new microphone clip while the model is unavailable, so no automatic job has cached it. Temporarily rename that lab clip's microphone file. Restore the copied model and request transcript refresh through the app API; inspect Studio. Restore the microphone file.
   - **Expected:** a readable clip-level error and Try again, as specified in `docs/studio/ui-ux.md`. Recording/replay controls remain usable.
   - **Actual:** the sidebar prints FFmpeg's input pointer, the full absolute filename, and repeated “No such file or directory” output. It offers neither Try again nor Transcribe now. A subsequent supported `refreshTranscript()` after restoring the file succeeds and produces the correct second-take text, proving recovery is available underneath the UI.
   - **Evidence:** E`71-transcript-error.png` / `.json`, E`71-transcript-fault-response.json`, E`72-correct-second-take-text.png` / `.json`, E`72-transcript-retry-response.json`.
   - **Suspected cause:** `src/components/studio/StudioTranscript.tsx:150` renders `section.error` verbatim. `src/components/studio/StudioWindow.tsx:104` offers the refresh action only for waiting sections, excluding error sections; `:94` also returns global errors without an action.
   - **Status:** **reproduced with a reversible lab-only missing-microphone fault**. File/model paths were restored.

5. **New transcript sections scroll selected older text out of view**
   - **Severity:** minor.
   - **Repro:** use 640×560 Studio. While a later clip is waiting/transcribing, select the last sentence of clip 1 near the sidebar bottom. Continue/pause another clip and let the sidebar update without clearing the selection.
   - **Expected:** preserve the selected text's reading position; offer Latest clip instead of following automatically.
   - **Actual:** selection remains nonempty in the live renderer, but the sidebar scrolls from top `0` to `58` and then `84` pixels as sections/status change. The selected first-clip sentence disappears above the viewport. In the screenshots, the selected sentence is initially visible; after the next clip, the visible content begins at clip 2.
   - **Evidence:** E`58-selection-bottom.png`, E`59-clip-3-text.png`, and E`57-live-matrix.json` entries `selection-before-new-clip`, `recording-3`, `clip-3-text`, `seek-clip-1`. Selection was set using the browser Selection API on actual transcript text; no transcript fixture was injected.
   - **Suspected cause:** `src/components/studio/StudioTranscript.tsx:53` scrolls to the bottom whenever `followRef` is true, without checking selection or focus. Only scroll distance at `:66` controls following.
   - **Status:** **reproduced**, confirming previous Studio-UI item 3. Ordinary scroll-away + Latest clip behavior separately passed.

6. **Replay seek bar ignores Home and End**
   - **Severity:** minor.
   - **Repro:** pointer-drag the replay slider to approximately 6.6 seconds in a 16.516-second clip; focus it; press Home, then End. Press ArrowRight as a control check.
   - **Expected:** Home seeks to 0 and End to the total; arrows step through replay.
   - **Actual:** Home and End leave the slider at rounded value `7` and display `00:06 / 00:17`. ArrowRight changes it to rounded value `12` / display `00:11`. ArrowLeft was also exercised in the final boundary pass.
   - **Evidence:** E`15-home-key.png` / `.json`, E`16-end-key.png` / `.json`, E`17-arrow-right.png` / `.json`, E`82-boundaries.json`.
   - **Suspected cause:** `src/components/studio/StudioReplay.tsx:249` recognizes only ArrowLeft and ArrowRight and returns for Home/End.
   - **Status:** **reproduced**, confirming previous Studio-UI item 4.

## Coverage matrix

| Area | Exercised result and evidence | Concrete boundary / blocker |
|---|---|---|
| **1. Open idle / recording / paused; placement, focus, header** | Idle pill controls inspected: no Open Studio entry. Invoked the existing `openRecordingStudio()` API to inspect idle disabled transport and empty content (`05-idle-studio.png` / `.json`). During monitor capture, Open Studio creates/updates it but keeps it hidden; hidden renderer shows Recording and active-clip placeholder. Pause → Open Studio maps/focuses it. Initial size 1651×929, fully on private desktop; headers Studio / Paused match snapshots. `07-recording-desktop.png`, `10-live-check.png`, `56-final-live-paused.*`, `75-default-build-waiting.*`. | A visible recording Studio on the same captured KWin monitor is intentionally unavailable: native snapshot has `hiddenForCapture:true`. No Niri/two-output safety claim. Window-source selection was attempted; the attempted fresh window-source start returned to idle without an encoder-selection event (`52-selected-window-recording.json`, `54-start-blocker.png`, run4 log). It is not counted as a Studio failure. |
| **2. Pill / Esc / close / reopen ×5** | Five sequential cycles: Switch to pill, Escape, compositor close, Escape, Switch to pill; reopen after each. One Studio and one HUD remain. HUD returns visible/focused, at compositor position `[724,484]`, 472×112 every cycle. Studio retains 640×560. `23-lifecycle.json`, `23-reopen-1.png` through `23-reopen-5.png`. Compositor geometry was checked rather than trusting Wayland's requested BrowserWindow coordinates. | No duplicate or moving pill reproduced in these cycles. Closing used private KWin `closeWindow()`, the native close event; Studio is frameless and has no OS titlebar close button. |
| **3. Transport, phases and timers** | Idle controls disabled. Pause via pill and Studio; Resume via Studio; Stop both paused and active; Remove while paused, remove the viewed clip, and remove to zero. Recording disables remove/replay playback. Hidden pill and Studio controls/snapshots checked together (`actions.jsonl`, `26-second-clip-arrives.*`, `57-live-matrix.json`, `73-remove-to-zero.*`). Timer advances only while recording and stays fixed during replay/paused reading. | A one-second timer/replay-total difference is rounding, not demonstrated clock drift: helper 16.516 s → transport `00:16`, rounded replay total `00:17`, encoded file 16.538 s. Other samples: 8.633/8.655 s, 13.883/13.909 s, 34.266/34.288 s. `duration-checks.json`; `12-snapshot.json`. Resume evidence includes real capture phase timestamps in `27-replay-resume-complete.json`. |
| **4. Replay** | Bright private Kitty fixture recorded, distinguishing actual content from black. Play/pause; pointer drag and click seeking; arrows/Home/End; source/label checks in all three clips; automatic playback across both clip boundaries (`82-boundary-1.*`, `82-boundary-2.*`, `82-boundaries.json`); mute/unmute; new clip retains earlier touched playhead (`26-second-clip-arrives.*`); resume while playing; selected-clip removal; actual media-error recovery fault. Synthetic webcam captured separately and compared with Studio metadata/final review. | Findings 1–3 and 6; existing review item 4 confirmed below. Black replay was observed early, but a fresh profile with default video decoding later displayed the bright fixture correctly (`75-default-build-waiting.*`). Details below; no unconditional black-replay finding. |
| **5. Transcript states and actions** | Actual private speech through remapped source/`paplay`; recording, waiting, transcribing, text and error states reached. Models copied into the actual `userData/stt-models` path. Fresh missing-model profile offers Transcribe now (`75-*`); copy model, click action (`76-*`), completed text (`77-*`). Sentence click seeks with active highlight (`14-*`); Copy read with lab `wl-paste` (`20-private-clipboard.txt`). Follow-bottom, selection, manual scroll-away and Latest clip exercised: top remains 0 while offscreen content arrives, then Latest moves it to 172 (`66-*`, `67-*`). Different second take displays/copies first-take words (`69-*`, `70-*`); supported refresh produces correct words (`72-*`). | Findings 4–5 and review item 3 below. Missing-file faults affected only this lab's files; all restored. Initial missing `espeak-ng` was worked around with lab-local extracted binaries/libraries; host audio was never used. The rendering/copy result required a real lab pointer click for a clipboard activation serial; an earlier DOM-only Copy followed by `wl-paste` returned “Nothing is copied” and is not treated as a product failure. |
| **6. Stop → review** | Paused Studio Stop hides Studio, opens populated review, and retires the capture HUD (`47-stopped-review.png`, `47-stopped-windows.json`). Review retains kept clips and camera. Active Stop also opens review (`78-active-stop-review.png`, `78-active-stop-windows.json`); final transcript remains blocked (`78-active-stop-transcript.json`, `79-final-transcript-blocked.*`). Stop after removal to zero returns to idle pill (`73-*`, actions log). | Active Stop's transcript defect is review item 2, not duplicated here. |
| **7. Minimum/narrow/empty/overflow** | Native private compositor resized Studio to 900×700 and actual minimum 640×560. Stack layout, stage, transport, sidebar, header and sentences remain visible (`21-narrow-900.*`, `22-minimum-640.*`, `22-layout-controls.json`). No horizontal page overflow measured. Long FFmpeg error wraps inside sidebar (`71-*`). Idle and removal-to-zero empty states captured (`05-*`, `73-*`). | `Browser.getWindowForTarget` is not implemented by this Electron build; CDP resize returned that protocol error. Replaced it with lab-private KWin geometry changes, then verified actual viewport dimensions. No text-zoom/localization expansion claim. |

## Existing review report — live status, without duplicate findings

Source: `docs/studio/bughunt-2026-10-30-review.md`.

- **Item 1 — safety revocation during resume:** **not reproduced; concrete platform blocker.**
  `agent-lab run studio-ui -- sh -c 'test -n "${NIRI_SOCKET:-}" || { echo "NIRI_SOCKET is unset; private compositor is KWin"; exit 2; }'`
  returned exactly that message, exit 2. This lab cannot exercise Niri's two-output admission/revocation race. No host compositor input was sent.
- **Item 2 — active Stop skips final transcript:** **reproduced.** In the fresh default-decoder profile,
  transcribe clip 0, Resume, feed different private speech, then Stop directly while recording.
  Review opens but snapshot remains `status:"blocked"`, with clip 0 text and clip 1 `text:null`, `error:null`.
  The standalone transcript asks to pause although capture is over. E`78-active-stop-transcript.json`,
  E`78-active-stop-review.png`, E`79-final-transcript-blocked.png` / `.json`.
- **Item 3 — previous take text displayed/copied:** **reproduced.** Model temporarily unavailable between
  takes in the same app. Paused new take ID **1793316763934** carries transcript ID **1793316542478**.
  B's audio says “Bananas and rockets”; Studio shows A's “first studio recording / green camera” text.
  Real lab-pointer Copy + private `wl-paste` returns A's text. E`69-second-take-stale-text.*`,
  E`70-second-take-wrong-copy.txt`. Restored model and refreshed; E`72-*` shows B's correct text.
- **Item 4 — replay audio continues during Resume:** **reproduced, including captured audio.**
  Replay playing at 1.615 s receives a paused/resuming-preparation snapshot at **1793316102953**.
  First recording snapshot at **1793316103471** still sees `video.paused:false`; media pauses at
  **1793316103476**, 523 ms after the earlier snapshot. New clip's first 0.6 s measures **−20.3 dB mean,
  −1.4 dB peak**; its 1–4 s section is **−91 dB**. No speech fixture was playing in this new clip:
  the only active audio was replay. E`27-replay-resume-complete.json`, E`27-resume-audio-start.log`,
  E`27-resume-audio-later.log`, E`24-playing-before-resume.*`, E`25-resumed-hidden.png`.
- **Plausible failed-replay state:** **reproduced** by the reversible missing-file test; finding 3.
- **Plausible unbounded Niri query/readiness wait:** **not exercised**, same platform blocker as item 1.

## Black replay, empty stage space and diagnostic limitations

- Early run showed a completely black paused Studio at `00:20 / 00:25`, with Transcribing and no useful
  error (`10-live-check.png`). `node E/drive.cjs snap studio 08-first-paused` timed out after 30 seconds
  in `page.screenshot`; `k.py studio controls` also exceeded its 15-second subprocess limit.
  Another run lost the HUD renderer to a Media-thread SIGTRAP (`28-hud-crash.txt`, `run2-app.log`).
  These runs had synthetic-media/debug flags. A source-selection run also dumped a renderer before
  reaching Studio. Neither the exact native crash cause nor a consistent Studio-only trigger was isolated.
- `--disable-accelerated-video-decode` allowed the main visible matrix; **it is not proven to fix the cause**.
  `--disable-gpu` allowed recording/synthetic webcam media but prevented Studio mapping; `windows` kept
  reporting Studio `visible:false`, and private `window.py size 640 560` returned `false` because KWin
  had no mapped Studio. Window screenshots also failed to complete. That diagnostic run's desktop
  captures showing the pill are **not** presented as screenshots of a visible Studio.
- Crucially, the later **fresh-profile default-decoder run** (only `--remote-debugging-port=19351`, no
  synthetic camera or GPU flags) rendered replay with `readyState:4`, 8.655 s media and bright fixture
  pixels (`75-default-build-waiting.*`), and played short clips across both boundaries (`82-*`).
  Therefore the broad claim “paused Studio always replays black” is **not reproduced consistently**.
  The early black/hung state is retained as a diagnostic observation, excluded from the severity count.
- The space above/below a 16:9 stage is consistent with its centered contain layout. At 1651×929,
  the stage is about 1187×668 inside a taller slot. No excess-space defect beyond that fit was established.
- The final profile's successful waiting/Transcribe now/text pass and active Stop evidence are independent
  of the synthetic-camera diagnostic run. Camera metadata, replay fault injection and missing-mic fault
  are explicitly qualified above rather than claimed as ordinary untouched-device flows.

## Harness and cleanup

- Only lab-scoped input, sockets, clipboard, audio, windows, models and media were used. Audio routed to
  the lab's `agent_lab_audio` / remapped virtual microphone; no physical speakers or microphone.
- `foot` and `espeak-ng` were absent (`No such file or directory`). Used private Kitty and extracted
  espeak-ng/libsonic/pcaudiolib under the lab state directory. No packages installed on the host.
- The host ONNX model was **copied**, never moved or modified. All renamed lab model/microphone/screen
  files were restored. No media was deleted. User data remained in the lab profiles.
- Helpers in E record actual app state and drive UI. The selection and media URL fault instrumentation
  is described explicitly. No source/build patch, fabricated transcript, or injected native take snapshot.
- The live-matrix helper's async predicate waits did not reliably synchronize renderer and native state;
  its intermediate labels can precede a DOM update. Conclusions use subsequent stable snapshots,
  screenshots, actual media state and repeated reproductions, not those labels alone.
- Default and diagnostic launches are recorded in `run1-app.log` through `run5-app.log`; action replies
  in `actions.jsonl`. No unit/build gates were run: this was a built-app hunt and documentation-only handoff.
- Private lab shutdown is recorded in `shutdown.txt`. Niri safety, physical devices, hotplug and long-run
  unrestricted performance remain outside this private KWin pass.
