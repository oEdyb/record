# Klippt product plan

- Status: active
- Date: 2026-08-22
- Product source of truth: [`AGENTS.md`](AGENTS.md)
- Upstream historical roadmap: [`ROADMAP.md`](ROADMAP.md)

## Product decision

Klippt is a proprietary, Mac-first, clip-native recorder and editor. Its current private repository
remains `github.com/oEdyb/record` until the compatibility-safe rebrand. It is not an
OpenScreen distribution, a generic AI editor, or a cross-platform project for the current
release.

The first commercial release is a subscription-first paid private alpha. One Klippt Pro
entitlement covers the full product, with monthly and annual prices. Keep payment and license logic
behind a small provider adapter. Lemon Squeezy is the current fastest candidate, but the provider is
not selected until the store, prices, trial behavior, and public product identifiers exist.

The core workflow is:

> Record in clean clips, remove bad clips while recording, then return to a polished first edit.

The product promise is:

> Record once. Keep every source. Fix the edit afterward. Export for any platform without
> needless quality loss.

Automatic direction supports this workflow. It does not become a second product, a second
timeline model, or a reason to delay recording reliability.

Klippt is also agent-native. The UI, CLI, and future agent bridge must operate on the same
versioned project model and the same editing commands. An agent can inspect, edit, validate, and
export a project without opening the full UI, but it never gets a separate hidden timeline or an
unsafe media-mutation path.

## Delivery rules

1. Keep the Electron, React, Swift ScreenCaptureKit, and Rust compositor architecture. Do not
   rewrite the app in Swift.
2. Keep source media non-destructive. Store edits, framing, camera layout, cursor treatment,
   audio treatment, and output shape as project data.
3. Keep capture settings separate from export settings. Capture protects the editable master.
   Export creates a delivery file.
4. Keep one project and one clip order. YouTube, TikTok, and square outputs are delivery
   variants of that project, not duplicate projects.
5. Keep automatic direction deterministic, local, editable, and regenerated through one
   versioned plan.
6. Use normal recording language. Use **clips**, never “takes” or a “redo take” workflow.
7. Make every important edit available through one shared command service used by the UI, CLI,
   and agents. Keep commands deterministic, machine-readable, undoable, and safe for source media.
8. Ship by evidence gates, not feature count or estimated calendar time.

## Current baseline

| Capability | Current state | Main gap |
| --- | --- | --- |
| Clip-native recording | Working on Mac: Pause, Continue, Remove previous clip, Stop, editor insertion, Undo, and Redo | Long-session and failure recovery gates |
| Editable source capture | Screen and camera are separate. Mac clips contain a mixed preview track plus tagged system-audio and microphone tracks. Cursor and safe keyboard telemetry are sidecars | First-class source-track model, raw export, recovery inventory |
| Automatic direction | Deterministic click, drag, typing, cursor, and Camera Emphasis engine; exact Scale control; protected user corrections; direct editable timeline regions; simplified inspector | Tune only from labelled real-use failures; do not add detectors now |
| Preview and export | Shared native scene contract and hardware paths on Mac | Full long-video delivery validation |
| Export quality | MP4/GIF, H.264/H.265, 24/30/60 FPS, 1080p/2K/source tiers, estimated size, and audio normalization exist | Capability-based advanced controls, manual/CQ rate control, ProRes/AV1 decisions |
| Output shapes | One Layout pane controls presets, original shapes, custom pixels, camera composition, and block order across preview and export | One-project delivery variants, editable pane proportions, and automatic vertical reframing |
| Transcript editing | Large inherited feature set exists | Product focus, custom vocabulary, and a simple spoken-word workflow |
| Presets | Recording and editing preferences persist | Named, reusable recording/style/delivery presets |
| Agent workflow | Record, Sources, Info, Pack, Captions, and legacy/current project Export CLI paths exist | Complete inspect/edit/validate command surface with UI parity, dry runs, revisions, and agent-safe transactions |
| Project format | `.klippt` is canonical across storage, dialogs, drag-and-drop, and CLI; legacy `.openscreen` and `.axcut` files remain readable and are copied forward without deletion | File-association handoff and broader real-project migration testing |
| Distribution | Klippt name, icons, in-app identity, package display name, and monochrome visual system are implemented while current user data stays in the legacy location | Developer ID signing, notarization, update channel, entitlement activation, and legal/support pages |

## Gate 0 — protect the product before more code

This gate comes before the next implementation change.

At the start of this gate, the repository had 172 changed tracked files, 66 untracked files,
about 13,478 added lines, and no private `origin`. `main` still pointed at the unchanged upstream
commit. Most of the product existed only in that working directory. The private destination is
`github.com/oEdyb/record`; the gate is complete only after the reviewed source is committed,
pushed, and tagged there.

Actions:

1. Choose a private Git remote owned by Olle.
2. Review ignored files and scan the pending tree for credentials, generated media, native build
   output, and local recordings.
3. Create an intentional known-good checkpoint without flattening unrelated work.
4. Push the checkpoint to the private remote.
5. Tag the verified state so later direction experiments have a recovery point.

Exit criteria:

- A fresh clone can build the same app from the checkpoint.
- The private remote contains all required tracked source files.
- No credential, recording, cache, or generated binary enters the repository by accident.

## Slice 1 — finish automatic direction as an editor feature

**Status: complete on 2026-08-20.** Freeze new detectors and policy experiments unless labelled
real-use evidence shows a specific failure.

Real-use correction on 2026-08-20: keyboard privacy now uses the focused Accessibility process.
A broad editor target whose center overlaps the floating camera monitor no longer removes a real
typing session from automatic direction. A renewable typing chain now remains one focused local
passage without forcing unrelated later cursor chains into the same shallow crop. The repaired
project frames its lower-right writing area at 1.475x from 22.349 to 40.262 seconds.

### 1A. Replace the false Zoom-level control

Problem:

- The renderer uses `customScale` when present.
- The inspector displays and edits `depth`.
- An automatic Zoom can render at 1.52× while the control claims that another level is active.

Implementation:

1. Use `effectiveZoomScale(region)` as the only value shown to the user.
2. Replace the depth dropdown with a real Scale control and exact numeric value.
3. Add one `updateZoomScale` editor action. It writes the rendered scale, not an inert preset.
4. Keep `depth` only as a backward-compatible fallback for old documents and agent tools.
5. Make the timeline label, inspector, web preview, native preview, export, and agent snapshot use
   the same scale resolver.
6. Default automatic Zooms to a 1.65× maximum. Let the project Max Zoom control expand the
   automatic depth profile up to the shared 5× renderer limit. Cursor safety can still reduce or
   omit a requested crop. Preserve valid deeper manual values from old projects.

Acceptance tests:

- An auto region with `depth: 3` and `customScale: 1.52` shows 1.52×.
- Changing the control to 1.60× changes preview and export to 1.60×.
- A depth-only legacy region shows its true mapped value.
- Save, close, reopen, Undo, and Redo preserve the rendered value.

### 1B. Give automatic passages stable ownership

Problem:

- Regeneration removes every region that still has `source: "auto"`.
- User edits do not consistently promote that work to manual ownership.
- The detector has a sequence identity, but the timeline conversion drops it.
- One connected visual passage can contain several focus regions, so promoting one stored row is
  not enough.

Implementation:

1. Preserve a stable `directionGroupId` from the automatic plan into every screen and camera
   region created for that visual passage.
2. Add one document-layer operation that applies a user edit and promotes the complete group to
   `source: "manual"` atomically.
3. Route all user edits through that operation:
   - timeline move and resize;
   - preview focus drag and focus reset;
   - Scale;
   - Fixed or Follow Pointer;
   - motion style and speed;
   - 3D tilt;
   - copied attributes;
   - Camera Emphasis duration and motion controls.
4. Keep deletion simple. A deleted region does not need promotion.
5. Make regeneration remove only untouched automatic groups.
6. Keep the promotion and the requested edit as one Undo step.

Acceptance tests:

- Each editing action promotes the complete connected group.
- Regeneration preserves every promoted group and replaces every untouched group.
- Editing one fragment across a clip boundary promotes all fragments in the group.
- Undo restores the pre-edit automatic group. Redo restores the manual group and the edit.
- Save and reopen preserve group identity and ownership.

### 1C. Make the timeline calm

Keep ordinary Zoom and Camera Emphasis regions as the data model. Change only their default
presentation.

Implementation:

1. Show every actual Zoom and Camera Emphasis region directly. Automatic and manual edits use the
   same interaction model.
2. Keep Zoom closest to the clip row. Show Camera Emphasis in its own lane when it exists.
3. Hide each effect lane when it has no regions. Do not show empty standing strips.
4. Show the exact rendered Zoom scale on regions that have enough width for a label.
5. Keep `directionGroupId` as internal ownership and regeneration metadata. Do not turn it into a
   summary region or a second timeline model.
6. Make real effect regions large enough to select and resize without inflating their duration.
7. Do not add another permanent row, mode, wizard, or automatic-editing dashboard.

Acceptance tests:

- A connected four-target pan appears as four directly editable Zoom regions.
- Automatic and manual regions use the same move, resize, select, and delete actions.
- The timeline does not show an **Automatic direction** summary pill.
- Empty effect lanes do not take vertical space.
- Trimmed and split clips show the same real regions that preview and export render.

### 1D. Simplify the inspector

Primary Zoom controls:

- Scale, with the exact rendered value;
- Framing, edited directly on the preview;
- Tracking: **Fixed** or **Follow Pointer**;
- Duration.

Advanced controls:

- motion style;
- motion speed;
- 3D tilt.

Camera Emphasis keeps its own camera size, duration, motion style, and speed. Screen Zoom and
Camera Emphasis never share a hidden motion value.

Exit criteria for Slice 1:

- The editor never displays a Zoom value that differs from preview or export.
- Regeneration cannot remove a user-corrected automatic passage.
- The default timeline shows deliberate automatic passages, not detector internals.
- A user can correct scale, framing, tracking, and duration without opening Advanced.
- The existing automatic-direction regression suite stays green. Add interaction coverage for all
  ownership paths.

## Gate 2 — complete: prove the recording-to-upload path

**Status: complete on 2026-08-20.** The fixed requirement for three additional production videos
is retired. Normal creator use remains useful evidence, but it is not a gate.

After Slice 1, freeze automatic-direction work again. Use the app for complete videos.

Required path:

1. Record several clips.
2. Pause and Continue several times.
3. Change a source or device while paused.
4. Remove a bad previous clip while recording.
5. Stop and return to the same project.
6. Split, remove, reorder, and record into the middle.
7. Undo and Redo each structural edit.
8. Export one 30–60 minute technical video.
9. Upload it as an unlisted YouTube video and inspect text sharpness, motion, audio, sync, and
   processing results.

Implementation status on 2026-08-19:

- The editor has a true Split action at the playhead. The left half keeps its identity, the right
  half gets a new identity, and attached trims, Zooms, annotations, speed regions, Camera Emphasis,
  and transcript word references stay with their source media.
- Split, remove, reorder, clip source-range changes, and record-in-the-middle placement use normal
  Undo/Redo history. Record waits for an in-flight structural edit before it reads the insertion
  point.
- Split remains disabled as a no-op until a newly imported clip has a real probed duration. This
  prevents placeholder source ranges from becoming permanent.
- The first Mac recovery slice is implemented. Native capture writes fragmented MP4, journals the
  active and finalized clips atomically, reports helper and ScreenCaptureKit failures once, and
  restores the latest readable interrupted session into the editor after restart. A late Stop uses
  the helper's cached result, and a missing active tail is recovered from the readable fragment.
- Capture now requires a synced initial recovery journal before it starts the native helper. JSON
  state uses a synced temporary file, atomic rename, and POSIX directory sync. Remove Previous Clip
  commits its recovery state before it reports success and rolls back in memory if that write fails.
  Recovery never resurrects an all-removed schema-2 session. A stale journal can discover any
  nonempty exact-name later clip for the editor's real media probe, but it ignores removed indices
  and symlinks.
- Recovery import probes the real duration before it writes the asset or timeline. The durable
  journal is removed before the in-memory handoff reports success, so a failed cleanup remains
  retryable instead of creating a duplicate import. Closing or reloading the recording window
  finalizes without discarding the recovery journal.
- The production CLI now opens both legacy and current versioned projects. Current multi-asset
  projects use the normal visible-clip, trim, crop, speed, Screen Zoom, Camera Emphasis, camera-link,
  scene, and native export paths. CLI project output uses file sync plus atomic rename before it
  consumes recording recovery state. CLI startup cannot claim an interrupted GUI recording.
- A repeatable isolated Mac soak records through the production CLI, validates every source track,
  decodes start/middle/end checkpoints, exports through the native compositor, and validates output
  duration, progressive video, audio, A/V drift, and Fast Start. Harness cleanup requires a private
  ownership marker, so `--resume` cannot remove an arbitrary directory.

Evidence on 2026-08-19:

- A 30-minute source completed at 2560×1440. The 4.36 GB source contained H.264 video plus two
  tagged 48 kHz stereo AAC tracks. Start, middle, and end decode checks passed.
- Native export produced a 2.75 GB, 30-minute progressive H.264 MP4 in 17 minutes 37 seconds, or
  0.587× real time. The result had 48 kHz stereo AAC, 16.7 ms A/V duration drift, Fast Start, and
  successful start, middle, and end decode checks. The machine-readable report is
  [`test-results/gate2-macos-soak-2026-08-19T15-21-26-841Z.json`](test-results/gate2-macos-soak-2026-08-19T15-21-26-841Z.json).
- A forced SIGKILL left a readable 29-second fragmented MP4 with both isolated audio tracks. The
  next normal launch found the journal, restored one exact-duration clip into a current project,
  removed the journal only after import, and exported that recovered project successfully.
- A fresh post-fix built-app smoke passed the same capture and export validation. The report is
  [`test-results/gate2-macos-soak-2026-08-19T16-15-01-691Z.json`](test-results/gate2-macos-soak-2026-08-19T16-15-01-691Z.json).
- A forced exporter SIGKILL at 5.6% left an incomplete 48-byte output but did not change the
  project or source. A clean retry to the same path replaced it with a validated 20.166-second
  Fast Start MP4 with 16 ms A/V drift. The report is
  [`test-results/gate2-macos-soak-2026-08-19T16-19-01-989Z.json`](test-results/gate2-macos-soak-2026-08-19T16-19-01-989Z.json).
- Injected `ENOSPC` tests prove that capture does not start without its recovery anchor and that a
  failed Remove state write does not delete the clip from the session. Recovery tests cover stale
  journals, short nonempty fragments, all-removed sessions, planted symlinks, and durable cleanup.
  A fresh built-app capture/export passed after these changes. Its report is
  [`test-results/gate2-macos-soak-2026-08-19T16-36-19-300Z.json`](test-results/gate2-macos-soak-2026-08-19T16-36-19-300Z.json).
- Automated verification passed 191 test files with 2,210 tests and one skip, both TypeScript
  targets, production web/Electron builds, all 12 locale checks, docs, Biome, diff checks, and an
  independent review with no Critical or Important finding. TestSprite was not used.
- A real existing two-clip project exported 96.483 seconds at 2560×1440 and 60 fps. The first
  export exposed a normal-use audio defect: fixed-gain normalization stayed at −19.83 LUFS because
  short peaks exhausted its headroom. Export mastering now uses bounded make-up gain, a
  stereo-linked 5 ms look-ahead limiter, EBU R128 measurement, and AAC safety headroom. The final
  encoded file measured −14.22 LUFS and −1.81 dBTP, kept 16.3 ms A/V drift, and decoded fully.
  Limiter memory is fixed-size rather than proportional to video length. All 146 compositor tests,
  the release Mac addon build, the exact real-project export, and focused independent review passed.
- A fresh 70.933-second real project exported at 2560×1440 and 60 fps, decoded fully, passed
  YouTube's checks, and played cleanly at 1440p as an Unlisted upload:
  https://youtu.be/CxmEKARSZ7g.

Gate 2 is complete. The structural editing path, durable recovery, forced-kill recovery,
30-minute capture/export soak, real-project audio mastering, full real export, and Unlisted YouTube
inspection provide the required proof. No fixed quota of additional production videos remains.
Do not block the creator workflow on an exhaustive synthetic device-failure matrix. Add more
failure tests only when normal use exposes a real defect or before a release boundary that needs
that specific guarantee.

Later hardening backlog, not a Gate 2 blocker:

- ScreenCaptureKit or helper failure;
- app or helper crash;
- sleep and wake;
- display disconnect or geometry change;
- microphone or camera disconnect;
- permission loss;
- low disk space and failed finalization;
- interrupted export;
- reopen after an incomplete recording.

Measure:

- Pause finalization p50 and p95. Keep the existing local-SSD p95 target below 300 ms.
- dropped or duplicated video frames;
- A/V drift at the start, middle, and end;
- missing or stale camera offsets;
- recovery result for each failure;
- manual corrections per minute for automatic direction;
- export wall time and output size.

Exit criteria:

- Three real complete videos finish without lost kept media.
- One Undo removes one recording import without removing unrelated edits.
- The final H.264 MP4 uses progressive video, Fast Start, 48 kHz AAC-LC, and the recorded frame
  rate unless the user explicitly changes it. These settings follow YouTube's current upload
  guidance: [YouTube recommended upload encoding settings](https://support.google.com/youtube/answer/1722171).

## Phase 3 — ship a safe Mac alpha

1. Finish the Klippt compatibility migration. Visible names, icons, package display name, the
   monochrome product chrome, and the `.klippt` project format are implemented. Keep current bundle
   IDs, helper names, user data, and permissions stable until a tested migration and rollback exist.
   Add the `.klippt` Finder association only with complete launch and second-instance file handoff.
2. Hide AI chat, model providers, translation, advanced caption work, direct YouTube upload,
   Windows/Linux controls, and the large media-library surface from the normal product path.
3. Keep the underlying inherited code isolated until removal is safe. Do not mix it into the core
   workflow.
4. Add release build checks for every bundled helper and native library.
5. Sign with Developer ID, enable Hardened Runtime, notarize with `notarytool`, staple the ticket,
   and verify on a clean Mac. Apple requires signed, hardened software for normal outside-App-Store
   distribution: [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
6. Add a private alpha update channel and crash-report export that does not upload project content
   without consent.
7. Add one Klippt Pro entitlement behind a provider adapter. Store the local activation with
   `safeStorage`. Allow a bounded offline grace period. Never put a provider secret in the app,
   and never let a network failure interrupt active capture or export.
8. Publish short privacy, terms/EULA, refund, and support pages before accepting payment. Review
   the generated production dependency inventory and every bundled asset at the same release gate.

## Phase 4 — complete the editable master

The master does not need to be uncompressed. “Pristine” means that source roles remain separate and
re-editable, and that the app avoids needless generation loss.

Current Mac clips already contain H.264 screen video, a mixed preview audio track, tagged isolated
system and microphone tracks, a separate camera file, and cursor/input sidecars. ScreenCaptureKit
can deliver screen, system audio, and microphone sample buffers from one stream, while
`AVAssetWriter` can interleave concurrent tracks in one standard media file. See Apple's
[ScreenCaptureKit capture overview](https://developer.apple.com/videos/play/wwdc2024/10088/) and
[`AVAssetWriter`](https://developer.apple.com/documentation/avfoundation/avassetwriter).

Implementation:

1. Model screen, camera, microphone, system audio, cursor, click/drag, and safe typing telemetry as
   explicit source roles in the project document.
2. Keep the current mixed audio track for simple preview compatibility. Treat isolated tracks as
   the mastering source.
3. Add an atomic recording journal after each finalized clip and each removal state change.
4. On launch, discover incomplete sessions and offer **Recover recording**.
5. Preserve readable fragments after a crash. Never delete a partial file as part of recovery.
6. Add **Export original sources** as a folder or bundle with the project document and role
   manifest.
7. Verify that Pause does not re-encode earlier clips and that project edits never rewrite source
   files.

## Phase 5 — publishing quality controls

Keep the simple presets as the default. Put detailed controls under Advanced.

### Capture

- resolution: native source, 1080p, 2K, or 4K where the selected source supports it;
- frame rate: 24, 30, or 60 FPS, with 60 FPS as the normal screen-recording default;
- camera format: enumerate the selected device's real formats and supported frame-rate ranges;
- real-time H.264 hardware capture by default;
- capability checks and safe fallbacks when a requested format cannot stay real time.

ScreenCaptureKit exposes resolution, frame-rate, sample-rate, and channel controls, and Apple notes
that it can capture at native display resolution and frame rate with low CPU overhead:
[Meet ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/). Camera choices must
come from each device's supported formats and frame-rate ranges:
[AVCaptureDevice formats](https://developer.apple.com/documentation/avfoundation/capture-device-formats).

### Export

- simple presets: Medium, High, Highest/Source;
- frame rate: Source, 24, 30, or 60;
- codec: H.264 default, HEVC when compatible, ProRes for an editable master, and AV1 only after a
  capability and performance proof;
- rate control: preset first, then Constant Quality or manual bitrate where the selected encoder
  implements it correctly;
- audio: 48 kHz AAC-LC for normal MP4, with format and bitrate details under Advanced;
- estimated dimensions, bitrate or quality level, duration, and file size before export;
- no silent upscaling;
- dialogue mastering with a measured loudness and true-peak report. Do not claim that YouTube
  requires one exact LUFS number.

Use a runtime capability matrix. Do not show a codec or rate-control mode that the active encoder
cannot produce. Do not use AV1 or ProRes for normal real-time capture only because they exist as
export formats.

## Phase 6 — record once, publish everywhere

**Foundation complete on 2026-08-21:** the right-side Layout pane now owns output shape and
resolution. It offers the common 16:9, 9:16, and 1:1 choices, all existing formats, source shapes,
and an encoder-safe custom width and height. The same setting drives the browser frame, native
scene, GUI export, and CLI export. Dual Frame and Vertical Stack can place the screen or camera
first. Vertical Stack fills the padded canvas with cover-cropped cells, defaults to a true 50/50
split, and stores a 20-80% Camera share setting across projects and remembered defaults. The old
duplicate timeline ratio picker is removed. This is still one global project canvas; the versioned
multi-deliverable model below remains future work.

**Camera framing foundation complete on 2026-08-20:** Layout now separates webcam widget geometry
from the crop inside that widget. Camera Zoom stores a 1.0–3.0× source crop. Camera Position stores
the visual two-dimensional focal point inside that crop. Saved projects, remembered defaults,
browser fallback, live native preview, normal export, and CLI export use the same values, including
mirrored-camera direction. The controls work in PiP and block layouts without changing the pristine
camera track. Per-delivery-variant focal overrides remain part of the editable vertical-layout work
below.

Add delivery variants to one project:

- YouTube 16:9;
- TikTok/Reels/Shorts 9:16;
- square 1:1.

Shared across variants:

- assets and source tracks;
- clip order, removals, trims, speed, and transcript edits;
- automatic-direction observations.

Variant-specific overrides:

- output size and background;
- layout template and pane proportions;
- screen crop and focus path;
- camera position, size, and shape;
- caption layout;
- safe areas;
- manual framing corrections.

### Editable vertical split layout

The TikTok delivery preset includes a stacked 9:16 layout. It starts with the screen in the upper
half and the camera in the lower half. One action swaps the pane order so the camera is above the
screen. Treat 50/50 as a useful default, not a fixed composition.

The first global-canvas slice now lets the user change the pane order and camera share with live
preview and one commit per slider gesture. The remaining variant-specific work must let the user
change:

- the divider directly on the canvas, without resetting either pane's framing;
- each pane's crop, fit, scale, and focal position;
- the gap, padding, background, corner radius, and pane shape;
- caption and platform-safe areas without covering the important screen or face region;
- automatic screen reframing inside the screen pane, with direct manual correction.

The next vertical slice is **variant-specific Screen framing**. Store one base screen scale and
two-dimensional focal point for each delivery variant. In a stacked 9:16 layout, `1.0×` means the
minimum cover crop that fills the screen pane; the user cannot zoom out far enough to expose empty
space or make the captured screen smaller than its pane. Keep the pane geometry fixed while the
content moves inside it.

Offer two controls for the same saved values:

- direct framing: while Layout is open and playback is paused, drag the captured screen inside its
  pane and use wheel or pinch to change scale;
- precise framing: show **Scale**, **Position**, and **Reset** in one flat **Screen framing** section
  beside the existing camera framing controls.

Do not call this base setting a timeline Screen Zoom. Base Screen framing defines the normal crop
for one delivery variant. Existing timeline Zoom regions remain time-based edits and compose on top
of that base framing. Later automatic vertical reframing writes editable, time-varying focal regions
for the active variant and uses the same preview and compositor contract as manual framing.

Keep the screen and camera as independent source tracks. Never bake this layout into capture media.
The user can apply, change, or remove it after recording, save it in a style or delivery preset, and
render another aspect ratio from the same project. Preview and export must use the same layout model.

Acceptance criteria:

- One action applies the default stacked 9:16 layout to an existing camera-linked project.
- The default output is 9:16, with screen above camera and an approximately equal split.
- One action swaps the screen and camera positions, and Undo restores the previous order.
- Dragging the divider updates the preview directly and creates one Undo step when committed.
- The screen and face can each be reframed without changing the other pane or the source files.
- Save, reopen, duplicate deliverable, Undo, Redo, and export preserve the exact composition.
- Captions and important content remain inside visible platform-safe areas.

Implementation order:

1. Add a versioned `deliverables` model with one active variant and shared edit references.
2. Move the current output shape, Vertical Stack, pane order, and camera share into the active
   variant without changing their visible behavior.
3. Add base Screen framing with saved Scale, Position, and Reset controls, plus direct preview drag
   and wheel or pinch adjustment. Give it preview, native export, CLI, Undo, Redo, and reopen parity.
4. Add the on-canvas divider drag without resetting either pane's framing.
5. Re-run the same direction observations through an aspect-aware framing policy.
6. Store automatic reframe results as normal variant-specific framing regions and let direct
   preview correction promote them to manual ownership.
7. Export the active variant, then add **Export all variants**.

Do not duplicate clips or create three divergent project documents.

## Interface polish slice — precision timeline

Run one focused bottom-workspace refinement after base Screen framing. Keep all clip, effect,
playhead, insertion, Undo, and rendering behavior unchanged. The timeline should feel like one
precise editing instrument, not a toolbar stacked above several unrelated cards.

- Use one quiet three-part toolbar: edit actions on the left, transport and timecode in the center,
  and timeline scale or fit controls on the right.
- Remove permanent keyboard-hint capsules. Put shortcuts in tooltips and the normal menu system.
- Replace the large glowing playhead head with a small crisp cap and hairline. Show an exact time
  bubble only while scrubbing or dragging.
- Keep clip cards low-radius and waveform-first. Remove the embedded pencil button; selection and
  the inspector own clip editing.
- Keep ordinary Zoom and Camera Emphasis regions directly editable, but use quieter fills, one
  selection outline, and consistent resize handles.
- Make the bottom navigation range a restrained overview rail. Reveal its handles on hover or focus
  instead of making all parts equally prominent.
- Use the existing graphite, soft-white, and muted steel-blue tokens. Do not add glass, gradients,
  colored glow, or decorative animation.
- Keep hover and selection transitions within 80–180 ms, with no bounce. Scrubbing, trimming,
  reordering, and region dragging must remain immediate and respect Reduce Motion.

Review fixed states at 1100 × 700, 1280 × 800, and 1440 × 900 with one clip selected, one effect
selected, several effect lanes, and a long multi-clip project. Preserve exact time geometry,
keyboard access, VoiceOver labels, and useful pointer targets while reducing visual weight.

## Phase 7 — reusable presets

Expose one friendly preset, but store three composable parts:

1. Recording preset: screen mode, microphone, system audio, camera, camera format, cursor, and FPS.
2. Style preset: background, padding, cursor style, Zoom behavior, camera layout, and audio
   processing.
3. Delivery preset: aspect ratio, resolution, codec, quality, audio format, and safe areas.

Ship named bundles for YouTube, TikTok, and Quick Tutorial. A preset changes future defaults. It
must not silently rewrite an existing project's source-specific edits.

## Phase 8 — agent-native editing

Agents must use the same normal project and editing model as people. Do not build a second
agent-only editor or let an agent rewrite project JSON directly.

1. Add stable JSON inspection for the project, assets, clips, edit regions, source roles, media
   health, and export settings.
2. Put structural and visual edits behind one typed command service shared by the UI, CLI, and
   future agent bridge.
3. Expose CLI commands for Split, Remove, Restore, reorder, trim, insert, layout, Screen Zoom,
   Camera Emphasis, audio settings, automatic-direction regeneration, validation, and export.
4. Give every write a dry-run result, a clear project diff, an expected revision, atomic save, and
   one normal Undo step. A stale revision must fail instead of overwriting newer work.
5. Use stable project, asset, clip, and edit IDs in machine output. Do not make agents address
   timeline items only by fragile array position or display text.
6. Keep source media non-destructive. Agent commands can remove a clip from the edit, but they do
   not delete source files or bypass the recovery and history rules.
7. Build a thin local agent bridge on the same command service. Choose its transport later; do not
   duplicate editing logic for MCP, JSON-RPC, or another protocol.
8. Add UI/CLI/agent parity tests. The same command sequence must produce the same project, preview,
   Undo history, and export scene.

The first useful agent workflow is: inspect a recording, remove or reorder clips, adjust normal
Zoom and Camera Emphasis regions, create a 16:9 or 9:16 delivery variant, validate it, and export it.
The agent must return a concise change report that the user can inspect and undo.

## Phase 9 — fast spoken-word editing

Keep this behind the stable recorder and editor path.

1. Generate the transcript locally after the editor opens. Never delay Pause or Stop for it.
2. Add a versioned custom vocabulary for names such as Claude Code, MCP, and Anthropic.
3. Remove a selected text range through the same normal timeline trim operation.
4. Detect repeated phrases and false starts as review suggestions. Never call them “takes”.
5. Add silence suggestions with preview and Undo. Do not remove silence without confirmation.
6. Keep transcript, captions, and timeline edits on one source-time mapping.

Implementation status on 2026-08-22:

- **Implemented:** a dedicated right-side **Pauses** pane with Natural, Balanced, and Tight pacing;
  live policy tuning; reusable presets; selected-range preview; and one-step batch Apply.
- **Implemented:** Speech mode uses verified Silero v6.2 probabilities from the isolated microphone
  as its primary signal, with isolated-microphone energy and local word timing as extra protection.
  The 0.9 MB model downloads independently and runs through the existing whisper.cpp helper without
  loading the 264 MB caption model. Audio-level mode is the explicit no-model fallback with adaptive
  or manual dB threshold.
- **Implemented:** cut analysis uses its own disk-cached 20 ms envelope. The visible waveform keeps
  its lighter display cap.
- **Implemented:** system audio, clicks, releases, keyboard activity, and meaningful pointer travel
  protect content from a cut by default.
- **Implemented:** suggestions appear temporarily over the clip waveform. Confirmed suggestions
  become normal clip-anchored trims, keep source media unchanged, share preview/export mapping, and
  apply as one undoable document edit. Export boundaries use a 10 ms equal-power audio fade.

## Phase 10 — useful interchange and source exports

Order:

1. Finished YouTube-ready MP4.
2. Original-source bundle with role manifest.
3. FCPXML export for Final Cut Pro, using rational timeline times and file URLs. Apple documents
   FCPXML as the interchange format for media, timeline sequences, and editing decisions:
   [FCPXML Reference](https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference).
4. Verify the same export against supported DaVinci Resolve versions before labeling it a Resolve
   workflow. Add an adapter only when the round trip is measured.
5. Transparent cursor-only export through an alpha-capable format such as ProRes 4444 or an image
   sequence. Do not promise transparent H.264 MP4.

Start with clips, trims, audio roles, and basic timing. Add product-specific Zoom and camera motion
as rendered overlays or documented metadata only when the target editor can reproduce them.

## Phase 11 — advanced controls and later expansion

Only after the Mac product is dependable:

- **Implemented 2026-08-20:** one right-side **Automatic** pane backed by the existing typed policy.
  It uses versioned built-in
  and custom presets, shows the main creative controls first, and puts every remaining tunable
  detector/planner value under **All parameters**. A tuning session caches raw cursor, keyboard,
  and microphone observations, replans after a short debounce, updates preview and timeline
  together, and commits one undoable edit. Projects store the resolved versioned policy for
  reproducible regeneration; reusable presets store validated overrides. Privacy exclusion,
  no-overlap, and cursor-safety rules remain locked invariants. Max Zoom defaults to 1.65× and can
  expand the automatic depth profile up to the shared 5× renderer limit;
- more direction detectors based on labelled failures, not guesses;
- cloud sharing;
- direct upload;
- Windows and Linux product work;
- larger media-library workflows;
- broader caption and translation features;
- AI chat and provider integrations.

## Release gates

### Mac alpha

- Gate 0 complete;
- Slice 1 complete;
- Gate 2 complete;
- branded, signed, notarized build on a clean Mac;
- one working Klippt Pro purchase, activation, offline-grace, cancellation, and restore flow;
- privacy, terms/EULA, refund, support, and third-party notice pages;
- a tested private update path or an explicit manual-update process for the invite-only group.

### Creator beta

- first-class editable source roles and recovery;
- Screen Studio-quality automatic direction with low manual correction;
- simple, reliable capture/export quality controls;
- 16:9 and 9:16 variants from one project.

### Differentiated v1

- the creator beta gates hold during normal creator use, without a fixed project quota;
- named presets;
- agent-safe inspect, edit, validate, and export commands with UI parity;
- raw source bundle;
- no known media-loss, project-corruption, or preview/export parity defect.

Transcript editing, FCPXML, cursor-only export, cloud sharing, direct upload, and other platforms do
not block differentiated v1.

## Completed Slice 1 checklist

After Gate 0:

1. Add persisted automatic `directionGroupId` metadata.
2. Add the central promote-and-edit document operation.
3. Route every Zoom and Camera Emphasis user edit through it.
4. Replace `updateZoomDepth` with an exact rendered Scale action and UI.
5. Add ownership and scale regressions.
6. Show actual Zoom and Camera Emphasis regions directly and hide empty effect lanes.
7. Simplify the inspector and move motion/3D controls under Advanced.
8. Run the full TypeScript, native scene, timeline, preview/export parity, and production build
   checks.
9. Record one labelled test project. Use Regenerate to compare the new presentation without
   adding another detector.

## Next implementation checklist — clean Mac alpha

1. **Done:** Hide inherited AI chat, model-provider setup, translation, advanced caption work,
   direct upload, transcript/caption facets, and the large media-library workspace from the normal
   product path. Keep the code isolated behind `productSurface.ts`. Keep one compact Import media
   action in the editor so files can still be appended to the timeline.
2. **Done:** Audit the visible launch, editor, recording, and export path for remaining OpenScreen
   identity or navigation that does not belong in Klippt.
3. **Done:** Use one restrained steel-blue editor accent for selection, the playhead, and automatic
   edit regions. The floating recording panel remains monochrome.
4. **Paused by product decision:** Build the packaged Klippt app and verify current projects,
   preferences, capture permission, and the legacy user-data location. Resume this when alpha
   distribution becomes the active gate.
5. **Blocked until distribution work resumes:** Sign with Developer ID, enable Hardened Runtime,
   notarize, staple, and test on a clean Mac. The current keychain has an Apple Development
   certificate but no Developer ID Application certificate.
6. Add the private alpha update channel and a privacy-safe crash-report export when distribution
   becomes the active gate.

## Planned recording-HUD refinement

After the current editor slice is stable, test a lean active-recording state on the existing HUD.
This is a design hypothesis, not a release gate yet.

1. Keep the full two-row surface while idle and paused, when source controls and clip history matter.
2. During active recording, let the same surface collapse into one compact pill with the recording
   indicator, total time, Pause, and Stop.
3. Keep the pill visible, readable, draggable, and slightly translucent. Do not make it fully
   transparent or let the backing window block input outside the painted pill.
4. Restore the full surface on Pause or explicit expansion without moving the panel unexpectedly.
5. Add a configurable global Pause/Continue shortcut. Do not use `Command-Space`, because macOS
   reserves it for Spotlight. `Command-Shift-Space` is the first candidate, subject to registration
   and conflict testing.
6. Measure click interception, startup lag, focus stealing, and recording stability before making
   the collapsed state the default.
