# AGENTS.md — Klippt product and engineering guide

This repository is the private working copy for **Klippt**, currently hosted at the legacy
repository `github.com/oEdyb/record`. Klippt is a normal, high-quality screen recorder and editor with
clip-native recording built into the core workflow. It starts from the MIT-licensed OpenScreen
continuation, but it is a separate, proprietary commercial product.

`Klippt` is the selected product name. `.klippt` is the canonical project extension. Keep reading
legacy `.openscreen` and `.axcut` projects, copy them forward after validation, and do not delete the
legacy files during migration. Keep the current `oEdyb/record` repository name and legacy OpenScreen
bundle IDs, helper names, environment variables, and user-data location stable until a separate
migration includes permissions, compatibility, packaging, and rollback. Do not perform a blind
global rename.

Read this file before changing product behavior, UI, recording, project storage, preview,
or export. Preserve these decisions across context compaction and future agent sessions.

Use [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md) for delivery order and release gates. This file remains
the source of truth for product behavior and engineering constraints.

## Product goal

Build a recorder with Screen Studio-level refinement and a faster speaking workflow:

1. From the editor, use the normal Record action to enter the recording workspace at the
   current insertion boundary.
2. The editor gets out of the way and the floating panel appears idle. Set up the
   screen/window, microphone, system audio, camera, and cursor there.
3. Start recording from the floating panel.
4. Pause whenever a spoken section ends.
5. While paused, optionally change the source, microphone, system audio, camera, or cursor
   setup for the next clip.
6. Continue into a new clip. Reuse the current capture pipeline when settings did not
   change; safely reconfigure it when they did.
7. Remove the previous completed clip immediately with Backspace when it was bad.
8. Stop to return to the editor.
9. Review, remove, reorder, and insert clips with normal editor actions.
10. Move between Edit and Record as often as needed.
11. Export one normal MP4.

The product must feel like a normal recording app. Clip-native recording is built in; it is
not a separate mode or an advanced workflow.

## Agent-native product model

Klippt must be excellent to use through both the UI and coding agents. The CLI and future local
agent bridge operate on the same versioned project document and the same typed editing commands as
the UI. Do not create an agent-only timeline, duplicate editing logic, or let agents rewrite project
JSON directly.

Machine-facing commands must return stable IDs and structured JSON. Every write must support a
clear dry run, require the expected project revision, save atomically, and create one normal Undo
step. Agent edits preserve source media and follow the same recovery, ownership, and history rules
as UI edits. An agent can remove a clip from the edit, but it cannot silently delete recorded media.

The complete target command surface includes project inspection, media health, Split, Remove,
Restore, reorder, trim, insertion, layout, Screen Zoom, Camera Emphasis, audio settings, automatic
direction, validation, and export. Keep the transport thin. A future MCP or JSON-RPC adapter must
call the shared command service instead of owning product behavior.

## Product language — non-negotiable

- Call recorded sections **clips**.
- Use normal words such as **Record**, **Pause**, **Continue**, **Stop**, **Remove previous
  clip**, **Split**, and **Undo**.
- Never call clips “takes”.
- Never add a “redo take”, “replacement take”, “candidate”, “pickup”, “record here”,
  “keep”, or “retry” workflow.
- To record something again, the user removes the clip, leaves the insertion cursor at that
  position, and uses the same normal Record action.

## Current delivery target: first working version

The first version is a bare Mac-first vertical slice. It is working only when this complete
path works with real capture:

1. The user selects a real screen/window and audio settings.
2. Record starts after the countdown.
3. The active two-row floating panel appears.
4. Pause finalizes the current clip without stopping ScreenCaptureKit when settings stay
   unchanged.
5. Paused setup changes apply to the next clip without ending the logical recording.
6. Continue starts a new clip. It does not ask for setup again unless the user opened a
   source picker while paused.
7. Pause and Continue can repeat several times.
8. Backspace removes the newest completed clip; repeated presses can remove all completed
   clips.
9. Stop finalizes the active clip, ends capture, hides the panel, and opens one project in
   the editor.
10. Every kept clip appears in order with a visible cut boundary and plays continuously.
11. Export produces a normal MP4.

Keep this slice minimal. Do not block it on captions, transcript, paused playback,
thumbnails, waveforms, automatic zoom, AI editing, Windows, Linux, broad rebranding, or a
large library redesign.

## Recording model

Do not invent a video format.

- Keep one live ScreenCaptureKit `SCStream` for the recording session.
- Each Pause finalizes one standard fragmented H.264/AAC MP4 clip.
- Continue creates a fresh `AVAssetWriter` and starts it on the first valid sample.
- Store clip order and state in a versioned JSON project document.
- Stop finalizes the active writer, closes capture, and opens the project.
- Export composes kept clips into one standard MP4.
- Backspace changes project state immediately. Keep removed media until normal cleanup so
  Undo and crash recovery remain possible.

Pause by itself must not restart source selection, ScreenCaptureKit, or permissions. If the
user changes capture setup while paused, reconfigure or restart only the capture parts that
must change before Continue. Keep all completed clips in the same logical recording. Pause
must not wait for transcription, thumbnail generation, waveforms, proxy creation, cleanup,
concat, remux, or re-encoding.

Treat the final countdown value as the recording-start barrier. Start the capture pipeline
while `1` is still visible, keep `1` visible until the recorder confirms its real first frame,
paint the HUD timer, and only then hide the countdown overlay. Never hide the countdown and
initialize capture afterward; that creates a dead gap where neither countdown nor timer is
visible.

Target local-SSD Pause finalization at p95 below 300 ms on this Mac. Show Pause feedback
immediately. If `AVAssetWriter.finishWriting` is still running, show a quiet saving state and
disable Continue until the clip is safe.

## Pause, Continue, Stop, and Backspace

- **Pause** finalizes the active clip and stays in the recording session.
- **Continue** starts the next clip after a short countdown.
- **Stop** is different from Pause. Stop ends capture and opens the editor. The Record circle
  changes into a clear Stop square while recording. Keep it icon-only; do not add permanent
  `Stop` or `Stop Recording` text. The tooltip and accessibility label explain the action.
- **Backspace** removes the newest completed clip immediately.
- Backspace has no confirmation dialog and no removal mode.
- Repeated Backspace presses continue backward, including removing every completed clip.
- Disable Backspace when no completed clip remains.
- Use the tooltip and accessibility label `Remove previous clip`.
- Do not implement whole-recording Restart as the normal recovery action.

## Floating recording panel

Editing and recording are two states of the same project. They are not top-level tabs. Remove
the editor's Record tab instead of treating setup as another inspector page.

The editor's normal Record action saves the current insertion boundary, moves the editor out
of the way, and shows the floating panel at the bottom center. The panel starts idle. Source,
microphone, system-audio, camera, device, and cursor controls are available, but the timer does
not run and no media file exists. Only the panel's Record circle starts the countdown and real
capture. Closing the idle panel or pressing Escape returns to the editor without changing the
project. Stop during capture returns to the same project and inserts the kept clips at the saved
boundary.

Use a quick, restrained transition between the workspaces. Preserve timeline selection,
insertion boundary, preview time, inspector state, and window geometry. Do not show a setup
page, dashboard, mode chooser, or navigation stack between Edit and Record.

Keep OpenScreen's existing floating bar as the first row during recording. Add clip history
as a second row inside the same surface. The rows share one background, border, radius,
shadow, and material. Do not replace the first row or create a detached timeline pill.

The current real Mac render is approximately 829 CSS px wide and 84 px tall on a
1710 px-wide work area. Preserve the familiar setup-to-recording transition. If future
display or accessibility testing needs a compact layout, adapt this same surface instead of
switching to a different recording panel.

### First row

- Keep OpenScreen's source, system-audio, microphone, camera, cursor, tray-orientation,
  notes, language, minimize, and close controls in their existing positions.
- Lock setup controls while a clip is actively recording or finalizing.
- Unlock source, system-audio, microphone, camera, device, and cursor controls after Pause.
  A paused change applies to the next clip and must never rewrite a completed clip.
- Do not enable a paused control until its change reaches the real capture pipeline. A local
  UI toggle that the next clip ignores is a recording bug.
- Keep OpenScreen's primary Stop button and live timer.
- Add Backspace beside Pause/Continue.
- Keep the separate drag handle and the existing window-control behavior.

### Lower row

Show a read-only live clip-history strip.

- One small rounded segment represents each kept clip.
- Segment width uses one linear duration scale, with a minimum visible width.
- The active segment grows while recording.
- Completed clips are quiet; the newest completed clip has priority; the active clip uses
  the semantic recording color.
- Keep the newest six to eight clips visible.
- When history is longer, compress old clips first and collapse the oldest into `+N`.
- Keep the newest clip fully visible.
- Backspace removes the newest segment with a short 140–180 ms collapse.
- Respect Reduce Motion by changing state without movement.
- The strip is not clickable, selectable, draggable, scrubbable, or editable.
- VoiceOver gets one combined history value. Do not expose every decorative segment as a
  focus stop.

Do **not** show a clip-count label. The segments already communicate clip count. Do not show
text such as `6 clips`. The main timer already communicates duration, so the lower row can
remain a clean visual history rather than a second status readout.

Keep the lower row present whenever the horizontal recording panel is visible, including the
idle state before capture. Show an empty rail while idle. Fill the first active segment without
changing the panel's outer geometry. Keep that same geometry in active, finalizing, paused,
empty-history, and many-clip states.

The HUD uses a native transparent backing window that is much larger than the painted panel so
menus can open without resizing the window. On macOS, make that window click-through before its
first visible frame. Forward pointer movement and enable mouse input only over painted HUD
surfaces. Never leave a startup gap where the invisible backing window can swallow a click meant
for another app. Keep the delayed renderer-driven startup on Windows because Electron implements
forwarded mouse movement there with a global low-level hook.

Pause must keep the transport geometry stable. Clip finalization must not replace the Stop
button or timer with a Saving label, and the Pause/Continue control must stay mounted in one
slot while it is temporarily disabled. Morph the active history segment into the finalized
clip in place, with no empty frame or node replacement, so its color and glow can ease from
active to completed.

### Camera confidence monitor

- Keep the camera monitor as a separate preview-only window. Its position and shape never set
  the recorded camera's editor layout.
- Keep it always on top but non-focusable. Show it without activating OpenScreen so it does not
  steal keyboard focus from the app underneath. Its own small surface remains draggable.
- Reuse the recorder-owned camera stream. Never open a second camera session for the monitor.
- Relay one backpressured 576 × 324 Retina frame at no more than 24 FPS. Use high-quality
  downsampling and GPU bitmap transfer. The monitor must not change the selected recording
  resolution or FPS.
- Request a new renderer-to-renderer connection after either preview side mounts or reloads.
  The monitor must not remain on Loading after a renderer reload.
- Keep the monitor and its cursor activity out of display capture and automatic direction.

The timer is the total duration of kept completed clips plus the current active clip. It
must decrease immediately after Backspace. If Backspace removes every clip, the timer must
return to `00:00` before Continue starts a new clip.

Removed sections must not appear in editor video or camera playback. Camera media can stay
continuous during capture, so import each kept clip with the camera offset for its physical
capture start, including the durations of earlier removed clips. Change the in-memory clip
state before awaiting manifest persistence so a simultaneous Stop cannot import stale
removal state.

Persist normal recording setup as app preferences. Restore microphone enabled state and
device, camera enabled state and device, system-audio enabled state, and cursor mode after a
full app relaunch. Validate stored device IDs against current hardware and fall back safely
if a device disappeared. These preferences are not project content.

## Editor behavior

- Stop opens the editor and its preview. The recording panel does not contain playback.
- Do not show a top-level Record tab. The editor and recording workspace are two states of
  the same project, reached through the normal Record action and Stop or Cancel.
- Every Pause becomes a visible cut boundary between adjacent clips.
- Adjacent clips play without an artificial gap.
- The editor has one normal Record action and keybind.
- The timeline has an insertion cursor between clips.
- Record inserts new clips at the selected boundary and moves later clips forward.
- Record first opens the idle floating panel. It must not begin the countdown or capture.
- Removing a clip leaves the insertion cursor at the removed clip's former position.
- Remove a selected clip with Delete or Backspace. Do not put a trash button inside clip
  cards.
- Show the resolved insertion boundary as one quiet, read-only capsule centered in the
  visible gutter between clip cards. Do not add a plus icon, insertion mode, separate tool,
  or extra panel.
- Treat one recording import as one document edit. Its Undo snapshot includes the imported
  assets, clips, camera offsets, shifted later clips, and edits attached to those clips.
- `Command-Z` restores a removal or reverses an insertion or reorder.
  `Shift-Command-Z` and `Command-Y` redo it. Keep `Command-C` for Copy.
- Recording inside a clip requires Split first.
- Save every editor control in the project. Also remember the last committed reusable controls
  as defaults for the next project: background, output shape, effects, padding, webcam layout,
  webcam presentation, cursor presentation, and automatic focus. Validate the versioned preference
  record before use. Keep a custom uploaded background in its project. Do not put its full data URL
  in browser preference storage; retain the previous reusable color, gradient, or built-in image as
  the next-project default. Do not carry source-specific crops, clips, cuts, zoom regions, caption
  text or translation, or other timeline content into a new project.
- Let picture-in-picture camera size range from 10% to 80% of the canvas reference dimension.
  Keep the range constants shared by the slider, project validation, reusable preferences,
  preview, and export so a saved large camera cannot shrink after reopening.

Version 1 does not show transcript, tail playback, thumbnails, or a review surface in the
paused panel. If real use later proves that Stop → editor → Record is too disruptive, test a
small last-clip review feature then. Do not build it before that evidence exists.

## Pause shortening

- Put pause shortening in one right-side **Pauses** pane. Do not hide it in Automatic direction,
  captions, or the recording HUD.
- Call the action **Shorten Pauses**. Do not promise destructive “silence removal.”
- Analyze cached source observations without changing the project. Show temporary candidates over
  the clip waveform. Let the user preview, select, clear, and apply them.
- Confirmed candidates become ordinary clip-anchored `trimRanges`. Apply one selected batch through
  the retryable document-patch path as one normal Undo step. Do not add a silence-only timeline,
  rendered media, split clip, or permanent analysis lane.
- Speech mode uses the verified sub-megabyte Silero v6.2 model as its primary isolated-microphone
  signal. Run it through the existing whisper.cpp helper without loading the 264 MB caption model;
  cache its 32 ms probability envelope by immutable source identity. Use isolated-microphone energy
  and local word timing as extra protection. Speech mode can work without a transcript, but it must
  not silently fall back when Silero or the isolated microphone is missing.
- Audio-level mode is the explicit no-model fallback. It can use adaptive level or a manual dB
  threshold and can disclose when an older file requires the mixed audio track.
- Protect isolated system audio and meaningful screen activity by default. Click, mouse-up, drag,
  keyboard timing, and pointer travel above jitter are hard cut blockers. Private input contributes
  timing only and never geometry.
- Keep all pacing and detector values in the typed `PauseAnalysisPolicy`. Presets and live tuning
  must use that policy instead of adding literals to the pane.
- Use the lightweight capped envelope for the visible waveform and a disk-cached 20 ms envelope for
  cut analysis. Keep source media unchanged. Render structural boundaries with the shared 10 ms
  equal-power audio fade.

## Automatic direction

Automatic direction is a normal editor enhancement. It is not an AI mode and does not add a
second timeline model.

- Keep one pipeline: recorded observations → small intent detectors → one versioned automatic-
  direction plan → ordinary timeline regions. `automatic-direction.ts` owns cross-effect planning;
  click, drag, typing, trace, microphone, and future detectors must not write project regions on
  their own.
- Keep every analyzer threshold, duration, density limit, and handoff rule in the nested typed
  `AutomaticDirectionPolicy`. The right-side **Automatic** pane and its versioned presets pass
  validated overrides through that policy tree. They must not fork the analyzer or add tuning
  literals to UI components. Cache raw recording observations during one tuning session, replan
  after a short debounce, and keep the session to one Undo action.
- Default project Max Zoom to 1.65×, but let the user expand the automatic depth profile up to the
  shared 5× renderer limit. A higher request must not raise the planner's minimum acceptable safe
  scale. Cursor safety can reduce or omit a crop. Do not expose safety-solver sampling or search
  values as creative settings.
- Plan screen direction first and let Camera Emphasis fill compatible quiet time under the shared
  direction budget. Give every planned effect a stable identity, then convert the plan into normal
  clip-anchored regions. A repeated application of the same plan must be idempotent.
- Apply a late asynchronous enhancement through the retryable project document-patch path. Rebuild
  the patch from the newest document after a concurrent edit, coalesce it into the existing import
  history, and report a real conflict. Never use a fire-and-forget stale document save or silently
  drop a valid automatic result.
- A click-only detector chain can still split at six seconds. If nearby chains form one visual
  passage, keep that split internal. Plan the complete passage before writing Zoom regions. Within
  the useful stable-scale range, choose the fewest safe focus changes first and the deepest scale
  among equally simple plans. Hold the current framing when it still contains the next target. Pan
  at one stable scale only when the target leaves. Lower the passage scale only when no safe focus
  path exists at a useful deeper scale. Internal detector boundaries must never create a visible
  scale pulse, redundant timeline item, or full-frame exit.
- Treat a qualified drag as one bounded visual activity. Frame its complete press/path/release area
  with one stable crop when possible. Center that crop on the complete drag bounds instead of the
  press point, and reduce depth when needed to keep the full bounds visible. Pan only when no useful
  centered crop can contain the drag and the surrounding passage. A mouse release supplies the final
  bound; it does not create another score.
- After Stop, use the cursor sidecars that recording already produced. Do not analyze or
  re-encode video before the editor opens.
- Mark cursor samples over every visible private recorder surface, including the HUD, webcam
  confidence monitor, and Notes, as excluded direction input. Those surfaces are absent from
  captured pixels, so their clicks, drags, and movement must never create or strengthen a screen
  zoom. Exclusion ignores that input; it does not force a full-frame gap. Separately qualified
  content intent before and after an excluded interval can use the normal smooth handoff. On macOS
  display capture, exclude the complete OpenScreen process through ScreenCaptureKit so private
  windows created after capture starts stay absent too.
- Start with deterministic local signals: click groups and deliberate cursor traces that
  settle. A passive cursor dwell is not intent and must not create a zoom by itself.
- Preserve left-button press and release as separate input events. A normal release must not
  create a second zoom target. Use the press-to-release interval only to recognize a real drag;
  a qualified drag can keep its source and destination visible or direct one connected pan.
- Treat sustained typing in an editable element as screen intent. Record only local event times,
  burst counts, and the focused editable element or caret bounds. Never record key codes,
  characters, clipboard data, shortcuts, field values, or typed text. Ignore secure text fields
  and fail closed when the focused target cannot be resolved safely. Classify recorder-owned
  keyboard focus by the focused Accessibility process, not by whether a broad target-center
  fallback happens to sit underneath the HUD or camera monitor.
- When typing follows a click into the same target, extend or hold the existing screen zoom instead
  of adding another zoom-out and zoom-in. When a clear typing burst starts without a nearby click,
  it can create one normal editable auto Zoom region around the focused writing area. A parked
  pointer must not pull that framing away from the text. Typing must also count as screen activity
  when Camera Emphasis is selected.
- Treat uninterrupted same-target typing as one renewable activity with one direction score. Each
  accepted key event renews the activity, with no maximum visible duration. End it only after the
  typed-policy idle gap, a real target change, an excluded/private interval, or a clip boundary.
  The idle gap means no accepted keyboard events; microphone silence is unrelated. The six-second
  click-chain safeguard applies only to click-only chains. Internal checkpoints must not create a
  visible exit, a second timeline item, or another score. A nearby content click after typing can
  receive a direct connected handoff instead of forcing full frame first.
- Keep each renewable typing chain indivisible, but do not let one typing chain flatten unrelated
  neighboring chains into one shallow crop. If a later connected handoff would crop the real
  pointer, preserve the safe typing crop and create the smallest full-frame disconnect around that
  handoff instead of lowering the complete passage.
- Resolve typing position from a trustworthy Accessibility caret rectangle first. If the target
  exposes only broad bounds, use the latest recent content click only when it lies inside that same
  focused editable target. Use the center only for a compact target whose bounds are precise enough.
  If none of those positions is trustworthy, omit the automatic typing Zoom. Once a connected Zoom
  reaches its next typing position, keep full scale and pan without restarting the incoming
  region's entrance animation.
- Keep typing qualification, minimum activity, idle-gap, target confidence, and framing values in a
  typed policy. Use a passive low-cost event counter during capture and do target lookup at a
  bounded rate so keyboard direction cannot make recording or other apps lag.
- After a content click, observe a short bounded attention window. Fit one padded crop around the
  click and the positions where the cursor then spends time. Ignore isolated fly-by samples. Keep
  a separate later click from being absorbed into the first crop. If the cursor quickly relocates
  to a distant place and parks there, end the click observation instead of widening or suppressing
  the click zoom. If the remaining useful activity is too wide for a readable zoom, use no
  automatic zoom.
- Rank all candidate moments together. Prefer precision over recall and keep a global motion
  budget near four zooms per minute. Do not add an effect for every click.
- Vary focus, duration, and scale with the interaction. Do not apply one fixed zoom to every
  generated region.
- Store every result as an ordinary clip-anchored zoom region with `source: "auto"`. The user
  can resize, move, focus, copy, delete, Undo, and Redo it with the normal editor actions.
- Show every ordinary Zoom and Camera Emphasis region directly on the timeline. Do not replace
  real regions with an **Automatic direction** summary pill. Keep `directionGroupId` as internal
  ownership and regeneration metadata. Render only effect lanes that contain regions, and keep
  Zoom closest to the clip row.
- Never overwrite manual regions. Existing zoom regions reserve their timeline spans.
- Apply automatic-zoom spacing, occupancy, and density in trim-compressed playback time. Store the
  accepted regions on the raw timeline so normal editing and clip anchors remain authoritative.
- Use one deterministic motion function in TypeScript preview and native export. Smooth is the
  normal zero-bounce S-curve. Snappy preserves the faster Screen Studio-style ease. Linear moves
  at constant speed. Instant uses a hold boundary with no transition. Screen zoom and camera
  regions choose and persist their motion styles independently, so a camera can switch instantly
  while the screen still moves smoothly. Keep the normal UI to these intent-level names. Do not
  expose raw Bézier coordinates.
- Let each screen zoom and camera region also choose one compact transition-speed multiplier:
  0.5×, 0.75×, 1×, 1.25×, 1.5×, or 2×. New regions start at 1×. Apply the same validated value to
  entry, exit, and connected screen pans in TypeScript preview and native export. Disable the speed
  control for Instant because a cut has no transition duration. Keep this as a small selected-region
  control, not a new global settings panel.
- Keep automatic-direction thresholds and effect timing in typed policy objects. Motion style is
  a presentation setting on the ordinary region, not an analyzer threshold. A later Advanced
  Auto-Editing section can pass validated project overrides into the same policies; it must not
  require a second analyzer or scatter tuning constants through UI components.
- Let automatic screen zooms breathe. The initial policy uses a 3.0-second preferred duration,
  a 2.7-second minimum, and a 6.0-second maximum, with up to 4.5 seconds of post-click attention.
  Measure spacing as the visible quiet gap between effects, not the distance between their
  centers, so longer zooms do not create a rapid out-and-in pulse. Do not leave a rejection-only
  timing range between connected and separate effects: by default, a valid effect either connects
  inside the renderer's pan window or remains as a separate effect after that window.
- Add speech activity, screen readability, and camera activity as new observation signals in
  the direction engine. Do not replace the deterministic engine with an LLM.
- Automatic camera emphasis uses the isolated microphone track, a quiet cursor, and an active
  camera track. It does not depend on STT. Require 2.5 seconds of sustained microphone activity,
  1.5 seconds without cursor activity, at least 3.5 seconds of useful emphasis, no overlap with
  a screen zoom, and a sparse limit of two camera regions per minute. Apply all density and
  spacing limits in trim-compressed playback time, while stored regions stay on the raw timeline.
- Camera analysis runs after recording, so the 2.5-second speech requirement is a confidence
  window, not a visible delay. After speech qualifies, anchor Camera Emphasis at the detected
  speech onset. Add up to 250 ms of quiet lead-in so the camera starts moving into place before
  the first spoken sound. Never extend that lead-in across cursor activity.
- Keep the full camera-to-camera spacing after Camera Emphasis. A screen-to-camera return has its
  own short typed gap because cursor quiet already proves that screen activity stopped. Let a later,
  non-overlapping screen zoom take focus sooner when the screen becomes active; that camera-to-screen
  change is an intentional handoff, not repeated motion.
- Store camera emphasis as a normal clip-anchored camera-layout region with `mode: "emphasis"`,
  `source: "auto"`, and a default 1.35× camera scale. Never generate automatic full-screen
  camera regions. Show it in the camera effect lane immediately above the clip lane. Preview and
  native export must use the same smooth contained motion envelope.

## Technical-content quality and export

Olle records terminals, code, and other interfaces with small text. Preserve fine text as a
product requirement, not as an optional maximum-quality mode.

- On Retina Macs, capture the best available backing-pixel resolution. Do not silently record
  the logical point size. Use ScreenCaptureKit's pixel scale and best-resolution controls, with
  an explicit lower-resolution option only when the user chooses speed or smaller files.
- Output shape and output resolution are separate controls in the right-side **Layout** pane.
  The editor defaults to a padded 16:9 canvas and offers 16:9, 9:16, 1:1, 4:3, 4:5, 16:10,
  10:16, original shapes, and an encoder-safe custom width and height from 256 to 7680 pixels.
  Custom pixels define the editable project canvas; **Highest** export uses them while lower
  quality presets can render smaller delivery files. Preview, native scene, GUI export, and CLI
  export must resolve the same canvas. Preserve the selected background and padding without
  stretching the captured screen. Do not add a second aspect-ratio control to the timeline.
- For Dual Frame and Vertical Stack, let the user put the screen or camera first. Store that
  choice as project data and reusable editor defaults. Keep source tracks unchanged.
- Vertical Stack divides the complete padded canvas into cover-cropped screen and camera cells.
  Default to an equal split, and let the user set the camera share from 20% to 80%. Preview,
  native export, CLI export, saved projects, and remembered editor defaults must use one value.
- Export must offer real control over resolution, frame rate, codec, and bitrate. A quality
  preset must pass its resolved bitrate to the native encoder; do not calculate a value in the
  UI and then let the native pipeline replace it with a hidden fixed bitrate.
- Use the normal names Medium, High, and Highest for the quality presets. Do not create a
  separate mode named for terminals, code, or technical text. Show each preset's resolution,
  resolved bitrate, estimated file size, and selected encoder. Persist normal export choices.
- Resolve Medium to a 1080-pixel short side, High to a 1440-pixel short side (consumer 2K,
  2560 × 1440 for 16:9), and Highest to the source-sized project output. Keep Highest visibly
  identified as matching the recording so source quality is not hidden behind the preset name.
- Let the user choose webcam resolution and frame rate as one real format, such as 4K/30,
  2K/30, or 1080p/60. Persist the choice. Do not combine independent capability maxima into a
  format the camera cannot produce; test each offered width, height, and FPS combination against
  the camera and fall back safely if saved hardware capabilities changed.
- Keep the local Mac path first: VideoToolbox decode, Metal composition, and VideoToolbox
  encode without CPU readback. Add an edit-free remux/concatenate fast path when no visual
  composition is required.
- Remote export must run the same versioned project renderer, not a generic transcoder. Do not
  build cloud or LAN offload until a headless worker can package the project, referenced media,
  fonts, and assets and reproduce the local output deterministically.

## YouTube-ready audio and delivery

Klippt must export a file that Olle can upload without a separate audio-mastering step.
Keep capture media recoverable and non-destructive; do not permanently bake loudness changes
into the raw clips.

- Preserve microphone and system audio as separate source tracks or stems. The current Mac
  helper mixes them into one AAC track, which prevents independent dialogue leveling, system
  audio ducking, and later mix correction. Replace that limitation before calling automatic
  audio mastering complete.
- After a clip finalizes, analyze its spoken dialogue asynchronously. This work must never block
  Pause or Continue. Use ITU-R BS.1770 loudness and true-peak measurement, ignore silence and
  room tone, cap automatic gain changes, and store the result as editable project metadata.
- Make dialogue sound consistent across adjacent clips. Do not independently normalize each
  whole clip to one peak or LUFS value because short silence and low room noise can be boosted
  into audible jumps at every cut.
- After cuts, speed changes, voiceovers, microphone gain, and system-audio mixing are applied,
  measure and master the complete edited program. `Normalize volume` is one simple export option
  and is on by default. Use -14 LUFS integrated and no more than -1 dBTP as the practical default
  for online video. This is a Klippt mastering default, not an official YouTube upload rule.
  Use a transparent true-peak limiter only where needed. Let the user disable normalization.
- Automatic system-audio ducking under speech can follow the first mastering slice. Keep it
  subtle and reversible.
- Export normal YouTube audio as 48 kHz stereo AAC-LC at 384 kbps. Show measured input loudness,
  output loudness, true peak, and any warning that prevented safe normalization.
- Export a standard MP4 with Fast Start, H.264 progressive 4:2:0 video, the recorded frame rate,
  explicit BT.709 SDR color metadata, and the selected real output bitrate. Verify High Profile,
  GOP, B-frame, and container metadata from the saved file instead of assuming encoder defaults.
- Persist the user's normal export choices. A later direct YouTube upload action must first save
  the local MP4, use OAuth and a resumable upload, show progress and retry state, require title,
  description, and privacy, and default to Private or Unlisted. Never publish by surprise.
- Restore the last export format, quality, frame rate, codec, volume-normalization choice, and GIF
  options when the export dialog opens again.

## Visual direction

Aim for Screen Studio-level refinement, not a pixel copy.

- Use Screen Studio's broad professional-editor structure and calm density as a quality
  reference.
- Create original tokens, colors, icons, motion, copy, assets, empty states, and branding.
- Use the free-standing Klippt K on a transparent canvas for in-app and system icons. Keep its thin
  graphite outline so the light strokes work on light and dark surfaces. Do not restore a white,
  surface-colored, or rounded-square plate behind it. Keep the macOS menu-bar mark as a monochrome
  16 px template image with a transparent 32 px `@2x` companion; an opaque background becomes a
  solid status-item square.
- Klippt's product chrome is monochrome: graphite surfaces, soft-white text and controls,
  and neutral grays for hierarchy. Keep red for recording and destructive actions. Keep green
  for transient success and live audio state. Do not use a green glowing dot for passive state such
  as “Saved”; show that as quiet neutral text and reserve emphasis for “Unsaved”. Do not add a bright
  brand accent, colored glow, or decorative gradient to make the interface feel distinctive.
- Use one muted steel-blue functional accent for editor selection, the playhead, and automatic edit
  regions. Keep that color inside the editing workspace. Do not tint whole panels or use the accent
  as decoration. Keep the recording HUD monochrome.
- Use one dark, content-first editor window with a dominant preview, stable trailing
  inspector, and precise bottom timeline.
- Use restrained material/blur only for floating surfaces and window chrome.
- Keep canvas, inspector, and editor timeline mostly opaque for contrast and performance.
- Use one icon family and one token system for spacing, type, radii, color, shadows, and
  motion.
- Use one continuous surface for dense inspector settings. Ordinary toggle rows and sliders
  must not become cards inside the inspector. Keep bordered tiles only when the tile is the
  actual option, such as a cursor theme or camera shape.
- Prefer low visual weight over artificially tiny controls.
- Keep controls reachable with keyboard and VoiceOver. Support Increased Contrast, larger
  text, and Reduce Motion.
- Never sacrifice recording reliability for animation or glass effects.

## Architecture

Klippt is Mac-first, not Mac-only.

- Shared app/editor: Electron, React, TypeScript, PixiJS, and the existing project model.
- macOS capture: Swift, ScreenCaptureKit, AVFoundation, and `AVAssetWriter`.
- Windows later: C++ and Windows Graphics Capture behind the same capture-helper contract.
- Linux later: Rust and PipeWire/portal capture behind the same contract.
- Do not duplicate the editor per operating system.
- Do not rewrite the whole app in Swift merely to make the UI look native. Screen Studio
  itself proves that Electron plus native media helpers can produce a refined Mac app.

## Commercial and licensing boundary

This is a private proprietary product intended to make money.

- The first commercial release is a subscription-first paid private alpha. Keep one simple Klippt
  Pro entitlement. The founding price is $19 per month or $99 per year; both prices unlock the same
  product capability.
- Keep billing behind a small provider adapter. Do not embed a provider API secret in the desktop
  app. Store local license state with Electron `safeStorage`, allow a bounded offline grace period,
  and validate again when the network returns.
- Use Lemon Squeezy as the first provider and its subscription-linked license keys for activation.
  The provider adapter, local entitlement service, and UI are implemented. Commercial enforcement
  stays off until the public store, product, variant, and checkout identifiers are configured.
- Start one 14-day no-card trial only after the first successful recording is durable. Before that
  recording, the complete product remains available so setup is not part of the trial clock.
- When the trial or subscription expires, keep existing projects available as a read-only viewer.
  Allow playback and untouched source recovery. Block recording, imports, document edits,
  automatic editing, regeneration, and finished exports. Never delete or hide project media.
- An entitlement failure must never delete, corrupt, or hide the user's local recordings and
  projects. Do not interrupt an active recording or export because a validation request fails.
- The pinned OpenScreen base is MIT licensed and permits commercial proprietary use.
- Preserve the exact upstream copyright and MIT permission notice in source and every
  distribution.
- Keep the public repository as fetch-only `upstream`. Never push product work there.
- Add a private `origin` only when Olle supplies or creates the private remote.
- Complete the runtime and visual rebrand before public distribution. Do not ship the OpenScreen
  name, logo, identity, screenshots, or marketing assets as Klippt.
- Do not copy AGPL Recordly code.
- Before a paid release, generate and review dependency and asset notices. Preserve LGPL
  requirements for dynamically linked FFmpeg. Reject unapproved GPL/AGPL/nonfree or unknown
  components.

## Performance and reliability gates

- Recording failure must be loud and recoverable. Never let the HUD count while the writer
  has already failed.
- Save project state after each committed clip and removal.
- Keep capture and writer work off the renderer thread.
- Use standard files that remain recoverable after a crash where possible.
- Do not delete media synchronously from Backspace.
- Test clips shorter than one second and recordings of 5, 30, and 60 minutes.
- Test microphone only, system audio only, both, and neither.
- Test repeated Pause/Continue, Pause followed immediately by Stop, and removal back to zero.
- Exclude recorder windows from captured output. On macOS 26, fix this in the
  ScreenCaptureKit `SCContentFilter` by excluding the app's own windows; Electron content
  protection alone is not sufficient.
- Report native export throughput and the selected decode, compositor, and encoder paths so a
  software fallback cannot look like a slow but successful hardware export.
- Benchmark export with representative terminal footage at 1080p60, source resolution, and the
  Highest quality preset before selecting speed/quality defaults.

## Repository commands

Use npm only. Native modules and the lockfile depend on it.

- Install: `npm install`
- Dev app: `npm run dev`
- App typecheck: `npx tsc --noEmit`
- Test typecheck: `npx tsc -p tsconfig.test.json --noEmit`
- Targeted unit test: `npx vitest --run <path>`
- Full unit suite: `npm run test`
- Lint: `npm run lint`
- Format: `npm run format`
- i18n validation: `npm run i18n:check`
- Build macOS helpers: `npm run build:native:mac`
- Build app: `npm run build`

Run targeted tests during development. Run the full suite once at the end. Never use the
non-terminating test watcher.

The normal app build does not rebuild the Swift/C++/Rust capture helpers. Rebuild the full
platform-native directory before trusting native results. A successful Electron build does
not prove the helper contains the current source.

## Code and test rules

- Do not use TestSprite for Klippt unless Olle explicitly asks for it.
- TypeScript is strict. Do not add explicit `any`.
- Match the surrounding module's architecture. Do not refactor unrelated code.
- React uses functional components and top-level hooks.
- Add tests for each new behavior in the same package as the code.
- Platform-conditional tests must pin the platform because CI is Linux.
- Native capture, preview, or export changes require a real Mac desktop recording pass in
  addition to unit tests.
- For HUD screenshots in development, `OPENSCREEN_DISABLE_CONTENT_PROTECTION=1` makes the
  panel capturable, but a recording made with it can include the HUD. Unset it for real
  capture validation.
- Read `technical-documentation/testing/manual-e2e-checklist.md` before a release-candidate
  smoke test.

## Working discipline

- Preserve unrelated user changes in a dirty worktree.
- Keep the first working path small and real. Do not substitute a visual mock for working
  media behavior.
- Do not expose controls that claim an operation succeeded when only local UI state changed.
- Do not call the first version working until real files, project state, playback, and export
  agree.
- Update this guide when Olle changes a durable product decision.
