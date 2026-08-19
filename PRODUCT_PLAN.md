# record product plan

- Status: active
- Date: 2026-08-19
- Product source of truth: [`AGENTS.md`](AGENTS.md)
- Upstream historical roadmap: [`ROADMAP.md`](ROADMAP.md)

## Product decision

record is a proprietary, Mac-first, clip-native recorder and editor. Its private repository is
`github.com/oEdyb/record`. It is not an
OpenScreen distribution, a generic AI editor, or a cross-platform project for the current
release.

The revenue model stays open. record can use a one-time price, subscriptions, or a hybrid later.
Billing does not belong in the current recording and editor reliability work.

The core workflow is:

> Record in clean clips, remove bad clips while recording, then return to a polished first edit.

The product promise is:

> Record once. Keep every source. Fix the edit afterward. Export for any platform without
> needless quality loss.

Automatic direction supports this workflow. It does not become a second product, a second
timeline model, or a reason to delay recording reliability.

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
7. Ship by evidence gates, not feature count or estimated calendar time.

## Current baseline

| Capability | Current state | Main gap |
| --- | --- | --- |
| Clip-native recording | Working on Mac: Pause, Continue, Remove previous clip, Stop, editor insertion, Undo, and Redo | Long-session and failure recovery gates |
| Editable source capture | Screen and camera are separate. Mac clips contain a mixed preview track plus tagged system-audio and microphone tracks. Cursor and safe keyboard telemetry are sidecars | First-class source-track model, raw export, recovery inventory |
| Automatic direction | Strong deterministic engine for clicks, drags, cursor paths, typing, and Camera Emphasis. Normal editable timeline regions. Regeneration exists | Scale control lies when `customScale` is set; edited auto regions can still be removed; timeline is too busy |
| Preview and export | Shared native scene contract and hardware paths on Mac | Full long-video delivery validation |
| Export quality | MP4/GIF, H.264/H.265, 24/30/60 FPS, 1080p/2K/source tiers, estimated size, and audio normalization exist | Capability-based advanced controls, manual/CQ rate control, ProRes/AV1 decisions |
| Output shapes | Native, 16:9, 9:16, and square framing foundations exist | One-project delivery variants and automatic vertical reframing |
| Transcript editing | Large inherited feature set exists | Product focus, custom vocabulary, and a simple spoken-word workflow |
| Presets | Recording and editing preferences persist | Named, reusable recording/style/delivery presets |
| Distribution | Development app runs locally; private repository selected at `github.com/oEdyb/record` | Verified checkpoint, rebrand, signing, notarization, update channel |

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

Do this slice next. Freeze new detectors and policy experiments until it is complete.

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
6. Keep generated automatic Zooms capped at 1.65×. Preserve valid deeper manual values from old
   projects unless a deliberate migration changes that contract.

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

1. Add one **Automatic direction** lane for untouched automatic work.
2. Show one summary region for each `directionGroupId`, not one pill for every internal pan target.
3. Expand a group only when the user selects or explicitly opens it.
4. In the expanded state, show the internal focus targets so the user can move, resize, delete, or
   reframe them.
5. Show promoted/manual Zooms as normal user edits. Do not hide their ownership.
6. Keep Camera Emphasis in the same automatic lane, with a clear but restrained type marker.
7. Do not add another permanent row, mode, wizard, or automatic-editing dashboard.

Acceptance tests:

- A connected four-target pan appears as one calm summary region by default.
- Selecting it reveals four editable targets without changing playback.
- Collapse and expansion do not change project data or Undo history.
- Trimmed and split clips show the same visual groups that preview and export render.
- A fully trimmed group does not appear.

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

## Gate 2 — prove the complete recording-to-upload path

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

Failure matrix:

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
- Every failure leaves either a recoverable project or a clear terminal error with preserved files.
- One Undo removes one recording import without removing unrelated edits.
- The final H.264 MP4 uses progressive video, Fast Start, 48 kHz AAC-LC, and the recorded frame
  rate unless the user explicitly changes it. These settings follow YouTube's current upload
  guidance: [YouTube recommended upload encoding settings](https://support.google.com/youtube/answer/1722171).

## Phase 3 — ship a safe Mac alpha

1. Replace OpenScreen package names, metadata, icons, URLs, and update identifiers with the record
   identity. Migrate bundle IDs, permissions, user data, and project associations deliberately.
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
- screen crop and focus path;
- camera position, size, and shape;
- caption layout;
- safe areas;
- manual framing corrections.

Implementation order:

1. Add a versioned `deliverables` model with one active variant and shared edit references.
2. Make the current output-shape control select or create a variant instead of rewriting one global
   project shape.
3. Re-run the same direction observations through an aspect-aware framing policy.
4. Store automatic reframe results as normal variant-specific framing regions.
5. Add direct preview correction and per-variant Undo/Redo.
6. Export the active variant, then add **Export all variants**.

Do not duplicate clips or create three divergent project documents.

## Phase 7 — reusable presets

Expose one friendly preset, but store three composable parts:

1. Recording preset: screen mode, microphone, system audio, camera, camera format, cursor, and FPS.
2. Style preset: background, padding, cursor style, Zoom behavior, camera layout, and audio
   processing.
3. Delivery preset: aspect ratio, resolution, codec, quality, audio format, and safe areas.

Ship named bundles for YouTube, TikTok, and Quick Tutorial. A preset changes future defaults. It
must not silently rewrite an existing project's source-specific edits.

## Phase 8 — fast spoken-word editing

Keep this behind the stable recorder and editor path.

1. Generate the transcript locally after the editor opens. Never delay Pause or Stop for it.
2. Add a versioned custom vocabulary for names such as Claude Code, MCP, and Anthropic.
3. Remove a selected text range through the same normal timeline trim operation.
4. Detect repeated phrases and false starts as review suggestions. Never call them “takes”.
5. Add silence suggestions with preview and Undo. Do not remove silence without confirmation.
6. Keep transcript, captions, and timeline edits on one source-time mapping.

## Phase 9 — useful interchange and source exports

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

## Phase 10 — later expansion

Only after the Mac product is dependable:

- advanced automatic-direction tuning UI backed by the existing typed policy;
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
- branded, signed, notarized build on a clean Mac.

### Creator beta

- first-class editable source roles and recovery;
- Screen Studio-quality automatic direction with low manual correction;
- simple, reliable capture/export quality controls;
- 16:9 and 9:16 variants from one project.

### Differentiated v1

- the creator beta gates hold for three new real projects;
- named presets;
- raw source bundle;
- no known media-loss, project-corruption, or preview/export parity defect.

Transcript editing, FCPXML, cursor-only export, cloud sharing, direct upload, and other platforms do
not block differentiated v1.

## Next implementation checklist

After Gate 0:

1. Add persisted automatic `directionGroupId` metadata.
2. Add the central promote-and-edit document operation.
3. Route every Zoom and Camera Emphasis user edit through it.
4. Replace `updateZoomDepth` with an exact rendered Scale action and UI.
5. Add ownership and scale regressions.
6. Build the grouped Automatic direction lane.
7. Simplify the inspector and move motion/3D controls under Advanced.
8. Run the full TypeScript, native scene, timeline, preview/export parity, and production build
   checks.
9. Record one labelled test project. Use Regenerate to compare the new presentation without
   adding another detector.
