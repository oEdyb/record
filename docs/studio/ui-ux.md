# Studio recording view — design handoff

Scope: research and design only, based on current source. No app launched, media played, source changed, clipboard used, or host input driven. Dimensions below are CSS pixels, excluding OS decorations. This document is the proposed behavior, not a claim of implemented support.

## Decision

Extend the paused HudClipPeek into a full-window confidence monitor. One large stage switches between **Live** and **Look back**. Transcript stays on the right. Recording controls stay fixed below the stage. During replay a separate, small **Live** self-view keeps the creator visible now; the camera composited into replay remains recorded footage. Never label recorded footage Live.

Two equally large video panes waste space at 1440×900 and make it unclear which camera is current. Use one dominant stage and one compact confidence view instead. While recording, Live is primary; while paused, Look back is primary. Do not add an editor timeline, waveform, AI tools, export controls, tagline, or dashboard cards.

## Layout and sizing

Use existing HUD surface, border, ink, muted, focus, fill and radius tokens. Scope their inherited values onto Studio; do not inherit hudAnchor positioning or overlay sizing observers. Linux uses a solid dark surface. Inherit the app font; keep HUD mono/tabular timing. Transcript uses existing 13.5px/1.5 text, 11px mono clip labels; permit text zoom. No enlarged marketing typography or new accent palette.

1920×1080: 16px outer padding, 12px column gap, 400px transcript; remaining 1476px main column. 44px top strip, 12px gaps, flexible stage, 44px replay transport when applicable, 56px recording transport. Stage fits available width AND height; contain footage with letterboxing, never crop it to fill. Center within its allocation. Live camera defaults to the existing composited placement, with private monitor sizing independent of output settings.

1440×900: same geometry, 340px sidebar, 1056px main column. Camera confidence inset during look-back: 192×108 nominal (240×135 on wide screens), clamped to 25% of stage width and never covering replay controls. Put it in a dedicated rail above the stage if it would overlap the recorded camera; do not silently move the output camera.

Below 1000px: stack stage and transcript. At 800×800 use 12px padding, 40px top strip, roughly 360px stage allocation, 44px replay transport, 56px recording bar, remaining height for independently scrolling transcript. Minimum intended window 640×600; stage may shrink to 180px high. All controls remain visible. Transcript header stays sticky inside its region. At increased text scaling allow vertical content scrolling above the fixed recording bar rather than clipping buttons. No horizontal page scroll.

### Recording, 1920×1080

```text
+---------------------------------------------------+------------------------+
| [Live] [Look back]                     [Pill ↙]     | Transcript [↻] [Copy]  |
|                                                   | Clip 1 · 0:00          |
|              LIVE SCREEN                          | Previous clip text…    |
|                                                   |                        |
|                            +----------------+     | Clip 2 · 1:24          |
|                            | LIVE CAMERA    |     | Previous clip text…    |
|                            +----------------+     |                        |
|                                                   | Clip 3 · Recording     |
|                                                   |                        |
| [Pause]  ● 02:31  [Stop] [Remove] [Replay] [Settings]|                        |
+---------------------------------------------------+------------------------+
```

No streaming words for the active clip. Previous transcript remains readable and stable. Look back can show already committed clips while recording continues; capture state stays visibly Recording. Replay is silent and paused on entry while recording. Offer explicit Play and volume; entering Live or resuming capture always stops replay audio, preventing unintended feedback. Never silently pause recording because someone reads or seeks.

### Paused between clips, 1440×900

```text
+-----------------------------------------------+----------------------+
| [Live] [Look back]                  [Pill ↙]   | Transcript [↻] [Copy]|
|                              [Live self-view] | Clip 1 · 0:00        |
|                                               | Text…                |
|         RECORDED SCREEN + RECORDED CAMERA      | Clip 2 · 1:24        |
|         [Clip 2 of 2]                 [Volume] | > selected sentence  |
|                                               | Text…                |
| [Play] [=======clip 1==|====clip 2===] 1:27/2:31 |                      |
| [Resume] Ⅱ 02:31 [Stop] [Remove] [Replay] [⚙]   |                      |
+-----------------------------------------------+----------------------+
```

Pause selects newest committed clip near its last five seconds, matching existing peek positioning, but holds the frame until Play. If user is already examining an earlier clip, retain their selection and show the new clip in the transcript without jumping. Resume returns to Live, freezes transcript reading position and stops replay. Selecting Live while paused shows a live monitor with an explicit Paused recording state; it does not resume capture.

### Narrow paused view, 800×800

```text
+--------------------------------------------------+
| [Live] [Look back]                     [Pill ↙]   |
| Recorded screen + recorded camera   [Live inset]  |
| [Clip 2 of 2]                                    |
| [Play] [======|==========]             1:27/2:31   |
|--------------------------------------------------|
| Transcript                            [↻] [Copy] |
| Clip 1 · 0:00                                    |
| Text…                independently scrolls       |
| Clip 2 · 1:24                                    |
|--------------------------------------------------|
| [Resume] Ⅱ 02:31 [Stop] [Remove] [Replay] [⚙]      |
+--------------------------------------------------+
```

## State behavior

Capture state, stage selection, clip readiness and transcription are independent. Transcription never disables recording controls.

- **Recording/live:** Live stage; active clip section says Recording. Timer advances using the pill's presentation value. Prior committed clips remain selectable. Camera off means no camera placeholder consuming the stage; unavailable camera uses the existing unavailable treatment.
- **Paused:** frozen timer, Resume primary, replay ready. Keep live self-view visible during look-back unless camera monitor is hidden by the existing preference. Do not change output camera settings when toggling this private monitor.
- **Finalizing clip:** retain prior replay/frame; reserve new section headed Clip n with “Saving clip…”. New clip is not seekable until its file commits. Pause/Resume has existing busy ring and disabled predicate. Stop/remove follow the exact existing controller predicates. Do not invent a percentage.
- **Transcribing:** committed video immediately playable. Section says “Transcribing clip n…”; queued clips say “Waiting to transcribe”. On text arrival replace only that section, without a shimmer, typewriter effect or stage resize. If current backend reports blocked during capture, say “Transcription resumes when paused”; do not falsely claim active work.
- **Error:** retain completed text; local “Couldn't transcribe this clip” and Try again. Session error goes in the sidebar status slot, not a blocking modal. Retry uses supported refresh behavior; don't imply per-clip retry if the API retries the session.
- **Model missing/downloading:** “Download transcription model” action, then existing MB progress string. Recording and replay work throughout. Show actual backend status; no automatic claim that a model is installed. Download failure preserves retry and existing text.
- **Zero committed clips:** Live selected; Look back/Replay disabled. Sidebar “Your transcript appears after you pause.” During first clip show Clip 1 · Recording. During first finalization keep live screen with Saving clip… in sidebar; never render an empty black replay.
- **After Stop:** disable duplicate transport actions, show existing saving state until committed. Keep last stage and transcript visible during handoff. Then use the existing review/editor handoff, retaining take identity and available transcript; never leave an active-looking Resume button. If handoff fails show “Couldn't open recording” + Try again and retain saved content.

```text
FINALIZING / TRANSCRIBING                ZERO CLIPS
+------------------+----------------+   +------------------+----------------+
| Previous replay  | Clip n         |   | Live + camera    | Clip 1         |
| or live monitor  | Saving clip…   |   |                  | Recording      |
|                  | then           |   |                  | Transcript     |
|                  | Transcribing… |   |                  | after pause    |
| [busy Resume] [Stop per predicate]|   | [Pause] 00:12 [Stop]              |
+------------------+----------------+   +------------------+----------------+

STOP / HANDOFF                          TRANSCRIPT ERROR
+------------------+----------------+   +------------------+----------------+
| Retained frame   | Retained text  |   | Replay works     | Clip n         |
|                  | pending status |   |                  | Couldn't       |
| Saving recording…                 |   |                  | transcribe     |
| then existing review              |   | [Resume] [Stop]  | [Try again]    |
+------------------+----------------+   +------------------+----------------+
```

## Transcript behavior

Use one chronological section per stable clip ID/index. Header follows existing “Clip n · m:ss”: timestamp is the cumulative kept-take start, not wall clock. Preserve original clip numbers after removal; replay “Clip x of y” is the kept ordinal. Keep these two concepts explicit in accessible labels. Active recording section gets a small recording dot and Recording text. Selected replay section gets a subtle HUD fill and leading focus-colored rule; playing sentence gets a restrained background, never animated word bouncing.

Sentence click selects Look back, loads its clip and seeks to its clip-relative start; keep playback paused unless already deliberately playing while paused. Word click seeks only with real word timestamps. Existing TranscriptWindow snapshot visibly exposes plain clip text, duration and errors; timestamp granularity must be confirmed/added by implementation. With clip-only data, expose a clip-header “Play from clip start” action and selectable plain text. Never estimate word times by dividing duration. Account for removed clips in cumulative offsets; webcam sync continues using webcamOffsetMs.

Keep text selectable. Do not make every word a tab stop. Prefer sentence-level keyboard actions when timestamps exist, with accessible “Seek to Clip 2, 1 minute 28 seconds” labels. Dragging text selection must not seek. A transcript seek must not restart transcription or change capture state.

Follow latest only when the reader was within 48px of the bottom, has no selection and no keyboard focus inside older text. Wheel/touch/keyboard movement away suspends following immediately. Completion above the viewport preserves the visible anchor and offset. Show a small “Latest clip” button when new content arrives offscreen; activating it restores follow. Playback highlighting does not scroll unless Follow playback is explicitly enabled. No automatic scrolling while talking merely because timer updates. Announce completed clips once using a polite status region; never announce every word or second.

Copy uses existing Copy/Copied feedback (1600ms), plain paragraphs in kept order; excludes pending/error placeholders and removed clips. Disable with no completed text. Refresh retains existing global busy gating. Removed clips disappear from transcript, copy and seek immediately with the same session removal event; no new undo or trash workflow. If selected clip is removed, select the preceding kept clip at its end, or Live if none. Ignore late transcription results for removed clips; preserve scroll anchor. Removal label must say last clip even when replay selection is older.

## Pill ↔ Studio

Add a dedicated 36px HUD icon button using lucide Maximize2 at 18px, tooltip/accessible name “Open recording Studio”. Normal recording pill: after Replay, before Settings. Top-docked pill: left wing remains Pause/Remove/Replay; right wing becomes Studio/Settings/Stop. Extend the pill's measured geometry; do not shrink hit targets. This is separate from existing openStudio/Clapperboard “Recordings” library navigation, which already exists in setup. Do not accidentally route an in-progress take into the library.

Studio top-right: lucide Minimize2, accessible name “Switch to recording pill”; tooltip includes shortcut. Window close returns to pill during a take; it never stops or discards. Normal minimize remains OS minimize. Proposed configurable accelerator Ctrl+Shift+Y on Linux, Cmd+Shift+Y on macOS; check shortcut registry conflicts and compositor registration before assigning. Route both windows to one command; ignore key repeat and handle failed global registration in existing shortcut settings. Existing capture shortcuts remain unchanged. Escape first closes settings/popovers; otherwise returns Studio to pill. Do not retain HudClipPeek's global ArrowDown-to-close behavior in Studio.

Only one recording control surface is visible/interactive: hide pill after Studio is ready; restore pill before hiding Studio. Restore dock side, tuck state and position. During switch capture, timer, camera and transcript jobs continue. Preserve replay position, transcript scroll and selected mode. Hide separate floating transcript/camera windows while their equivalent is visible in Studio, preserving their preferences for return.

No geometric morph from tiny pill to full window. Mouse opening may fade Studio content in over 140ms with cubic-bezier(0.23,1,0.32,1); no width/height animation or reflow. Keyboard switches and reduced-motion switches are instant. Window readiness must precede hiding the previous surface. Focus the corresponding transport control on entry and the Studio opener on return; switching must not steal focus again when transcription completes.

## Recording transport

Reuse HudCompactPauseButton, HudCompactTimer, HudStopButton, HudRemovePreviousClipButton and HudSettingsButton, preserving handlers, confirmation flows, busy flags and disabled predicates from LaunchWindow. Fixed order Pause/Resume, timer, Stop, Remove last clip, Replay, Settings. Replay focuses/selects Look back; capture Pause and replay Pause are distinctly labeled. Timer represents the same take elapsed time as pill, never playback time; replay transport owns its separate current/total display. No second recorder state machine. Settings retain recording-time locks; selecting a preview mode cannot change recording source or camera placement.

## Capture safety, quietness and accessibility

Architecture owns actual capture exclusion. Studio cannot claim exclusion from Electron content protection alone on Linux. If backend reports Studio intersects the recorded display and exclusion is unavailable/unverified, show one compact persistent warning above stage: “Studio may appear in your recording” with “Switch to pill”. If known included, say “Studio is on the recorded screen”. Preserve active capture; do not move windows or switch source automatically. If capture preview would recursively show Studio, suppress the recursive live screen preview and retain live self-view plus warning. Do not show a reassuring Protected badge without verified capability.

Avoid live transcript animation, flashing recording indicators, idle autoplay, waveform decoration, notifications over the face, and continuous moving status text. Reserve status space so text completion never pushes recording controls. Native window is resizable, not forced fullscreen or always-on-top. Never restart a camera stream simply to switch views if a shared relay exists.

Use a main region, named Live/Look back tablist, labeled replay slider, named transcript region and ordinary toolbar semantics. Visible focus ring uses --hud-focus. Match existing 36px secondary / 40px primary controls; provide at least 24px targets with spacing for text seek actions. Aim for 4.5:1 text and 3:1 control/focus contrast, checking actual rendered token combinations rather than assuming muted text passes. Disabled is never the sole explanation for unavailable transcript. Focus stays stable on new clips; restore it predictably after removal. No focus trap on the main window. Sliders consume arrow/Home/End keys before window shortcuts; input selection must not trigger replay shortcuts. Keep all drag regions separate from controls and selectable text.

## Component and CSS handoff

- **RecordingStudioWindow**: full-window shell; consumes shared session presentation/commands. New module scoped classes studioRoot, studioHeader, studioBody, studioMain, studioTransport, studioCaptureWarning. Reuse review shell's full-height containment and toolbar spacing, not its editing actions or AmbientBackdrop.
- **StudioStage**: Live/Look back selection, contained stage and live confidence inset. Classes studioModeTabs, studioStageSlot, studioLiveStage, studioConfidence, studioStageStatus. Reuse clipPeekStage, clipPeekVideo, clipPeekCamera, clipPeekLabel and peekCameraStyle; use camera relay logic from CameraPreviewWindow without mounting that entire window component. Distinguish preview-only geometry from saved composite layout.
- **StudioReplay**: extract/share a presentation and playback layer from HudClipPeek; use buildPeekTimeline, locatePeekTime, preview audio store, local media URLs, webcam offset sync, volume/seek/error UI. Classes studioReplay, studioReplayTransport. Override small popup width/max-height/position and dialog semantics; do not copy HudClipPeek's open effect (autoplays, seeks on total changes, steals focus) into Studio. It needs controlled clip selection, seek request, autoplay policy and scoped keys. clipPeekTrack/Segment/SegmentFill/Time/Play/Volume remain visual sources.
- **StudioRecordingControls**: compose exact HudControls transports and shared controller predicates. studioTransport is a stable-height row, never a drag handle. Recording and replay transports must not reuse duplicate DOM IDs/test IDs in one window.
- **StudioTranscript**: extract/share transcript snapshot subscription and status formatting from TranscriptWindow, leaving floating-window close/drag behavior there. Reuse transcript-body, transcript-clip-label, transcript-clip-text, transcript-control, transcript-status; scope standalone h-screen/w-screen utility classes out. New classes studioTranscript, studioTranscriptHeader, studioTranscriptSection, studioTranscriptSectionActive, studioTranscriptSentence, studioTranscriptSentenceActive, studioTranscriptLatest, studioTranscriptPlaceholder. Use HUD tokens rather than creating another palette.
- **HudStudioButton**: new reusable HUD button matching existing icon styles, Maximize2/Minimize2, distinct labels and test IDs. No new HudIcons path needed; lucide already supplies the matching glyphs.
- **i18n**: reuse launch.transcript.*, existing pause/resume/stop/replay/settings labels and loading/error tone. Add recording-specific Studio switch labels, Live, Look back, Latest clip, Saving clip, queued/active clip status and capture warning in all supported locales. Keep existing tooltips.openStudio/library meaning separate.

## Review checklist for implementation agent

Verify actual media and timing later, outside this design task: switch in both directions while capturing; pause/finalize/resume rapidly; read an old transcript while a new one completes; seek across removed clips; absent word timings; zero clips; camera disabled/unavailable; recording audio never plays automatically; model download/error; Stop handoff failure; narrow window and 200% text; keyboard-only and reduced motion; Studio exclusion on the actual Linux compositor/capture backend. No build or runtime verification was performed for this document.
