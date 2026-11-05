## Product goal

October 3, 2026 direction: a fast, strictly recording-focused recorder with a TikTok-style
capture workflow. Editing is no longer the focus; do not build new editor features.

1. Open the floating recorder with a usable screen selected when available.
2. Set up the screen/window, microphone, system audio, and camera only when needed.
3. Start recording immediately from the floating panel. Show recording only after the
   native writer has accepted a frame.
4. Pause whenever a spoken section ends.
5. While paused, optionally change the source, microphone, system audio, camera, or cursor
   setup for the next clip.
6. Continue into a new clip. Reuse the current capture pipeline when settings did not
   change; safely reconfigure it when they did.
7. Remove the previous completed clip immediately with Backspace when it was bad.
8. Stop to review the recording with playback and a simple seek bar.
9. Export Separate takes by default; keep One video as a remembered alternative.
10. Record again as a new capture, without creating an empty project first.
11. Keep original clips available for recovery and outside workflows.

The product must feel like a normal recording app. Clip-native recording is built in; it is
not a separate mode or an advanced workflow.

October 4 creator-loop refinement: Record from review opens an idle compact pill for a new
recording. Escape or Close returns to the saved review while idle; navigation stays blocked
during recording startup and finalization. Settings expand without a delayed entrance.
Recovered captures retain their interruption reason in the recording manifest and saved project.
Review keeps a visible interruption notice after reopening, with details and Record again.
Do not replace this with a transient toast or ordinary recording-success message. Original-file
recovery remains available when the entitlement is read-only. Removing the affected recording
from the timeline removes its notice; restoring it restores the notice.

Record, Save and Recordings share a pending-action guard, with visible progress and recovery
after failure. The recordings browser supports search, arrow-key selection and Enter, and
shows loading or failure instead of presenting stale rows. Review shortcuts respect dialogs,
text fields and the exact platform modifier; held action keys do not repeat navigation.
Space or K always plays or pauses in review, including with a button or the playhead focused
(Enter still activates a focused button). Left/Right step one frame, Shift-Left/Right or J/L one
second, Up/Down move between clips, Home/End jump to the start or end, and M mutes the preview.
Editing happens in DaVinci Resolve; this refinement adds no editing tools.

The inherited editing model remains for old-project compatibility and the existing CLI.
The following editor sections describe that retained behavior, not a queue for new features.

## Agent-native product model

Olle's September 7 direction includes supplied media folders: agents can discover and import
images, video, music, and sound effects, then create timed overlays, audio edits, and transitions
through the same editor model and controls as the UI. Implement each capability with normal Undo,
source preservation, and matching preview/export before advertising it. Expose exact output-pixel
screen/camera/overlay bounds, centers, and distances from canvas edges. Structured readback should
reduce unnecessary image inspection while composed images remain available for visual checks.

Klippt must be excellent to use through both the UI and coding agents. The CLI and future local
agent bridge operate on the same versioned project document and the same typed editing commands as
the UI. Do not create an agent-only timeline, duplicate editing logic, or let agents rewrite project
JSON directly.

Machine-facing commands must return stable IDs and structured JSON. Every write must support a
clear dry run, require the expected project revision, save atomically, and create one normal Undo
step. Agent edits preserve source media and follow the same recovery, ownership, and history rules
as UI edits. An agent can remove a clip from the edit, but it cannot silently delete recorded media.

**Agent edits are reversible.** Each successful agent apply stores a full before-document and
an after-document beside the project. Keep the last 50 writes across restarts. History, guarded
undo/redo, and source replacement preserve original media and update the same live editor model.
Refuse restores across intervening edits unless the agent explicitly forces them. Each write
returns touched-span state, check changes, and next actions; incomplete audio checks remain
explicit. Candidate errors block ordinary apply unless forced. Source swaps retain fitting trims
and independent text/B-roll, report lost spans, and flag missing word anchors for repair.

Read-only agent checks return structural findings immediately and finish audio checks in the
background with two workers. Replies include audio progress, counts and pages below 48 KiB.
Default checks use microphone peaks and transcripts; `--deep` enables speech activity analysis.
Word-timed auto captions do not produce generic near-cut or off-cut findings. Only a removed
caption whose source words remain in its owning clip produces `caption.orphaned`.
Overlap checks respect native draw order: B-roll below text or enabled captions is normal.
B-roll with captions disabled can warn. Cut checks require at least 0.5 seconds of transcript
disagreement or more than 0.25 seconds of microphone disagreement, with one strongest finding
per cut. Subframe projected remnants are omitted from region/orphan checks.
Agent card sizes XS/S/M/L/XL target 3/4.5/6/8/11 percent of output-frame height at placement;
labels use one smaller step and lower thirds one larger step. The CLI reports spans whose
screen heights differ, since one annotation retains its initial screen-relative sizing.

The complete target command surface includes project inspection, media health, Split, Remove,
Restore, reorder, trim, insertion, layout, Screen Zoom, Camera Emphasis, audio settings, automatic
direction, validation, and export. Keep the transport thin. A future MCP or JSON-RPC adapter must
call the shared command service instead of owning product behavior.

Agent still previews seek the requested edited playback time in the native compositor. Keep the
complete scene and exact trim, speed, camera-offset, cursor, and effect time mappings. A long
project must not require rendering its earlier frames or audio before one requested image.
Bound dimensions, media count, output bytes, and runtime. Keep source approvals and project-hash
checks in the normal loading flow.

Agent discovery declares command effects and required evidence. Commit status and
verification status are separate: missing proof never removes a committed edit's
recovery receipt. Saved renders cannot prove live playback; speech-cut listening and
visual review remain explicit pending work until actually performed. Passive readiness
checks report unknown capabilities honestly and never move the playhead or open a project.
Compact CLI output preserves recovery details and links to the complete local reply.

### First agent media slice (September 7)

Schema version 10 adds independent audio assets and clips for music and sound effects. Audio clip
start/end positions use edited output time, with source offset, gain, and fades. Video edits do not
silently ripple these clips. Keep original files; removing a clip only removes its reference.
Preview uses a cached native PCM stem. Export mixes the same placements before final mastering,
so the unmastered preview can differ in loudness. Report missing audio visibly.

Image annotations use the shared entrance-animation field in preview and native export. Agent
imports validate local image decoding and audio duration before preparing the candidate. Video
overlays and general timed layout keyframes remain planned, not implemented. See
[agent CLI](agent-cli.md) (archived on 2026-10-05) for the former capability and limit contract.

## Product language — non-negotiable

- Call recorded sections **clips**.
- Use normal words such as **Record**, **Pause**, **Continue**, **Stop**, **Remove previous
  clip**, **Split**, and **Undo**.
- Never call clips “takes”.
- The existing export choice **Separate takes** is the explicit October 3 exception;
  recording controls and clip history continue to call recorded sections clips.
- Never add a “redo take”, “replacement take”, “candidate”, “pickup”, “record here”,
  “keep”, or “retry” workflow.
- To record something again, remove the previous completed clip while paused and Continue.
  After Stop, review's **Add clip** records more clips into the same recording (Olle,
  2026-10-05). Record starts a new recording. Review has no other editing workflow.

## Current delivery target: first working version

The first version is a bare Mac-first vertical slice. It is working only when this complete
path works with real capture:

1. The user selects a real screen/window and audio settings.
2. Record starts immediately. Show `Starting recording…` until the first frame is accepted.
3. The floating panel contracts into the compact active-recording HUD.
4. Pause finalizes the current clip without stopping ScreenCaptureKit when settings stay
   unchanged.
5. Paused setup changes apply to the next clip without ending the logical recording.
6. Continue starts a new clip. It does not ask for setup again unless the user opened a
   source picker while paused.
7. Pause and Continue can repeat several times.
8. Backspace removes the newest completed clip; repeated presses can remove all completed
   clips.
9. Stop finalizes the active clip, ends capture, hides the panel, and opens recording review.
10. Every kept clip plays continuously in order; review offers playback and a seek bar.
11. Save video opens export with Separate takes preselected on a fresh setup; remember the
    explicit last choice. One video produces a normal MP4 through the native save picker.

Keep this slice minimal. Do not block it on captions, transcript, paused playback,
thumbnails, waveforms, automatic zoom, AI editing, Windows, Linux, broad rebranding, or a
large library redesign.

## Recording model

Do not invent a video format.

- Keep one live ScreenCaptureKit video `SCStream` for the recording session. Window capture
  uses an additional display-wide audio-only stream when system audio is enabled, so other
  applications remain audible. Feed that unprocessed mix to the separate system-audio original.
- Resolve microphone IDs before names, accepting Chromium transport and USB label suffixes
  only when the name is unambiguous. Warn visibly if a selected input falls back to the
  system default; an explicit Default selection does not warn.
- Each Pause finalizes one standard fragmented H.264/AAC MP4 clip.
- Continue creates a fresh `AVAssetWriter` and starts it on the first valid sample.
- Store clip order and state in a versioned JSON project document.
- Stop finalizes the active writer, closes capture, and opens the project.
- Separate takes copies complete source files; One video composes kept clips into one MP4.
- Backspace changes project state immediately. Keep removed media until normal cleanup so
  Undo and crash recovery remain possible.

Pause by itself must not restart source selection, ScreenCaptureKit, or permissions. If the
user changes capture setup while paused, reconfigure or restart only the capture parts that
must change before Continue. Keep all completed clips in the same logical recording. Pause
must not wait for transcription, thumbnail generation, waveforms, proxy creation, cleanup,
concat, remux, or re-encoding.

On Linux, Record reuses the last compatible portal source grant when the compositor
supports remembering consent. Settings → Source is available before recording and while
paused; it always opens a fresh system chooser. Idle source selection records no media.
Keep approval tokens private to the native helper and rotate them after every use.
Changing cursor mode or losing/revoking a grant can require another chooser. Cancelling
an explicit choice preserves an existing paused recording, but discards the remembered
grant so the next take asks again rather than silently recording the former source.

If the selected source disappears while paused, preserve the completed clips and allow
reselection before Continue. A stopped stream needs a freshly configured replacement; a
filter update alone does not establish restarted capture. An explicit failed Continue that
fully rolls back to paused without acknowledging a new clip remains retryable. A timeout,
dead helper or failed active writer still requires loud recovery. Ignore stopped callbacks
from replaced streams and callbacks during Stop; do not suppress current active-source loss.

Start immediately by default, with no countdown or duplicate source enumeration after screen
permission is granted. On macOS, one standby capture helper loads the capture frameworks and
encoder without capturing; Record hands it the request. Main starts it a second after launch and
checks every minute while nothing records (Olle, 2026-10-05: the first Record after launch was
2.3 s cold); pointer or focus on Record also warms it. It exits after 10 idle minutes and is
never reused after 9; without it Record spawns a fresh helper as before. A pending start disables duplicate Record and setup changes.

Studio and local-agent Record requests create the recording owner if needed and
wait until its start listener is subscribed. Send each request once. Report success
only after native writer confirmation with the matching recording ID; command
acceptance and a live helper process are insufficient. Report busy or failed
starts to both callers. A 30-second unconfirmed request reports uncertainty and
records its last stage locally; it never retries a toggle or claims cancellation.
Source and permission handoffs remain visible and can continue after user input.

Only the first successful screen append starts the HUD timer (Olle, 2026-10-04); camera, microphone and
system audio join on the same epoch when their first sample lands, and each original keeps its
offset. Continue obeys the same barrier. A source that has not appended within two seconds of
the epoch fails the take loudly, even after the timer started. High
must also catch up its output grid before confirming recording. Preserve the first screen
epoch and pixels while writers become ready; do not move the session start to hide delay.
Allow at most one second of pending High grid slots during startup and fail missing source
readiness after two monotonic seconds, even if no more samples arrive. These are bounded
local policies, not platform latency guarantees. After confirmation, retain the strict
eight-frame live backlog limit. A historical output slot uses only pixels captured at or
before that slot; repeated pixels retain their original source timestamp. While active, retain
at most two recent complete captures so a newer arrival cannot displace the image for the
current slot. Never regress behind the last written source timestamp. Prepare screen
and enabled original writers before accepting the
first capture sample; Continue chooses its new host-clock seed after preparation completes.
The optional countdown overlay must settle or cancel within a bounded wait.

Recording setup has a remembered **Quality** choice before Record and while paused, applied
only to the next clip. Fresh setup defaults to **High**. Standard preserves the current app's
68 Mbps H.264 screen request; High selects 136 Mbps H.264 at source pixels and a 60 fps output clock
where the display permits it. Report actual source cadence, output cadence, duplicated frames
and writer drops separately. A cadence hint alone does not establish constant-rate recording.
When the screen encoder is briefly full (camera plus High at 60 fps on a MacBook Air), the 60 fps
clock skips the frames it cannot fit and holds the previous picture; the take continues and the
skips are reported as `skippedVideoFrames`. Only an encoder that accepts nothing for two seconds
stops the take, loudly (Olle, 2026-10-04; it previously stopped after 133 ms).
The native helper's legacy missing-bitrate fallback remains 18 Mbps; that fallback did not
describe the bitrate explicitly requested by the current app.
Setup shows the camera-format picker on both qualities (Olle, 2026-10-05). On High it starts at
Automatic (16:9), which requests the camera's largest 16:9 native format, then its highest rate
(Olle, 2026-10-05: pixel count alone chose the MacBook camera's square 1552×1552 mode); a camera
with no 16:9 mode gets its largest format. Picking a listed mode
such as 4K 30 fps or 1080p 60 fps records exactly that mode and is remembered. Standard keeps the
remembered explicit camera-format choice. High never promises preview dimensions as the native
recording geometry. Report actual negotiated pixels in capture
telemetry and the saved media. A camera that another client moves to a different frame size never
stops Record or a take (Olle, 2026-10-24): those frames are dropped with a camera-interrupted
warning, the native format is requested again, and the camera rejoins at its native size.
Create complete microphone and system-audio source files during capture, alongside the screen
and camera sources. On macOS, camera video and standalone AAC audio use fragmented MOV files
so readable fragments survive a helper crash. Persist their actual first-sample offsets and
paths as they start; recovery validates readable, owned sources before attaching them.
Framework sample delivery has a separate serial queue from writer/cadence processing, with
synchronous handoff and a delivery barrier when changing sources. Report source delivery age
and complete-source frame intervals separately from output cadence; static-source gaps are
observations, not proof of lost frames. Reset interval baselines across clip boundaries.
Camera and standalone audio appends run on bounded serial owners outside the video cadence
queue. Compatibility PCM decode, mixing and AAC appends also use a separate serial owner,
with at most 128 queued/in-flight samples and 8 MiB retained raw data. Preserve source
timestamps and report rejected appends, including when writer status still says writing.
Drain accepted original samples and their metadata before reporting a finalized clip.
Finalize every source before committing the clip; failures remain visible and already-durable
media remain recoverable.

Baked system cursor is the fresh-recording default. Preserve explicitly saved editable-cursor
preferences. Optional macOS Accessibility never blocks Record or opens a permission dialog
from Record. If cursor access is denied or unresolved, use the system cursor for that take
and tell the user the editable cursor is off; retain the saved preference for a later take.
The HUD and Studio timer count from the helper’s first written frame, including start-reply latency.
While paused, retain only the latest complete frame for the current source; seed
Continue at its new host-clock boundary, then accept newer live frames. When a static source
produces no new frame, preserve Pause/Stop duration with a closing frame. High completes the
remaining 60 Hz grid through the frozen boundary, allowing one partial final interval. A terminal
failure freezes that boundary before recovery Stop. Bounded writer backpressure failure is
reported to the HUD and preserves committed clips.
After closing video and draining original-source callbacks, close compatibility admission,
drain its owner and flush buffered audio before ending High's writer session and marking
its inputs finished. Delayed callbacks must match the current writer and clip; their actual
failure time freezes the earliest terminal boundary. Finalization must
return a clean writer completion; fragmented-file recovery remains a visible failure fallback.

Target local-SSD Pause finalization at p95 below 300 ms on this Mac. Show Pause feedback
immediately. If `AVAssetWriter.finishWriting` is still running, show a quiet saving state and
disable Continue until the clip is safe.

## Pause, Continue, Stop, and Backspace

- **Pause** finalizes the active clip and stays in the recording session. The control flips to
  Continue at once and shows a thin spinning ring, never a dimmed button, while the clip file
  closes; it accepts Continue once the writer confirms (Olle, 2026-10-04).
- **Continue** starts the next clip immediately and confirms its first appended frame.
- **Stop** is different from Pause. Stop ends capture and opens recording review. The Record circle
  changes into a clear Stop square while recording. Keep it icon-only; do not add permanent
  `Stop` or `Stop Recording` text. The tooltip and accessibility label explain the action.
- Quitting during a take stops it first so its clips finalize, waiting at most 15 seconds. The
  recovery journal covers a capture that does not stop in time.
  If the quit is then cancelled, the HUD leaves the recording state and opens review of the
  take that was stopped.
- A live take pauses on its own when there is nothing left to record: the recorded window
  closed (macOS 15.2+), the screen locked, or the Mac is going to sleep. A toast says why;
  Continue works as after any Pause. The display stays awake while a take records.
  On Linux the helper reports the same `source-inactive` when the portal stream goes away
  after a clip was confirmed; Continue then waits for Settings → Source to adopt a new
  source. Screen lock has no Linux signal, and a Linux take keeps the display awake
  through the session's idle inhibit.
- **Backspace** removes the newest completed clip immediately.
- Backspace has no confirmation dialog and no removal mode.
- Repeated Backspace presses continue backward, including removing every completed clip.
- Disable Backspace when no completed clip remains.
- Use the tooltip and accessibility label `Remove previous clip`.
- Do not implement whole-recording Restart as the normal recovery action.

## Floating recording panel

Studio Finish holds its current frame until review imports the take and paints its first
video frame. A renderer-to-main handoff token identifies each Finish, with a 1.5-second
fallback to a covered loading stage. Review inherits the Studio bounds. Studio mode persists
across review and Record more: the recording pill is created hidden during these handoffs.
On macOS, Studio enters over 180 ms and exits over 120 ms; Finish fades Studio over the
loaded review over 180 ms. Focus changes immediately. Reversing retargets the current native
opacity. Reduced motion and Linux window swaps are instant. Capture exclusion always hides
Studio immediately, without waiting for motion. Camera and replay reveal over 120 ms only
after drawable media arrives; the Live badge is concealed until its camera frame is ready.


Capture and review are two states of the recorder. App launch opens the floating panel with
a usable screen selected when available. Record starts capture directly; no project-creation
step or source-picker click is required for the default screen. Explicit source selections
and portal-based Linux selection remain authoritative.

Review's Record action saves any pending project state and opens the idle recording pill for
a new standalone capture. It does not insert into an old project.

Review's **Add clip** action opens the same idle pill, and the clips it records go into the
open recording (Olle, 2026-10-05). They land at a clip boundary, never inside a clip. Until
the viewer moves the playhead after Stop or after an added clip, the boundary is the end, so
an accidental Stop is fixed with Add clip and Record. Once the playhead moves, the boundary is
the one nearest the playhead (a tie goes to the later one). A short accent mark on the
paused progress bar shows that boundary. The project keeps its canvas, each clip keeps its
own source files, and nothing is re-encoded until export. Setup reveals screen/window,
audio, camera and cursor setup. Closing idle setup or pressing Escape returns to review.
Stop saves the completed clips and opens review as a compact player centred above the
recorder's spot on the same display (Olle, 2026-10-04). The window takes the recording's own
shape: the video is up to 960 points wide with no letterbox, and the window is only the video plus
the header and a 12 px frame. When clips have different
resolutions, the window follows the one output frame and mixed clips letterbox inside it.
The window opens at that final size, using the recorded display's or window's shape, so it never
resizes while loading. Until the first frame is ready the video area shows only a dark frame
with a small 12-bar spinner; the video and play bar then fade in (Olle, 2026-10-04). Two seconds into a take,
Electron loads the review window hidden so Stop shows a warm window; that hidden review opens no
project until Stop hands it the take. Stop skips re-probing the recovery journal when the helper's
final event already lists every clip and original. Stop timings land in
`diagnostics/record-stop-timing.jsonl` under the app's user-data folder; Pause and Continue
timings land beside it in `record-pause-continue-timing.jsonl`. Stop does not wait for the
camera to shut down: its frames are refused from the click and the helper exits right after
(Olle, 2026-10-06). The timer never drops back while Pause saves a clip, and it holds the time
of the click while Stop saves. While the recorder window itself holds the camera, the standby
capture helper keeps the same camera started so Record does not wait for it; the helper lets go
the moment the recorder does, and a Continue restarts the camera only when the camera's own
setup changed (Olle, 2026-10-06).

Review follows the approved prototype and is always dark (Olle, 2026-10-04): a 60 px header with
the Klippt mark, the recording name and "0:28 total, 3 clips", then Record (red dot), Original
files and Recordings as ghost pills and Save video as the one light pill. The video sits 12 px in
from the window edges with 16 px corners, and the play bar floats over its bottom on a dark
gradient: a round play control, clip skip, time, mute and a white scrubber with a gap at each
clip boundary. In the small player, ghost actions show icons only; Save video keeps its label.
Expand grows it into the full review window.
No timeline, inspector or canvas editing handles are shown.

Record switches the pill to its recording layout the moment it is pressed. Until the writer
confirms capture, the timer is held at zero, Pause is unavailable, and Stop cancels the start.

Use a quick, restrained transition. Do not add a setup dashboard, mode chooser or navigation
stack. Native File menu and keyboard actions use the same recording and save flow; menu actions
must not replace an active recording HUD.

The recorder is one floating pill in every state (Olle, 2026-10-04: the old wide bar is gone).
Idle, it shows the Klippt mark (drag handle), the source with a screen or window icon and a
chevron, system audio, microphone (with a live level line while the idle pill is on screen; it stops when the pill is hidden or minimized), camera, Setup, and a
28 px red Record ball inside a thin light ring. Recording, it shows the large round
Pause/Continue control, the total time as plain text that doubles as the drag handle, then
Stop, Remove, Replay and Setup as flat secondary icons. Pause/Continue is primary because
creators pause far more often than they stop. No control sits in its own pill inside the pill.
Every edge inset is 4 px, so the 40 px round control is concentric with the 25 px pill radius.
The recording pill keeps the same controls through Pause, so Pause/Continue never moves under
the cursor. Do not create a second bar or a detached timeline pill. A drag ends whenever the
button is no longer held, and the pill cannot be dragged off the display.

The pill drags to every edge of the display's work area: up to the menu bar, down to the Dock,
and fully into each side and corner, and no part of it ever leaves the work area (2026-10-24; it
used to be stuck in a strip at the bottom). When the pill sits near the top, Setup, Source,
Replay, the permission panel, notices and recorder errors open below it instead of above it,
shrunk to the room on that side.

A tucked pill stays attached while expanded (2026-10-26). At the top, one central
Klippt mark or actual recording timer stays mounted as the small tab grows into the full pill.
Controls remain natural size and are revealed through the same moving boundary as the
connected surface; there is no tab/control opacity swap. The top remains flat against the
work-area edge, with rounded bottom corners. The full expanded footprint is reserved when
docking, so expansion does not move or resize the native backing window.

Opening and closing share a sampled spring easing: damping 0.8, response 0.4 s and a 600 ms
settle window. A small overshoot softens the landing. Re-entering during closing reverses
from the current shape. Startup alone skips the tuck animation. Reduced motion removes
shape travel. Hidden wings become inert immediately and leave keyboard navigation.

Hover opens after 120 ms; leaving the complete painted surface starts a 280 ms grace period.
Native pointer samples and DOM input feed one controller, including when the panel ignores
mouse events. Repeated stationary samples do not restart deadlines. Click, Enter or Space pins
the same attached pill open; activating the pinned grip collapses it. Escape dismisses an open
panel first, then collapses the pill while retaining grip focus. Focus, dragging and child panels
hold expansion. Setup and Source open within the attached recorder and return focus to their
invoker. Only dragging changes docking. The left, right or top dock is remembered across
launches. A remembered floating fold does not hide controls when the top dock expands.

The idle pill can be minimized (2026-10-24). Clicking the Klippt mark without dragging folds it
to the mark and the Record ball; clicking the mark again restores the full pill. Enter or Space on
the focused mark does the same, and its tooltip says "Click to minimize, drag to move" (or "Click
to show all controls, drag to move"). Dragging the mark still only moves the pill. Folding closes
any open panel. It does not expand on hover, because hover expansion would move Record under the
cursor. The choice is remembered across restarts. Record on the minimized pill runs exactly the
same start path as the full pill (source check, permission panel, writer confirmation), and the
pill then switches to the normal recording layout; when the recorder is idle again it returns to
the minimized pill. A pill that grows at a screen edge (expanding, or switching to recording) is
pulled back so it stays fully on the display. Loom and Screen Studio offer moving or hiding their
controls rather than a folded state; this keeps Record one click away.

The source chip, Setup's Window choice and Record without a chosen source open the Source panel
above the pill, Setup's width and glass (Olle, 2026-10-04): a Screens / Windows switch with a
sliding thumb, a close control, and a two-column grid of live thumbnails with app icons. One
click chooses and closes; Escape or a click outside closes without a change. It opens on the
tab of the current source and marks it. If macOS screen access is not granted yet, the
standalone picker window opens instead, because that path asks for access and lets the main
process decide who owns the choice. On Linux the visible Source chip opens the native
portal chooser directly, as does Settings → Source; Record can reuse the remembered grant.
Linux keeps the logo as a compositor-owned drag region and does not offer click-to-fold.
Linux opens Setup below a fixed local pill origin. During monitor capture or when
source isolation is unknown, hide controls before Start/Continue unless Niri proves
that this process's floating pill is on another uncaptured output. Recording another
window can retain the HUD. Match the exact
portal PipeWire node and current logical window/workspace/output geometry; Electron
coordinates alone do not prove isolation, and Wayland does not expose reliable global
window position through Electron, so a second-monitor exemption is never inferred
elsewhere. Evaluate the pill and camera independently.
Safe focus and layout updates retain visibility; unsafe placement, overview, output
changes or lost IPC revoke retention until Pause. This is conditional placement,
not atomic compositor-level capture exclusion. Pause restores hidden controls.
Notes and Transcript follow the unconditional rule: Electron's content protection is
macOS/Windows only, so on Linux they unmap with the recorder for monitor or
unknown-source capture and return, unfocused, at Pause.
The portal chooser temporarily hides the pill, then restores its saved Niri output
and absolute local position before preparation completes. Cancellation invalidates
pending selection/restoration; replacement capture waits for in-flight placement.
On Niri, restoration explicitly activates only this process's matching floating
recorder window. Asking to show a concealed active recorder first requests Pause, so
controls cannot silently appear in footage. Other Wayland compositors retain
conservative hiding.
Linux defaults are Ctrl+Alt+O for controls and Ctrl+Alt+R for Pause/Continue, leaving
Koett's Ctrl+Shift+Space untouched. The configured Niri fallback additionally maps
Ctrl+Alt+S to Stop. These compositor bindings target the running app through its
single-instance control flags and do not depend on portal shortcut callbacks.

The panel opens on the last screens and windows it read and swaps in fresh thumbnails when
they arrive; pointing at the source chip starts that read early (Olle, 2026-10-04).

Recorder toasts occupy their own compact stack slot beyond the open panel, separated
by the normal stack gap. They never cover Setup or the transport controls. Show one
notice at a time, using compact padding and readable text; dismissal releases the
reserved space. Review keeps its existing notification layout.

Setup floats above the idle pill at the same 424 px width, laid out like the approved prototype
(Olle, 2026-10-04). Top: a Display / Window choice with a sliding thumb; Display picks the main
display in one click (or opens the picker when a display is already chosen), Window opens the
source panel on its Windows tab. Middle: a 2 by 2 grid of System audio, Microphone, Camera and Editable cursor tiles, each
with its device or state and its own switch; the microphone tile shows a live level line.
Microphone and camera tiles open their device list below the grid, one at a time. Recording
quality sits below that. The footer is Notes, Language and Recordings while idle, and Notes,
Restart and Discard while recording. The header has Hide, Quit (idle only, not when returning to
review) and a close control that only closes the panel. Every block uses an 8 px gap and inset,
with 14 px tiles inside a 22 px panel radius. While capture runs, the header reads "Pause to change
setup" and the source and tiles dim and lock; it opens no mic meter or camera preview of its own
until a completed Pause.

Replay (the up arrow or Up key, only after a completed Pause) opens a separate popup
above the pill with no recording controls. Its video takes the recording's own shape, up to
640 px wide, with no letterbox (Olle, 2026-10-04); a later clip of another size letterboxes
inside the first clip's frame. It plays the kept clip files end to end with sound,
starting five seconds before the end, so the creator can pick up where they left off. One
scrubber is split by clips; Left and Right jump between clips; M mutes; Escape or Down closes.
Continue closes it immediately. It never changes the session. A clip recorded with the camera
shows the camera on top of the screen, in its own shape, at the size and place last chosen in
review (Olle, 2026-10-06).

Provide a configurable global Pause/Continue shortcut. Default to `Command-Shift-Space` on
macOS because `Command-Space` belongs to Spotlight. The renderer recording state is the final
guard: ignore the shortcut while idle, saving, or finalizing.

The idle pill is 424 CSS px wide (88 px minimized) and 50 px tall; the recording pill fits its controls at the
same height. Preserve one surface and one anchored position through the transition.

Notices (Olle, 2026-10-04: fewer toasts). Success toasts that repeat what the screen already shows
are removed. Errors and warnings stay. In review they appear top centre under the header, two at
most, in the pill's dark glass. In the recorder they appear just above the pill (below it when the
pill is near the top), stay six seconds,
and make the click-through overlay clickable while the pointer is over them.

Motion (Olle, 2026-10-04, following Emil Kowalski's rules): Setup, Source and Replay grow out of
the pill from its bottom centre (its top centre when they open below it; 96 % scale, 8 px lower,
240 ms strong ease-out) and close in
120 ms. Replay opened with the Up key appears instantly. The pill morphs between idle and recording
widths on the drawer curve while the new row fades in through a slight blur. Reduced motion keeps
only fades. Only transform, opacity, filter and width animate.

### Setup locking

- Lock setup controls while a clip is actively recording or finalizing.
- Unlock source, system-audio, microphone, camera, device, and cursor controls after Pause.
  A paused change applies to the next clip and must never rewrite a completed clip.
- Do not enable a paused control until its change reaches the real capture pipeline. A local
  UI toggle that the next clip ignores is a recording bug.
- Backspace removes the previous clip; Remove shows its duration in the tooltip.

The HUD uses a native transparent backing window that is much larger than the painted panel so
menus can open without resizing the window. The pill sits at the window's centre with the same
menu room reserved above and below it, so panels open on either side without moving the window.
The window may extend past the display (on macOS it is created with `enableLargerThanScreen`,
because AppKit otherwise keeps a window's top edge below the menu bar); only the pill is clamped
to the work area. On macOS it is a non-activating panel at the floating
level, like the camera monitor, so it stays visible when another app enters its own fullscreen
Space; a plain always-on-top window drops out of that Space. Make that window click-through
before its first visible frame. Forward pointer movement and enable mouse input only over painted HUD
surfaces, including while a panel is open (2026-10-24: holding the whole window clickable while
Setup or the permission panel was open blocked clicks and scrolling in other apps, such as System
Settings during the permission steps). A click in another app closes Setup, Source and Replay; the
permission panel stays open until its steps finish. Never leave a startup gap where the invisible
backing window can swallow a click meant for another app. Keep the delayed renderer-driven startup on Windows because Electron implements
forwarded mouse movement there with a global low-level hook.

Pause must keep the transport geometry stable. Clip finalization must not replace the Stop
button or timer with a Saving label, and the Pause/Continue control must stay mounted in one
slot while it is temporarily disabled.

Stop saving must retain the last timer and recording pill until the review handoff finishes.
Disable transport and Replay while saving. Reduced motion removes the entrance animations.

### Camera confidence monitor

On Linux, create the same separate confidence monitor as macOS. For monitor or
unknown-source capture, hide it with the HUD before Start/Continue and restore
its requested visibility only after confirmed Pause or failed startup. A late
renderer visibility request or renderer reload must not override capture hiding.
The camera keeps recording into its separate original while its preview is hidden.
Window-only capture can retain the preview. On Niri, a preview already on
another uncaptured output can remain mapped during monitor recording. Compositor-
clipped edges are allowed only when they cannot intersect another output. Match the
portal's exact PipeWire node against compositor casts and validate logical window,
workspace and output geometry before writer admission. Unknown identities,
dynamic casts, ambiguity or missing IPC retain hiding. Safe layout/cast updates are re-evaluated without hiding. Unsafe placement,
monitor changes or lost compositor state revoke this permission until Pause; do not remap a hidden preview
mid-clip from a stale position. This is conditional placement, not compositor-level
atomic capture exclusion. Niri integration places the uniquely titled `Klippt Camera`
window away from the HUD without taking keyboard focus.

- Keep the camera monitor as a separate preview-only window. Its position and shape never set
  the recorded camera's editor layout.
- Keep it always on top but non-focusable. Show it without activating OpenScreen so it does not
  steal keyboard focus from the app underneath. Its own small surface remains draggable.
- Use one compact shadow contained inside the monitor window's transparent gutter. Do not clip
  a broad CSS shadow at the native window edge or add a second native window shadow.
- Reuse the recorder-owned camera stream. Never open a second camera session for the monitor.
- Relay one backpressured 576 × 324 Retina frame at no more than 24 FPS. Use high-quality
  downsampling and GPU bitmap transfer. The monitor must not change the selected recording
  resolution or FPS.
- Request a new renderer-to-renderer connection after either preview side mounts or reloads.
  The monitor must not remain on Loading after a renderer reload.
- Keep the monitor and its cursor activity out of display capture and automatic direction.
- Put one Expand control in the monitor's top-right corner. Expanding grows the same window to
  the largest centred 16:9 surface that fits its display's work area, still on top and
  non-focusable, so the user can check framing or a camera-only shot. The same control
  collapses it back to the user's compact size at its previous position. While expanded, relay a
  larger frame sized to the surface's device pixels, capped at 2560 × 1440 and still at most
  24 FPS. Expanding never changes the recording resolution, FPS, or editor camera layout.
- Let the user pick the compact size with a bottom-right grip. The window is transparent, so
  macOS gives it no native resize edges; the grip drag goes through the main process as total
  pointer travel, keeps the painted surface 16:9, and stays between the 288 × 162 default and
  the display's work area. Double-clicking the grip restores the default. Remember the size
  across relaunches in user preferences; it is never camera layout.
- Put a Hide control next to Expand, and a "Camera monitor" switch in the Settings panel's camera
  section. Hiding keeps the camera recording and only removes the monitor; the switch is the
  way back. The preference is shared between the HUD and the monitor window through the same
  localStorage, so either side's change reaches the other without a relaunch.

### Notes

- The notes window is a frameless, always-on-top dark card for gathering thoughts while
  recording. It uses as little space as the user wants: one slim strip of chrome above the
  text, a small minimum size, and a remembered frame across relaunches. It stays excluded from
  capture.
- Give the card a mostly opaque dark surface, about 80 percent, over a frosted material on
  macOS. Never a clear pane: notes must stay readable over any screen content, and
  translucency does not give back the screen area the card covers.
- The strip holds a drag handle, play/pause, scroll speed, a chevron that reveals font size
  and mirror, and Close. Nothing else is permanent.
- Text formatting appears on the selection only, as a small bubble menu for bold, italic,
  strikethrough, lists, quote, and code. Markdown shortcuts keep working while typing. The
  menu is absent while the note is locked by playback or mirroring.
- While auto-scroll runs, the chrome fades out so a take shows only text. Hovering the card
  or focusing a control brings it back.

The timer is the total duration of kept completed clips plus the current active clip. It
must decrease immediately after Backspace. If Backspace removes every clip, the timer must
return to `00:00` before Continue starts a new clip.

Removed sections must not appear in editor video or camera playback. Camera media can stay
continuous during capture, so import each kept clip with the camera offset for its physical
capture start, including the durations of earlier removed clips. That shift applies only to one
continuous camera file shared by every clip. When each clip has its own camera file, named after
the clip as macOS records it, the clip's own measured offset is final; shifting it by earlier
clips put the camera tens of seconds out of sync (2026-09-17). Change the in-memory clip
state before awaiting manifest persistence so a simultaneous Stop cannot import stale
removal state.

Persist normal recording setup as app preferences. Restore microphone enabled state and
device, camera enabled state and device, system-audio enabled state, and cursor mode after a
full app relaunch. Validate stored device IDs against current hardware and fall back safely
if a device disappeared. These preferences provide defaults for new projects. Also retain each
project's last source and complete recording setup as local project metadata, separate from
timeline content and Undo. Restore it before opening the pill, including after a restart.
Refresh display identity against connected screens; require source selection if the saved source
is unavailable. Do not silently select another screen or a same-name window. Projects without
saved setup begin from current app preferences. New standalone recordings retain their setup
when imported into their new project.

### Transcript

- A Transcript button next to Notes in the Settings panel opens a read-only floating card,
  the same dark window as Notes and excluded from capture. It transcribes the committed
  microphone clips of the current take on request, newest clips only, with the bundled
  Parakeet v3 Core ML helper; nothing leaves the Mac and no API key exists.
- Refresh only runs while the take is paused or stopped. While a take is live the card says
  so and does nothing, because the helper and FFmpeg would compete with capture.
- Each clip's text is cached in memory and under `userData/transcripts/<recordingId>.json`,
  keyed by clip index and original path, so a second Refresh after one more clip transcribes
  one clip. Removed takes are excluded. Microphone originals are read, never modified.
- Copy puts the whole transcript on the clipboard as plain paragraphs, one per clip, so it
  can be pasted into a chat. The transcript is never written into the project and is not an
  editor feature; captions and cuts stay archived.
- The Parakeet model downloads on first use with progress shown in the card. Intel Macs and
  macOS 13 see one plain message that transcription needs Apple Silicon on macOS 14.

## Editor behavior

Compatibility reference: these controls and mutations belong to existing projects and the
CLI. The recording review surface is read-only and does not expose them.

**Agent global settings and presets:** The agent can inspect every global setting with defaults,
limits, units, and meanings. Setting changes and preset application use guarded plans, verification,
and the same durable undo history. Per-user agent presets extend the visual preset look with camera
layout and automatic-direction policy. The existing UI library stays readable through the editor.
Presets never copy project media or timeline edits. All-clip transcript reads page stored source words
and sentences and identify clips that need transcription.

**Text and B-roll placement:** Agent placement uses edited time or exact transcript words. New
text and B-roll stay as independent overlays through trims and clip swaps; word anchors follow
retained words across source splits. Missing words and spans beyond the edit produce removable
orphan findings. Named anchors use safe margins. Text has a 1.5-second minimum; speech zoom and
camera pieces have a 0.8-second minimum. Plans show overlap findings before guarded apply, and
errors require explicit force. Text styles register card, lower-third, and label layouts; the native
renderer currently shares the card shape. B-roll is silent, supports contain/cover and fade/cut,
and returns cached thumbnails. PNG inputs retain their original and use a persistent video derivative.

**Per-clip camera layout:** A clip can override camera anchor, size, shape, and captions while
unspecified values inherit the project. Named anchors use a safe margin of 4% of the output's short
side by default. Sizes XS/S/M/L/XL mean 14/20/26/34/44 percent. Numeric positions and sizes remain
valid. Splits and duplicates keep the override. Clearing an override restores inheritance. The
agent uses the normal guarded plan/apply path and reports the source layer in state. Per-clip presets
and screen framing fail clearly until the native contract supports those values.

- Camera Emphasis size: an emphasis region's inspector has a "Camera size" choice
  (1.15× to 2×, default 1.35×). Preview, export, the agent operation and the automatic
  direction planner share the 2× ceiling.
- Preview listening level: the transport bar has a speaker button (mute) and a small
  slider. Both are user preferences (`previewVolume`, `previewMuted`), apply to every
  preview media element (screen video, Clean Voice route, music stem) and never change
  an export.
- The first frame of a kept fragment carries no motion-blur velocity: a cut is a jump,
  not a movement, so nothing from the removed footage smears into it.
- Camera region edges that fall within 0.6 s of a cut are drawn on the cut at full
  strength, in preview and export alike. The cut is the transition; a region that begins a
  few frames later would flash the other layout first.

- **Camera drift**: a camera fullscreen or emphasis region may carry `drift {scaleTo, releaseSec}`.
  The camera pushes in slowly (ease-in-out) to `scaleTo` over the region and returns fast
  (ease-out) to normal in the last `releaseSec`, so a full-frame talking take breathes and
  snaps back right before the cut. The web preview and the native compositor share the formula.
- **Video B-roll overlays** (schema 11) sit above the screen layer and its zooms, and below the
  cursor, camera and annotations, for a raw-timeline span anchored to the clip they land on. They
  never carry audio, so narration keeps playing under them. Full-screen is the default; a
  percent box of the screen layer gives picture-in-picture. Fit is cover or contain. Overlays
  reference an imported video asset that stays in place on disk. The agent CLI creates and edits
  them. Show a 66px B-roll lane with source thumbnails directly above the source audio waveform.
  Project its fragments through the same trims and overlay anchors as playback. Clicking or
  keyboard-activating a thumbnail seeks to its visible start. A dedicated overlay inspector is pending.
- Put a compact Preview quality selector below the preview. Sharp is the default and renders
  at display pixel density; Performance uses one render pixel per CSS pixel. Remember the choice
  on this device across projects and app restarts. Change the live preview without restarting
  its decoder or moving playback. This viewing preference does not change saved media, document
  geometry, or export settings.

- Stop opens the editor and its preview. The recording panel does not contain playback.
- Do not show a top-level Record tab. The editor and recording workspace are two states of
  the same project, reached through the normal Record action and Stop or Cancel.
- Every Pause becomes a visible cut boundary between adjacent clips.
- Adjacent clips play without an artificial gap.
- Remove applied `trimRanges` from the visible timeline width. Draw the kept waveform sections
  directly beside each other and put one small scissors marker on the resulting seam. Do not render
  cuts in a detached lane or create new stored clips for each kept section. The marker restores the
  complete coalesced trim as one normal Undoable edit and shows the removed duration in its tooltip.
  Keep the idle marker to a tiny seam notch; expand it into the scissors control on hover or focus so
  a project with many shortened pauses does not become a row of badges.
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
- Recording never splits a clip: the playhead resolves to the nearest clip boundary.
- Save every editor control in the project. New projects start without generated edits, captions,
  framing effects, cursor animation or audio processing. A standalone recording uses the first
  screen source's aspect ratio, with zero padding; insertion into an existing project keeps its canvas.
  Keep reusable presentation preferences, including camera layout, available, but do not apply
  remembered effects, output shape or resolution, captions, gain, or normalization to a new project.
  Existing projects retain their saved settings. Validate the versioned preference
  record before use. Keep a custom uploaded background in its project. Do not put its full data URL
  in browser preference storage; retain the previous reusable color, gradient, or built-in image as
  the next-project default. Do not carry source-specific crops, clips, cuts, zoom regions, caption
  text or translation, or other timeline content into a new project.
- **Camera in review (owner decision, 2026-10-05).** After Stop the camera is a plain
  picture-in-picture rectangle in the camera file's own aspect, uncropped (no focal crop or
  zoom), with square corners. New recordings start with this shape; the remembered camera
  position, size and mirroring still carry over. In the review preview the viewer drags the
  camera to move it and drags the corner facing the middle to resize it, aspect locked;
  hovering shows an outline and that corner. A focused camera moves with the arrow keys; a
  click never takes focus, so Space and the arrows stay playback keys. Moves snap to the
  corners and edges and always keep the default margin (2% of the frame's short side) inside
  the screen. Placement saves into the project and becomes the next recording's default.
  Not editable with a read-only entitlement, while exporting, during playback, without a
  camera, or in a block layout. An older project keeps its stored shape until its camera is
  moved or resized. The camera file's size is stored on the camera track so preview and
  One video export draw the same tile from the full-resolution camera file.
- Let picture-in-picture camera size range from 10% to 80% of the canvas reference dimension.
  Keep the range constants shared by the slider, project validation, reusable preferences,
  preview, and export so a saved large camera cannot shrink after reopening.

- Offer continuous squircle corners on a rectangular PiP camera. Keep source proportions by
  default. Configure the camera aspect ratio separately: source, 1:1, 4:3, 16:9 or 9:16.
  The size control sets the longer side; the aspect ratio sets the other side. Circle and square
  presets keep their established square framing.
- Give the PiP camera its own corner rounding slider, from 0% to 50% of its shorter side.
  Keep circle masks circular and block layouts governed by the shared block framing. Missing
  rounding values preserve existing project geometry. Persist explicit rounding in the project,
  reusable preferences, and the agent CLI. Preview and export use the same native mask and shadow.
- Name Video Effects controls by their scope and show a short explanation below each control.
  Screen corner rounding must be distinct from camera corner rounding.

Version 1 does not show transcript, tail playback, thumbnails, or a review surface in the
paused panel. If real use later proves that Stop → editor → Record is too disruptive, test a
small last-clip review feature then. Do not build it before that evidence exists.

## Pause shortening

> **Archived 2026-10-05.** Pause analysis, proposed cuts, and speech-activity detection were
> removed (tag `archive/pre-cleanup-2026-10-05`). Trims already stored in a project still apply
> in preview and export. The rest of this section describes the archived behavior.

Proposed cuts occupy their own temporary row directly above the clip strip, below zooms,
using the same scroll and zoom coordinates as the other lanes. Each 28 px pill has a
7 px radius, a 1.5 px border, visible edge handles, scissors and saved seconds; narrow
pills show scissors alone, and spans narrower than 14 px use a 3 px marker drawn at
least 14 px wide. Pause, blip, agent and fix use `--editor-accent`, `--annotation`,
`--accent` and `--warn`, with distinct token-based fills. Selected pills are opaque;
deselected pills use 0.55 opacity and strike through the label. A non-interactive
18% wash marks the exact removed span on the waveform. Hover or focus reveals origin,
source range and saved seconds; × appears from 56 px, while Delete/Backspace remains
available at every width. The row has an accessible name and, like adjacent lanes,
no visible lane label (2026-09-18, Task F2).

- **Proposed cuts review lane (2026-09-18):** stage footage removals before committing
  them. Pause/blip analysis, agent trims, and trim fixes share one temporary lane above
  the clip strip. Other edits keep their direct path; agent staging is opt-in.
- Each pill carries its source range, clip, kind, origin and selection. Drag either
  edge within the clip and neighbouring proposals, with a 40 ms minimum length. Show
  the source-time delta while dragging. Keep the waveform visible. Distinguish kinds
  with existing token colours. Arrow keys adjust a focused handle by 40 ms.
- Click a pill body to toggle selection. Its × or Delete/Backspace rejects it. Remember
  rejections per project locally using clip ID and millisecond-rounded source bounds.
  Suppress a future proposal when at least 50% of its duration overlaps a rejected
  range. Show the suppressed count (“3 rejected earlier”). Clear empties the current
  lane without remembering rejections.
- **Accept all (N)** applies selected cuts through the shared pause document patch,
  then clears the lane, as one GUI Undo step and one durable agent history entry.
  Accepting specific CLI IDs leaves other proposals staged. A staged trim replacement
  replaces the original only if that original is unchanged; preview uses the same rule.
- Show pause, blip, agent and fix totals plus origin labels in Audio → Pacing. Repeated
  staging preserves adjusted pills. Switching projects or restarting clears proposals;
  rejection memory survives. Failed analysis preserves other staged proposals.

- Put pause shortening in the **Pacing** section of the right-side **Audio** pane. Do not add a
  separate Pauses facet or hide it in Automatic direction, captions, or the recording HUD.
- Call the action **Shorten Pauses**. Do not promise destructive “silence removal.”
- Analyze cached source observations without changing the project. Show temporary candidates over
  the clip waveform. Let the user preview, select, clear, and apply them.
- Confirmed candidates become ordinary clip-anchored `trimRanges`. Apply one selected batch through
  the retryable document-patch path as one normal Undo step. Do not add a silence-only timeline,
  rendered media, split clip, or permanent analysis lane.
- Speech mode uses the verified sub-megabyte Silero v6.2 model as its primary isolated-microphone
  signal. Run it through the existing whisper.cpp helper without loading the 264 MB caption model;
  cache its 32 ms probability envelope by immutable source identity. Use isolated-microphone energy
  and trusted local word timing (`sourceRole: "you"`, matching asset) as protection. Construct
  permitted windows between adjacent trusted words first: sentence boundaries or word gaps at
  least `minimumPauseSec`. Audio selects the removable interval inside those windows; word
  margins remain protected. Genuine long gaps inside sentences remain eligible. Without trusted
  words on both sides inside the clip, including sparse coverage and clip edges, require complete
  raw/cleaned speech-probability silence. Never widen those unbounded windows using mic quietness
  or a wordless-blip exemption. Missing, truncated or invalid envelopes produce no speech-mode
  proposals. Microphone activity remains protected when no transcript supports a blip.
- A pause is the absence of speech, not the absence of sound. In speech mode a wordless blip is
  a microphone sound of at most 0.5 s between trusted local words that the transcript did not
  hear as a word and no complete speech detector scores at 0.8 or more (a cough, click, breath, or key press). It is part of the pause
  around it. Inside a sentence, a blip of at least 0.15 s becomes its own removal candidate
  (`kind: "blip"`) with 20 ms margins and at least 40 ms of clearance from the neighbouring words,
  and it never crosses a system-audio, screen-activity, or existing-trim protection. "Ignore
  non-speech sounds" owns this rule and is on by default (2026-09-18). Filters stack: dead air
  is the first layer, wordless blips the second; a harsher preset adds layers rather than lowering
  one threshold.
- Audio-level mode is the explicit no-model fallback. It can use adaptive level or a manual dB
  threshold and can disclose when an older file requires the mixed audio track. It intentionally
  has no transcript-first or speech-probability guarantee; select it explicitly.
- Protect isolated system audio and meaningful screen activity by default. Click, mouse-up, drag,
  keyboard timing, and pointer travel above jitter are hard cut blockers. Private input contributes
  timing only and never geometry.
- A silence that touches a clip's start or end is a pause too. Cut a silent lead-in back to the
  `keepBefore` padding and a silent tail down to the `keepAfter` padding, without the interior
  minimum kept-fragment rule on the clip edge. Never propose removing a clip that is silent from
  start to end. The `minimumPauseSec` gate still applies, so short presets catch half-second edges.
- Take-edge dead air is a separate, reversible operation from pause shortening: the agent CLI
  `edges` command trims from the clip start to the first spoken sound and from the last spoken
  sound to the clip end. Complete raw/cleaned speech envelopes and trusted words protect those
  boundaries; trims carry `reason: "edge-silence"`. Internal gaps reuse the speech-mode pause
  planner with `minimumGapSec` (one second by default), edge padding, and blip removal disabled.
  They carry `reason: "gap-silence"`. Mic quietness alone cannot override detected speech.
- An editorial cut inside a take selects a sentence boundary through `cutpoint`. Microphone
  refinement of an out-point must reach the selected word end in one continuous quiet span,
  or start after that end and before the next word. An earlier quiet pocket followed by renewed
  energy is not a verified sentence end. Continuous silence spanning a smeared transcript end
  remains useful. A 0.2 s minimum quiet span filters short dips but does not prove a word ended.
  If audio and alignment disagree, return the conservative transcript fallback with
  `method: "transcript"`; incomplete speech envelopes cannot refine a cut. All methods remain
  estimates that require review against the isolated microphone before tightening real cuts.
- Within a permitted, transcript-bounded window, speech-mode pauses can refine detector tails
  outward over quiet or supported blip frames. Word margins, interior speech islands, system
  audio, screen activity and existing trims stop that refinement. Raw and cleaned protection
  are combined. The `cut.mid-sentence` checker exempts short wordless removals only within the
  same clip, between trusted words, with complete detector silence. Missing words alone do not
  establish safety; the checker still cannot assess speech without usable transcript context.
- A camera-layout region that a trim or clip boundary splits keeps the whole region's ease and
  drift clock on every piece in preview and export. A cut inside a full-frame region must not
  restart the camera animation.
- Keep all pacing and detector values in the typed `PauseAnalysisPolicy`. Presets and live tuning
  must use that policy instead of adding literals to the pane.
- Use the lightweight capped envelope for the visible waveform and a disk-cached 20 ms envelope for
  cut analysis. Keep source media unchanged. Render structural boundaries with the shared 10 ms
  equal-power audio fade.

## Clean voice and noise reduction

- Keep the isolated raw microphone permanent and authoritative. Never replace, rewrite, or delete
  it when cleanup is enabled. System audio is a separate source and never receives speech cleanup.
- Treat **Clean Voice** as a reversible microphone effect. Store a versioned processing recipe and
  disposable derived stem. Keep **Even volume** as a separate dialogue-leveling control.
- Run the main enhancer after recording in a cancelable, restartable background worker. Never run a
  neural enhancer on the ScreenCaptureKit callback, an audio render callback, or the UI thread.
  Pause or cancel optional work when a new recording starts.
- Process each complete original microphone clip in chronological order before timeline trims.
  Preserve model state across the clip. Pad and flush the tail, compensate measured delay, and
  require the result to have the exact source sample count.
- Preview and native export must resolve from the same validated lossless derived microphone stem.
  Preview may build a disposable browser-ready mix from that stem and the untouched system-audio
  bed. Until both required artifacts are ready, the editor remains usable with raw audio. A worker
  crash, model error, bad length, invalid sample, corrupt cache, or thermal cancellation falls back
  to the complete raw clip. Never combine a clean microphone with an unverified partial route.
- Run the pinned Silero detector on raw microphone audio and, when available, the cleaned analysis
  stem. Take the union as speech protection. Either speech envelope can veto a Shorten Pauses cut
  or extend its protected edge. Cleaned analysis alone can never authorize a new cut.
- The explicit **Ignore non-speech sounds** policy may stop an isolated raw microphone-energy
  event from blocking a pause only when raw Silero, cleaned Silero, and the transcript all classify
  the event as non-speech. If cleaned analysis is unavailable, keep the event protected. System
  audio, screen activity, existing trims, and the remaining pause policy stay independent blockers.
- Keep the default conservative and adaptive. Bypass or make a near-null change on a clean source.
  Reduce strength or bypass on overlapping speakers, singing, music bleed, whispers, clipping, and
  intended laughter, applause, keyboard examples, UI demonstrations, or ambience.
- Use one right-side **Audio** pane for the complete creator-audio workflow. Do not add separate
  top-level panes for cleanup, loudness, and pauses. The pane contains three calm sections:
  **Voice** with optional **Clean Voice**, a disclosed **Amount** with a **Natural** default,
  **Even volume**, and a loudness-matched **Original** comparison; **Pacing** with the existing
  **Shorten pauses** workflow; and **Delivery** with optional **Normalize volume**. Keep the
  sections visually flat instead of nesting cards inside cards.
- Keep visible Audio copy short. Put precise definitions and trust details behind accessible
  hover and keyboard-focus info controls. Do not use permanent explanatory paragraphs in the pane.
- Label the default delivery choice **YouTube · -14.5 LUFS** and show the -2 dBTP pre-AAC ceiling
  in its details. This is Klippt's safe YouTube preset, not a claim that YouTube requires one exact
  LUFS value. Offer a **Custom** preset with direct target-loudness and true-peak controls. Keep
  custom loudness between -30 and -9 LUFS and the ceiling between -6 and -1 dBTP. Normalization is
  on by default for the YouTube delivery preset and can be disabled.
  It measures the complete edited program. Clean Voice and Even volume process the microphone and
  remain separate switches. Explain the cleanup trust model with
  `Local · microphone only · original kept`. Do not expose model names or a wall of DSP controls.
- Use DeepFilterNet 3 as the mature reference engine for the first local bake-off. Compare it with
  raw and qualified newer causal 48 kHz candidates on the fixed Swedish/English creator corpus.
  Do not ship an engine until it passes semantic, identity, timing, clean-mic, M5 performance, and
  long-session gates. A newer model does not win by default.
- The development app may expose Clean Voice for explicit user testing through one optional Audio
  control. Its Natural candidate uses a 6 dB attenuation cap. Keep the helper outside normal release
  packages and keep Clean Voice off by default until the labelled creator corpus, commercial model
  licence, decoded-delivery, and long-session gates pass. Keep stronger values in the lab instead of
  silently making the normal voice less faithful.
- Do not use generative speech reconstruction as the normal engine. A cleanup result must never add
  a word, delete a critical word, change the speaker, or make Shorten Pauses less safe.

## Transcript and captions

> **Transcription archived 2026-10-05** (tag `archive/pre-cleanup-2026-10-05`). Klippt no longer
> creates transcripts or captions. Captions already stored in a project, including their settings
> and translations, still render identically in preview and export.

- Show the Captions inspector so users can change the appearance and visibility of
  transcript-derived captions in projects, including projects edited by an agent.
  Captions remain derived from transcript words, rather than separate annotation blocks.
- Show enabled captions as one continuous 28px strip above B-roll and the source audio waveform.
  Do not show disclosure controls or individual cue boxes. Select a position in a cue to seek to
  retained speech and open Captions settings. Keep cue text accessible by keyboard and tooltip.
  Cull offscreen cues and use the same trim mapping as other timeline regions. Cues have no independent drag timing.
- Select an original-language caption to correct its recognized words in the inspector. Save the
  correction as one undoable document edit. Preserve word IDs, timestamps, audio, cuts and translations.
  Invalidate the correction draft when the document or selection changes. Shared source clips use
  the same corrected transcript. Translated captions do not overwrite original speech.
- **Transcript** is the spoken text of the current edit. **Captions** are text rendered on the
  video. Keep these as separate jobs even when both derive from the same clip-scoped word timing.
- Use Parakeet TDT 0.6B v3 through pinned FluidAudio `0.15.6` as the primary Transcript engine on
  Apple Silicon with macOS 14 or newer. It supports 25 languages and exposes 80 ms token timing.
  Refine each boundary only inside half of that timestamp cell against the real 10 ms microphone
  envelope. Do not expose model sampling or timing-grid controls in the UI; caption grouping and
  animation are separate presentation settings.
- Keep the recognizer behind Klippt's existing typed STT contract. Do not let Transcript or
  Captions depend directly on FluidAudio, a Swift helper, or Koett. Klippt may adopt a verified copy
  of the model already present in FluidAudio's shared cache on this Mac, but the product must own
  its versioned model manifest, background job, cancellation, and recovery. A clean Klippt install
  must work without Koett installed. Never trust or mutate another app's cache without validating
  the pinned model identity.
- Keep raw source-time words as the one transcript source of truth. Do not run Parakeet and Whisper
  into two durable transcript copies. Keep Whisper only as a temporary compatibility or measured
  fallback until Parakeet passes word-timing, long-project, packaging, and clean-install gates.
- Preserve the engine boundary and keep Whisper as the compatibility fallback on Intel Mac,
  macOS 13, Windows, Linux, or when Parakeet cannot start. Never mix engines inside one durable
  transcript. Parakeet v2 remains an internal English benchmark, not a second product mode.
- Expose one calm right-side **Transcript** facet before the larger spoken-word editor. Generate its
  data locally after the editor opens or when the user presses **Transcribe**. Never delay Record,
  Pause, Stop, project opening, or basic editing for transcription.
- Put one clear **Copy** action in the Transcript header. It copies plain text in current timeline
  order, excludes removed clips and words inside applied trims, omits internal silence markers, and
  keeps natural punctuation and paragraph breaks between clips. Do not make the user select every
  word or copy from the DOM.
- Keep the first exposed Transcript slice read-only apart from click-to-seek, Transcribe/Retry, and
  Copy. Add text-based removal later through the same normal trim operation and one Undo step. Do
  not expose the inherited content-editable behavior before its interaction is simplified.
- Keep copied text, on-video captions, pause protection, and future text editing on one source-time
  transcript model. Do not create separate transcript copies that can drift.
- Keep Copy feedback quiet and temporary. Add timestamps or copy-format choices only behind a small
  secondary menu after real use proves they are needed.

## Automatic direction

> **Archived 2026-10-05.** The direction engine, automatic zoom and camera suggestions, and the
> CLI export flag that generated zooms at export time were removed (tag
> `archive/pre-cleanup-2026-10-05`). Zooms and camera emphasis already stored in a project still
> render in preview and export. The rest of this section describes the archived behavior.

The agent can run, remove, or regenerate automatic direction through ordinary guarded plans.
The agent uses the same recorded observations and pure functions as the editor. Analysis must finish
before a candidate can remove regions. Missing activity behind existing automatic regions blocks
regeneration. Manual regions, including promoted automatic groups, survive removal and regeneration.
Replies include verification and added/removed region counts by kind; each apply remains undoable.

Automatic direction is a normal editor enhancement. It is not an AI mode and does not add a
second timeline model.

- Import recordings without running automatic direction or microphone analysis. Preserve source
  observations so **Apply automatic edits** can generate editable regions later. Changing a tuning
  control before the first application only saves its policy. Once automatic regions exist, live
  tuning can regenerate them. The agent CLI was archived on 2026-10-05.

- The Automatic pane groups generated regions for review. Show the saved trigger reason and
  edited-playback time, with jump, Adjust, Keep and Remove actions. Older projects without saved
  evidence must say that the trigger was not saved. Never invent a reason from the effect type.
- Keep promotes the complete group to manual ownership. Remove stores exact-effect exclusions
  before removing the group. Regeneration preserves manual work and filters excluded suggestions.
  Exclusions use clip/source milliseconds and authored framing, independent of generated IDs and
  clip placement. Different timing or framing can create eligible suggestions. Allow dismissed
  effects again clears these exclusions; it does not regenerate implicitly.
- Bulk review saves one edit. Review uses the latest document, rejects stale project actions, and
  cancels queued tuning before a review change. Project switches reset the complete tuning session.

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
- Apply explicit enhancements through the retryable project document-patch path. Rebuild the patch
  from the newest document after a concurrent edit and report a real conflict. Keep generation
  undoable separately from recording import. Never use a fire-and-forget stale document save or
  silently drop a valid automatic result.
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
- Rank all candidate moments together. Spacing is the primary limiter, with a 1.5-second quiet
  gap between separate passages. The per-minute count is a safety net at twelve for both screen
  zooms and combined screen/camera direction. Click bursts that keep attention in one area within
  six seconds join one held passage, including a burst that ends with a short drag whose release
  stays inside the frame. Leaving the framed area ends the passage. Do not add an effect for
  every click.
- Vary focus, duration, and scale with the interaction. Do not apply one fixed zoom to every
  generated region.
- Store every result as an ordinary clip-anchored zoom region with `source: "auto"`. The user
  can resize, move, focus, copy, delete, Undo, and Redo it with the normal editor actions.
- Show every ordinary Zoom and Camera Emphasis region directly on the timeline. Do not replace
  real regions with an **Automatic direction** summary pill. Keep `directionGroupId` as internal
  ownership and regeneration metadata. Render only effect lanes that contain regions, and keep
  Zoom closest to the clip row.
- Show camera entrance and exit phases inside the camera timeline pill. Derive their bounds from
  the same per-visible-segment timing used by the renderer, including trims and playback speeds.
  Instant has no transition bands. Existing region move/resize handles remain the edit controls.
- Camera Emphasis and Full Camera must start and end at the actually displayed PiP rectangle,
  including any reactive screen-zoom scaling. Never switch reactive scaling off at the first
  positive animation progress. Full Camera still reaches the complete output canvas.
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

- **Save video** opens the export dialog. **Separate takes** is the fresh preselected choice;
  remember the last explicit output choice. **One video** remains the other choice and uses
  the source-quality MP4 preset in recording review. **Original files** retains recovery access.
- An explicitly source-preserving export of full-span screen clips with identity geometry, baked
  cursor, matching dimensions/codec and compatible audio may copy its encoded packets. Takes
  split by Pause join in order when every take is complete and all share one stream format;
  joined audio is re-encoded once so it stays in sync across the joins. Keep the original frame
  cadence and timestamps; do not promise conversion to a selected constant frame rate.
  Rendering settings apply only when this explicit path falls back to rendering. Verify the
  staged MP4 before atomically publishing it. Camera, edits, trims, effects and audio mastering
  continue through the existing renderer.
- One video in recording review shows no format choices. It states the fixed output (MP4 at
  recording quality and size) and labels progress as saving. The copy path reports one bar
  across copying the recording and reading the copy back. A space failure names
  the space needed and available. The copy reserves the MP4 index at the front, so it is
  written once.
- Closing export leaves it running. Reopening displays active progress; a later Save after
  completion starts a fresh export instead of reusing a previous recording's success state.
- Separate takes copies the kept clips' complete original screen, camera, microphone and
  system-audio media into a new folder, byte for byte. Number each clip's files together. Omit
  removed clips and preserve hidden camera originals. Do not remux, extract tracks, decode,
  trim or encode during this handoff. Legacy embedded-only audio stays in its complete original
  container with an explicit limitation warning; do not pretend it is a new isolated source.
  Untagged audio is labelled audio, never guessed to be microphone.
- Include `timeline.otio`, an importable 60 fps source timeline with retained spans, take order
  and camera synchronization. Use Screen V1, Camera V2, Microphone A1 and System audio A2.
  Separate original audio files go on audio tracks; do not duplicate embedded mixed audio. Untagged audio
  gets an additional Original audio (unidentified) track. Preserve absent or short streams as
  gaps, and bound camera source time after applying its offset. Round shared cumulative cut
  boundaries to the timeline frame grid; do not accumulate a rounding error per cut. Use relative
  media references so the folder can move. Keep exact source offsets in OTIO metadata; cuts and
  synchronization are also described in `handoff.json`, alongside unchanged media files.
  Whole source files retain material outside partial trims. Camera remains a full separate layer;
  captions, layouts, editable cursor overlays, speed changes, B-roll and audio processing are not
  transferred. Say this on the export surface and in the handoff. DaVinci Resolve is the first
  verified interchange target; keep the export labels editor-neutral.
- Separate takes handoff v4 names media `<take>-<sha1(assetId)[0:8]>-<role>.<ext>`;
  dialogue derivatives use a unique export id. OTIO and FCPXML clip names identify take,
  role and source range; OTIO metadata and manifest edit maps share the same frame plan.
  Source seconds are half-open screen-clock ranges; stream frame fields describe actual
  quantized media reads. Explicit offsets follow `streamTimeSec = screenTimeSec - offsetSec`.
  Keep camera start/offset milliseconds, file bytes/SHA-256, ffprobe stream facts, full/clean
  per-track edits, removed-range marker text, available transcript words and active dialogue.
  Copy cursor JSON unchanged and decode its embedded PNG assets into a per-take folder.
  Declare capture mode from the matching recording session, or unknown; missing telemetry
  is explicit. Cursor coordinates are normalized, top-left; hotspots use image pixels.
  Native sidecars already remove pre-roll/pauses and rebase clips: screen seconds = timeMs/1000.
  Clean dialogue reads `round((screenTimeSec - microphoneOffsetSec) * 48000)` samples,
  preserving frame-planned lengths and keeping sub-frame offsets out of video quantization.
  Contracts checked against [OTIO metadata](https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-file-format-specification.html)
  and [ffprobe stream output](https://ffmpeg.org/ffprobe.html); originals remain unchanged.
- A Clean cut source export with an isolated microphone also writes derived
  `clean-dialogue.wav`: 48 kHz, 24-bit, original channel count, exact frame-planned
  duration. Soft audio joins may shift within half a video frame; video cuts stay
  fixed. Handles may borrow only within the project's retained source ranges;
  project trims use short fades without restoring removed material. Only the
  clean-cut OTIO adds Clean dialogue and disables the replaced microphone clips.
  System audio and the full timelines stay unchanged. Missing isolated microphone
  audio produces a warning, never a stem from embedded mixed audio. Original files
  remain byte copies; the manifest labels the stem as derived. There is no clean-cut
  FCPXML or in-app soft-join playback parity in this slice. Resolve's handling of
  disabled clips still requires import verification.
- Beside `timeline.otio`, write `timeline.fcpxml` (FCPXML 1.10) for Final Cut Pro from the same
  frame-grid plan, never a second sync calculation. Screen clips and gaps form the primary storyline; camera
  connects on lane 1, microphone on lane −1 (dialogue role), system audio on lane −2 (effects
  role) and unidentified audio on lane −3 with no guessed role. Each connected clip anchors to
  the storyline piece holding its first frame. Times are reduced rational seconds of whole 60 fps
  frames. Screen and camera use video only, so embedded audio is not doubled. Media links are
  `./`-relative to the file. Premiere Pro 25.6 and later are reported to import `timeline.otio`
  and not FCPXML, so Premiere gets no third file. Neither editor import is verified yet.
- Source handoff shows indeterminate Saving feedback, never a fabricated percentage or stale
  render progress. On success, keep the folder action visible and show a warning count with
  keyboard-operable disclosure of every warning; announce completion without reading the full list.
- Source handoff uses the native folder picker, existing media grants and a fresh unique folder.
  Use native APFS cloning on macOS for independent local copies, with ordinary copying on
  unsupported or different filesystems. Never hard-link originals or overwrite an existing file.
  Write the completion manifest last and clean up an incomplete handoff on failure. Source
  recovery is always available.
  Use editor-neutral UI labels; do not name an external editor as a product requirement.
- While a source picker or source copy is pending, disable project replacement through Record,
  library navigation, File/Open and shortcuts. Release the lock after the operation settles.

- On Retina Macs, capture the best available backing-pixel resolution. Do not silently record
  the logical point size. Use ScreenCaptureKit's pixel scale and best-resolution controls, with
  an explicit lower-resolution option only when the user chooses speed or smaller files.
- Output shape and output resolution are separate controls in the right-side **Layout** pane.
  A new recording starts with an unpadded source-shaped canvas; an empty project falls back to 16:9.
  The editor offers 16:9, 9:16, 1:1, 4:3, 4:5, 16:10,
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
- Apple's H.264 encoder stops at 4096 pixels on either side. A rendered export larger than that
  is written as HEVC instead of failing.
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
- Export runs in the background. Closing the export window, Escape, or the backdrop never
  cancels a running export; only the explicit Cancel export button does. While a file renders,
  the Export button in the top bar becomes the progress readout (same footprint, monochrome fill
  and baseline, percent, time left in the tooltip) and clicking it reopens the export window.
  Editing continues meanwhile; the running export keeps the timeline as it was when it started,
  and the window says so. Completion and failure use the existing toasts; reopening the window
  after completion shows the saved file action, after failure the error with retry.
- Remote export must run the same versioned project renderer, not a generic transcoder. Do not
  build cloud or LAN offload until a headless worker can package the project, referenced media,
  fonts, and assets and reproduce the local output deterministically.

## YouTube-ready audio and delivery

Klippt must export a file that Olle can upload without a separate audio-mastering step.
Keep capture media recoverable and non-destructive; do not permanently bake loudness changes
into the raw clips.

- Preserve microphone and system audio as separate source tracks or stems. Current Mac clips keep
  a mixed preview track plus tagged isolated microphone and system tracks. Use the isolated tracks
  for cleanup, dialogue leveling, system-audio ducking, and later mix correction.
- After a clip finalizes, analyze its spoken dialogue asynchronously. This work must never block
  Pause or Continue. Use ITU-R BS.1770 loudness and true-peak measurement, ignore silence and
  room tone, cap automatic gain changes, and store the result as editable project metadata.
- Make dialogue sound consistent across adjacent clips. Do not independently normalize each
  whole clip to one peak or LUFS value because short silence and low room noise can be boosted
  into audible jumps at every cut.
- After cuts, speed changes, voiceovers, microphone gain, and system-audio mixing are applied,
  measure and master the complete edited program. `Normalize volume` is one simple export option
  and is on by default. The YouTube preset aims for -14.5 LUFS integrated with a -2 dBTP ceiling
  before AAC. This is a Klippt mastering default, not an official YouTube upload rule. **Custom**
  can use -30 to -9 LUFS and -6 to -1 dBTP. Preserve dynamics and accept a quieter result when the
  selected target would need more than 3 dB of limiting or more than 12 dB of gain. Use a
  transparent true-peak limiter only where needed. Let the user disable normalization.
- Automatic system-audio ducking under speech can follow the first mastering slice. Keep it
  subtle and reversible.
- Export normal YouTube audio as 48 kHz stereo AAC-LC at 384 kbps. Show measured input loudness,
  output loudness, true peak, decoded AAC true peak, and any warning that prevented safe
  normalization.
- Export a standard MP4 with Fast Start, H.264 progressive 4:2:0 video, the recorded frame rate,
  explicit BT.709 SDR color metadata, and the selected real output bitrate. Verify High Profile,
  GOP, B-frame, and container metadata from the saved file instead of assuming encoder defaults.
- Persist the user's normal export choices. A later direct YouTube upload action must first save
  the local MP4, use OAuth and a resumable upload, show progress and retry state, require title,
  description, and privacy, and default to Private or Unlisted. Never publish by surprise.
- Restore the last export format, quality, frame rate, codec, volume-normalization choice, and GIF
  options when the export dialog opens again.

## Visual direction

Swapping B-roll media keeps its existing slot, placement, clip, opacity and motion.
Automatic size fit uses cover within 8% of the slot aspect, otherwise contain; an explicit
fit overrides this choice. Automatic length fit shortens the end when the source is too
short, or leaves unused source tail when it is longer. Explicit hold keeps the final frame
without changing media speed. The reply reports both choices and any shortening.
Shortening an edited/word-anchored slot awaits a timing-policy decision; hold and swaps
that fit the existing span preserve its anchor.

Aim for Screen Studio-level refinement, not a pixel copy.

- Do not use decorative middle-dot or bullet separators in product labels, headings, tooltips,
  or metadata. Use plain labels, normal sentence punctuation, or separate fields with spacing.
  Keep Review effects as a plain heading without a redundant count.

- Inspector navigation uses the existing Radix components with visible names and keyboard
  navigation. Selected tools use fill and text, never a tiny selection-edge border. Keyboard
  focus remains separately visible. Narrow windows move secondary toolbar actions into More actions.
- Side panels group related tasks rather than stacking all controls. Layout separates Canvas,
  Screen and Camera; Audio separates Voice, Pauses, Music and Delivery. Switching those sections
  preserves drafts and uses the existing Radix keyboard/selection behavior.
- Caption word correction keeps stable timed words in a compact editable sequence. It does not
  insert words or change timing. Transcript text breaks at recorded pauses for readability.
- Use compact shared field rows and contextual help. Do not show a choice section with only one
  available option, or an inactive automatic-tuning form when recording evidence is unavailable.
- Use one shared switch across inspector and export controls: a fixed 36×20 track, a 24px-high
  click area, and a visible thumb in both themes and states. Use the shared row-height token;
  panel-specific button styles must not resize switches.
- Keep Saved/Unsaved beside the project name. Shared numeric controls permit exact text entry;
  Enter or blur commits valid values, Escape restores the value, and invalid drafts show a local error.
- Automatic review confirms actual saves and clears stale success after Undo. Advanced tuning
  follows the review behind a disclosure. Export completion prioritizes Show in folder and Close;
  failure retains export choices for retry.

- The production logo is the **A2 mark**: three separate tapered arms with broad rounded heads
  and sharper inner tails in exact rotational balance around one open center. Build it as original
  controlled vector geometry, not a raw generated-pixel trace. Keep the silhouette calm and fluid,
  preserve clear gaps at 16/24/32 px, and do not add an enclosing ring, thin blades, or a generic
  spinner treatment. `design/assets/klippt-mark.svg` is the single source of truth. Run
  `npm run assets:brand` after any geometry change instead of editing raster icon files by hand.
- Use Screen Studio's broad professional-editor structure and calm density as a quality
  reference.
- Create original tokens, colors, icons, motion, copy, assets, empty states, and branding.
- Use the free-standing Klippt mark without a plate for in-app identity and the macOS menu bar. The
  Dock icon is the deliberate exception: put the graphite mark on one calm `#f2f1ee` squircle so it
  reads as a native app icon. Keep the macOS menu-bar mark as a monochrome 16 px template image with
  a transparent 32 px `@2x` companion; an opaque background becomes a solid status-item square.
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
- Offer named visual presets in the editor toolbar. A preset coordinates background, padding,
  screen and camera corners, shadow and caption appearance as one undoable edit. Preserve output
  geometry, camera placement and size, caption visibility/language, audio and timeline content.
  Store up to 20 named presets locally. Custom file backgrounds cannot be saved in reusable presets.
- Use restrained material/blur only for floating surfaces and window chrome.
- Keep canvas, inspector, and editor timeline mostly opaque for contrast and performance.
- Use one icon family and one token system for spacing, type, radii, color, shadows, and
  motion.
- Use `AppSelect` for production option menus. Do not add raw HTML `select` controls to the React
  app: macOS renders their popup outside Klippt's theme and can leak the system accent color. The
  shared trigger and popup use graphite surface tokens and the muted steel-blue editor selection
  tokens. Green remains only for transient success and live audio state.
- Use one continuous surface for dense inspector settings. Ordinary toggle rows and sliders
  must not become cards inside the inspector. Keep bordered tiles only when the tile is the
  actual option, such as a cursor theme or camera shape.
- Prefer low visual weight over artificially tiny controls.
- Keep controls reachable with keyboard and VoiceOver. Support Increased Contrast, larger
  text, and Reduce Motion.
- Never sacrifice recording reliability for animation or glass effects.
