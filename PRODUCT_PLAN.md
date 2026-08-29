# Klippt product plan

- Status: active
- Date: 2026-08-29
- Product source of truth: [`AGENTS.md`](AGENTS.md)
- Upstream historical roadmap: [`ROADMAP.md`](ROADMAP.md)
- Full agent-first execution plan: [`docs/cutting-edge-execution-plan.md`](docs/cutting-edge-execution-plan.md)

## Product decision

Klippt is a proprietary, Mac-first, clip-native recorder and editor. Its current private repository
remains `github.com/oEdyb/record` until the compatibility-safe rebrand. It is not an
OpenScreen distribution, a generic AI editor, or a cross-platform project for the current
release.

The first commercial release is a subscription-first paid private alpha. One Klippt Pro
entitlement covers the full product at a founding price of $19 per month or $99 per year. Lemon
Squeezy is the selected first merchant of record and license provider. A 14-day no-card trial starts
after the first successful recording. Expired access becomes a read-only viewer: projects and
untouched source recovery remain available, while recording, importing, editing, automatic editing,
regeneration, and finished export are blocked. Public Lemon Squeezy identifiers are still required
before commercial enforcement turns on.

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

## Post-alpha growth — 80/20 SEO and GEO

After the paid-alpha product, checkout, legal pages, and reliable download path are live, build one
small search and generative-discovery foundation. GEO means making Klippt easy for AI answer engines
to understand, verify, and recommend. It is not a separate content farm or a reason to delay the
product gate.

The first pass should target most of the value with little recurring work:

1. Create one fast, crawlable canonical website with clear product, pricing, download, privacy,
   support, and company pages. Add a sitemap, canonical URLs, useful metadata, and valid SoftwareApp,
   Organization, FAQ, and VideoObject structured data where each type truthfully applies.
2. Publish a small set of high-intent pages around the jobs Klippt solves: clip-native screen
   recording, editable automatic zooms, recording once for YouTube and TikTok, silence removal, and
   local-first creator recording. Prefer five excellent pages over many shallow posts.
3. Add honest comparison and alternative pages only when claims can be shown with current product
   evidence. Use real screenshots, short demonstrations, export samples, and measured workflows.
4. Make the same stable facts easy for search engines and AI systems to quote: what Klippt is, who
   makes it, supported platforms, price, privacy model, core workflow, limitations, and update date.
   Keep each fact in one canonical page and do not publish invented reviews or synthetic authority.
5. Register the site with Google Search Console and Bing Webmaster Tools. Track indexed pages,
   high-intent queries, branded searches, download starts, trial starts, and paid conversion. Review
   the small page set monthly and improve pages that produce qualified users.
6. Earn a few relevant references through the real launch, creator demonstrations, product
   directories, technical write-ups, and direct comparisons. Do not buy links or generate bulk AI
   articles.

The initial success test is qualified discovery and trial conversion, not traffic volume. Expand
SEO or GEO only after the small page set shows which queries and recommendations bring real users.

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

| Capability              | Current state                                                                                                                                                                                                                                                                                               | Main gap                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clip-native recording   | Working on Mac: Pause, Continue, Remove previous clip, Stop, editor insertion, Undo, and Redo                                                                                                                                                                                                               | Long-session and failure recovery gates                                                                                                               |
| Editable source capture | Screen and camera are separate. Mac clips contain a mixed preview track plus tagged system-audio and microphone tracks. Cursor and safe keyboard telemetry are sidecars                                                                                                                                     | First-class source-track model, raw export, recovery inventory                                                                                        |
| Automatic direction     | Deterministic click, drag, typing, cursor, and Camera Emphasis engine; exact Scale control; protected user corrections; direct editable timeline regions; simplified inspector                                                                                                                              | Tune only from labelled real-use failures; do not add detectors now                                                                                   |
| Preview and export      | Shared native scene contract and hardware paths on Mac                                                                                                                                                                                                                                                      | Full long-video delivery validation                                                                                                                   |
| Export quality          | MP4/GIF, H.264/H.265, 24/30/60 FPS, 1080p/2K/source tiers, estimated size, and audio normalization exist                                                                                                                                                                                                    | Capability-based advanced controls, manual/CQ rate control, ProRes/AV1 decisions                                                                      |
| Creator audio           | Isolated microphone/system stems, dialogue leveling, a -14.5 LUFS/-2 dBTP pre-encode delivery target, Silero pause analysis, and reversible pause trims exist                                                                                                                                               | Decoded-delivery verification, a product-routed Clean Voice stem, preview/export parity, and the creator-corpus engine gate                           |
| Output shapes           | One Layout pane controls presets, original shapes, custom pixels, camera composition, and block order across preview and export                                                                                                                                                                             | One-project delivery variants, editable pane proportions, and automatic vertical reframing                                                            |
| Transcript editing      | A calm local Transcript facet provides clip-scoped word timing, click-to-seek, native Copy, detected language, explicit language reruns, isolated You/System roles, and bounded long-project transcription                                                                                                                                       | Custom vocabulary, mixed-import diarization, and safe text-based editing remain parked until after the core audio and paid-alpha work                  |
| Presets                 | Recording and editing preferences persist                                                                                                                                                                                                                                                                   | Named, reusable recording/style/delivery presets                                                                                                      |
| Agent workflow          | Record, Sources, Info, Pack, Captions, and legacy/current project Export CLI paths exist                                                                                                                                                                                                                    | Complete inspect/edit/validate command surface with UI parity, dry runs, revisions, and agent-safe transactions                                       |
| Project format          | `.klippt` is canonical across storage, dialogs, drag-and-drop, and CLI; legacy `.openscreen` and `.axcut` files remain readable and are copied forward without deletion                                                                                                                                     | File-association handoff and broader real-project migration testing                                                                                   |
| Distribution            | Klippt name, icons, package display name, `.klippt` format, Developer ID signing, Apple notarization and stapling proof, Gatekeeper acceptance, privacy-safe diagnostics, the owned `updates.dyberg.co` R2 update channel, exact WebAssembly source/relinking offer, and generated package notice inventory are implemented while current bundle and user-data identities stay compatible | Finish entitlement activation, legal/support pages, clean-Mac alpha validation, and the Dyberg-owned bundle-ID migration before paid distribution |

## 2026-08-28 cutting-edge audit lock

The current architecture remains the product architecture: Electron and React for the shell,
Swift ScreenCaptureKit for capture, Rust and Metal for composition, and VideoToolbox for hardware
export. Do not rewrite Klippt in Swift and do not add automatic-editing detectors only because a new
model or paper exists.

The next commercial gate is a trust gate. Complete these items before broad feature expansion:

1. Create and push a reviewed known-good checkpoint of the current product. The private remote now
   exists, but the live product is far ahead of the last pushed checkpoint.
2. Transcribe the tagged microphone role directly. Keep microphone, system audio, and preview mix
   explicit through transcription, pause analysis, preview, export, and source bundles.
3. Qualify FluidAudio's corrected Parakeet Core ML encoder against a locked Swedish, English,
   code-switching, technical-term, long-session, memory, and thermal corpus. Keep Whisper as an
   independent fallback until the candidate passes.
4. Make every export durable: same-directory staging file, stream and duration verification,
   synchronization, then atomic rename. A failed export must not replace an existing good file.
5. Move the desktop shell to a supported Electron line in an isolated migration lane. Replace
   `webSecurity: false` with an allowlisted, range-capable project-media protocol, strict CSP,
   navigation and window guards, centralized IPC sender validation, and reviewed production fuses.
6. Declare one exact BT.709 SDR and pixel-range contract. Preserve the selected or source frame rate.
   Report the encoder that was selected and whether hardware encoding was actually used.
7. Replace whole-program PCM export with a bounded block-based audio graph. Long-project memory must
   plateau instead of growing with duration.
8. Validate the decoded AAC deliverable for loudness, true peak, duration, priming, tail, clipping,
   and discontinuities. Describe `-14.5 LUFS` as the **Klippt Creator** preset, not a YouTube rule.
9. Add one media workload monitor for disk capacity and latency, thermal and power state, camera
   pressure, queue depth, dropped frames, memory, hardware encoder state, drift, and export speed.
10. Tune automatic direction only against a versioned labelled corpus. Measure unchanged rate,
    correction time, delete rate, scale and framing corrections, cursor containment, privacy
    boundaries, and preview/export parity.
11. Freeze a Dyberg-owned bundle identifier before paid distribution. Migrate and test existing
    user data, TCC permissions, Keychain data, file associations, updates, recovery, rollback, and
    side-by-side installation.
12. Give each window the smallest preload surface it needs. Validate exact origin, top-level frame,
    window role, sender identity, and payload schema for every privileged IPC method. Restrict
    capture permissions, export destinations, and reveal-in-folder to explicit app-owned capabilities.
13. Bind each packaged helper to the exact release source SHA. Keep the completed FFmpeg WebAssembly
    source, configuration, notice, relinking, model-rights, and generated package-inventory gates
    intact before Klippt charges users.

Trust-gate progress on 2026-08-28: W0.1 and W0.2 are complete. W0.3 is code-complete and waits
for its protected-environment activation after the workflow reaches `main`. The full product is
protected by a verified private checkpoint. Every release platform build now waits for permanent
dependency, static-analysis, secret-scan, inventory, notice, and CycloneDX gates. New dependency
inputs require an exact reviewed hash and Olle's detached Ed25519 approval signature. The private
approval key stays outside GitHub. The exact WebAssembly source offer, Cargo licence inventory,
model and asset rights, and generated paid-package notice inventory now travel through the same
release contract. W0.4 is complete: the clean, signed Apple Silicon package passed exact physical
resource, ASAR build-output, helper-provenance, notice, WebAssembly, model-exclusion, and inventory
checks. Its release inventory and CycloneDX SBOM each contain 1,214 components.
W0.5 infrastructure is complete. `creator-corpus/` now defines one strict, versioned manifest and
split lock for Development, Tuning, and Holdout. Raw creator media stays outside Git by default;
exact hashes bind it to reviewed metadata and consent. Reproducible extraction uses a pinned FFmpeg
binary and never overwrites changed output. Privacy-safe result records cover capture, export,
audio, ASR, automatic direction, and UI performance, and bind the exact source, tool, policy, and
applicable model. CI validates the primary contract before the full test suite. The tracked manifest
starts empty; real Swedish/English creator fixtures still need consent, labels, and locked splits.
W0.6 local workload telemetry is complete. Bounded `klippt-workload-v1` reports now measure capture,
camera, preview, export, process, GPU-process, audio-queue, disk, thermal, power, hardware-path,
fallback, and failure evidence without storing media context. The support diagnostic ZIP includes
the newest reports. Unsupported platform facts remain explicit: browser-owned camera pressure and
AVAssetWriter's private encoder selection are `unknown`, not inferred. Telemetry never changes
recording quality or waits on the media path.
W0.7 accessibility and HUD interaction smoke is complete. W1.1 atomic export is also complete.
MP4 and GIF exports keep the old destination until a staged result passes native decode, timing,
stream, format, capacity, and durability checks. Cancellation now reaches native video flush, audio
work, audio flush, trailer, verification, sync, and publish. Interrupted or failed attempts remain
recoverable and never appear as finished exports.
W1.2 and W1.3 are complete. Native recordings transcribe microphone and system roles independently,
never use the mixed preview by default, and persist reproducible role, model, and alignment evidence.
The UI and CLI share one main-process source path that decodes bounded FFmpeg windows, preserves
timestamp gaps, reconciles overlap seams, cancels decode, inference, and restart work, unloads
models on project close, and publishes only exact atomic cache entries. The 90-minute automated
source case holds one short PCM window at a time. A real RSS plateau and long acoustic holdout remain
part of the creator-corpus release gate, not a claim inferred from the unit test.

The next high-value product prototypes, in order, are:

1. Native AVFoundation camera capture with explicit resolution/FPS and a shared host-time clock.
2. Phrase-level microphone leveling with bounded smooth gain and preview/export parity.
3. First-class editable reframe keyframes for 16:9, 9:16, and 1:1 delivery variants.
4. ProRes 422 LT/422 MOV and an optional source bundle with isolated lossless audio roles.
5. One typed command service shared by the UI, CLI, and future agent bridge. Commands use stable IDs,
   expected revisions, dry runs, idempotent operation IDs, validation, and atomic one-Undo batches.

Keep these items in a lab until their evidence gates pass: native-layer preview, ScreenCaptureKit
NV12 capture, FFmpeg 9, VideoToolbox beta quality controls, DPDFNet, FireRedVAD, custom vocabulary,
local Vision/OCR support signals, automatic multi-output render fanout, resumable segmented export,
and HDR.

Do not build AV1 software export as the normal Mac path, LLM-selected pixel coordinates, continuous
cursor chasing, a zoom for every click, automatic generated B-roll, generative voice replacement,
a separate AI timeline, or automatic publishing. Keep React, Vite, `wgpu`, N-API, FFmpeg, and
Electron major migrations in separate measured lanes.

The full evidence, dependency audit, research links, contradictions, and release measurements live
in the vault research note `2026-08-28 Finding cutting-edge upgrades for Klippt`.

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

Later inspector-space refinement:

- Make Layout, Audio/Pauses, Background, Effects, Cursor, Captions, and Automatic use one efficient
  side workspace instead of small floating panes surrounded by blank space.
- Let the active inspector extend farther toward the preview and down to the bottom workspace when
  that space is available, as Screen Studio does. Use the available width and height for the active
  task without covering the content the user must inspect.
- Keep one consistent pane frame, section rhythm, and responsive minimum/maximum width. Do not solve
  the space problem with nested cards, permanent extra columns, or more visual clutter.
- Preserve the preview, timeline, direct manipulation, and keyboard flow. The larger inspector must
  make controls easier to scan and use, not make the editor feel smaller or busier.

Exit criteria for Slice 1:

- The editor never displays a Zoom value that differs from preview or export.
- Regeneration cannot remove a user-corrected automatic passage.
- The default timeline shows deliberate automatic passages, not detector internals.
- A user can correct scale, framing, tracking, and duration without opening Advanced.
- The existing automatic-direction regression suite stays green. Add interaction coverage for all
  ownership paths.

**Correctness gate completed on 2026-08-25:** web preview and native preview/export now preserve
the same `directionGroupId`, context boundaries, and kept-segment boundaries. The shared selector
counts real screen and camera entrances by group, effect kind, and playback segment inside a local
rolling 60-second window. It no longer joins different modalities or opposite sides of a cut only
because their times are close. Final standalone Zooms obey minimum duration, while intentional
internal pan fragments remain one visual passage. The typed policy is shared by import,
regeneration, the editor action, and CLI. Verification passed 297 focused Automatic Direction
tests, both TypeScript targets, the complete 2,340-test suite with one skip, the production macOS
native-helper build, 28 Rust compositor region tests, and independent Critical/Important review.
Freeze new detectors and tune only from labelled real-use evidence.

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
  independent review with no Critical or Important finding.
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
7. The first Klippt Pro entitlement slice is implemented behind a provider adapter. It includes a
   Lemon Squeezy License API adapter, OS-backed encrypted license storage, a seven-day offline grace
   period, a trial that starts after the first durable recording, main-process capability checks,
   renderer read-only guards, localized access UI, and safe project/source retention. Add the public
   store, product, variant, checkout, and management identifiers before the paid alpha. Never put a
   provider secret in the app, and never let a validation request interrupt active capture or export.
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
- dialogue mastering that aims for -14.5 LUFS integrated without exceeding -14 LUFS, uses a
  -2 dBTP pre-AAC ceiling, verifies the decoded delivery file stays at or below -1 dBTP, and reports
  measured loudness and true peak. Preserve dynamics when those targets conflict. Do not claim that
  YouTube requires one exact LUFS number.

Use a runtime capability matrix. Do not show a codec or rate-control mode that the active encoder
cannot produce. Do not use AV1 or ProRes for normal real-time capture only because they exist as
export formats.

### Clean Voice

Add local microphone cleanup without changing the raw source or the recording path. Full evidence
and architecture are in the vault note `2026-08-24 Making Klippt audio clean in noisy creator
recordings`.

1. Keep raw microphone audio permanent. Build a versioned recipe and sample-exact lossless derived
   stem in a restartable Rust worker after recording.
2. Keep the editor usable on raw audio while cleanup runs. Use the same completed derived stem for
   preview and export. Any failure falls back to raw.
3. Use raw and cleaned Silero as a union for speech protection. Cleaned analysis alone may veto a
   cut but may never create one. Under the explicit **Ignore non-speech sounds** policy, an
   isolated raw-energy event can stop blocking a pause only when raw Silero, cleaned Silero, and the
   transcript all classify it as non-speech. Keep system audio, screen activity, trims, and failure
   fallback as independent protection.
4. Keep **Clean Voice**, **Amount**, and **Original** separate from **Even volume** and final program
   mastering. Process microphone audio only.
5. Start with DeepFilterNet 3 as the mature reference implementation. Compare it with raw and the
   pinned DPDFNet-2 48 kHz checkpoint in a development-only bake-off. Ship one engine. If results
   are tied or mixed, ship DeepFilterNet 3. On failure, use raw rather than a hidden engine switch.
6. Require exact timing, no semantic or identity damage, safe clean-mic bypass, M5 system
   performance, and 30-60 minute stability before enabling it by default.
7. Do not make generative speech reconstruction the normal engine. Preserve every word before
   optimizing how impressive one noisy demo sounds.

### Audio pane

Use one right-side **Audio** pane rather than separate top-level tools for cleanup, pause shortening,
and delivery loudness. Keep the surface visually flat and use the same section rhythm as the other
editor inspectors.

1. **Voice:** optional **Clean Voice**, **Amount** with a Natural default, loudness-matched
   **Original**, and optional **Even volume**. Clean Voice and Even volume process only the
   microphone and stay independent.
2. **Pacing:** the current **Shorten pauses** controls, preview, protection options, and one-batch
   Apply/Undo flow.
3. **Delivery:** optional **Normalize volume**, on by default for the YouTube preset. Show
   **YouTube · -14.5 LUFS** as the simple target. Offer **Custom** with direct target-loudness and
   true-peak controls. Custom values range from -30 to -9 LUFS and -6 to -1 dBTP. Measure the
   complete edited program after cuts, speed, gain, and system-audio mixing. Preserve dynamics or
   return a quieter result when safe normalization cannot reach the target.

Keep the pane quiet. Show short names and values in the normal layout. Put definitions, safety
details, and the Clean Voice trust model behind accessible hover and keyboard-focus info controls.

The YouTube label describes Klippt's delivery preset. It does not claim that YouTube mandates one
LUFS value. Preview and export must use the same enabled audio recipe, while the final delivery
measurement and decoded AAC verification happen against the complete rendered program.

**Foundation implemented on 2026-08-25:** a development-only, engine-neutral Rust worker now runs
the pinned DeepFilterNet 3 `libDF` backend on mono 48 kHz microphone WAV files. It keeps bounded
memory, uses fresh model state for each file, flushes the tail, removes the fixed model delay,
produces an atomic Float32 WAV with the exact source sample count, and writes deterministic engine
and model identity into the lab manifest. The derived mono WAV carries an explicit front-center
channel layout so macOS cannot route it to one speaker. Natural starts at a conservative 6 dB attenuation cap;
stronger cleanup remains a lab input. The worker is not in the release build, preview, export, or
normal UI until the fixed creator corpus proves semantic safety and identity preservation. Klippt
pins a narrow v0.5.6 fork with only upstream's two silence-grace commits. This lets the three-hop
tail flush advance the model without injecting a synthetic high-frequency state clock.

The pinned fork is `oEdyb/DeepFilterNet` commit
`b0fa238a331fb5cc39c5555d3538008dd88c0aef`, based on upstream v0.5.6 commit
`978576aa8400552a4ce9730838c635aa30db5e61`. The hardened lab verifies the exact 1,440-sample model
delay, zero residual lag, exact digital silence, EOF signals at four hop offsets, signal/silence
transitions, fresh-state determinism, and a 60-second bounded run. Raw-only fallback analysis is
not cached as a completed clean result, and an uncovered speech-probability span fails closed.
**Optional processing foundation implemented on 2026-08-26:** schema v8 stores only an explicit
asset-level recipe. Missing or **Original** performs no work. Electron schedules work only after the
project is durable, runs one below-normal-priority job at a time, cancels for recording or serious
thermal pressure, resumes after cancellation, removes crash staging on relaunch, and publishes a
validated content-addressed stem plus manifest. Cache identity binds the isolated microphone
content, source clock, recipe, extraction contract, helper, model, and engine. Corrupt entries are
rejected and rebuilt. The raw recording remains authoritative and every failure still resolves to
raw.

**Development activation implemented on 2026-08-27:** the optional Audio control now schedules the
existing one-job background service for every original recording asset. Preview and native export
use one main-owned runtime resolver. Preview switches atomically from the original clip audio to a
browser-ready mix of the clean microphone and untouched system audio only after the complete cache
entry is ready. Native export replaces only the microphone with the lossless clean stem. Missing,
cancelled, stale, or corrupt routes use the complete original clip. No cache path enters the project,
and recording still cancels optional processing.

The next gate is the labelled Swedish/English creator corpus, decoded delivery verification,
explicit commercial model-license confirmation, and real 30-60+ minute creator-session evidence.
Do not package the helper in the normal release or enable Clean Voice by default before this gate.

**Audio pane implemented on 2026-08-25:** the old Pauses facet is now one flat **Audio** pane with
**Voice**, **Pacing**, and **Delivery** sections. **Even volume** and **Normalize volume** are
independent project settings, are remembered for the next project, and control separate native
export stages. The export dialog no longer owns a second normalization switch. Delivery now offers
a fixed **YouTube · -14.5 LUFS / -2 dBTP** preset and custom target-loudness and peak controls. The
project, reusable defaults, GUI export, CLI export, and native mastering path share the same values.
Detailed help appears only on hover or keyboard focus. **Clean Voice** is optional in development,
shows its background state beside the control, and is connected to preview and native export through
the shared runtime resolver. It remains excluded from normal release packaging and defaults to off.

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

**Screen framing foundation complete on 2026-08-23:** Layout now stores one base Screen Scale and
Position for each output shape. While Layout is open and playback is paused, the user can drag the
screen in the preview, use wheel or trackpad input to change scale, or use precise Scale, Position,
and Reset controls. Cover remains the minimum scale. Saved projects, remembered defaults, live
native preview, normal export, and CLI export use the same framing. Timeline Zoom regions compose
inside this base frame. The versioned multi-deliverable model and automatic vertical focus paths
remain future work.

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

The manual Screen framing foundation stores one base screen scale and two-dimensional focal point
for each output shape in the current global canvas. In a stacked 9:16 layout, `1.0×` means the
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
3. **Complete on 2026-08-23:** Add base Screen framing with saved Scale, Position, and Reset controls,
   plus direct preview drag and wheel or trackpad adjustment. Give it preview, native export, CLI,
   Undo, Redo, and reopen parity.
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
- Compress applied cuts out of the main waveform and join the kept sections at one quiet seam, not a
  floating effect lane or a deleted-width gap. Put one small scissors marker on each seam and show
  the removed duration on hover or keyboard focus. Restoring a coalesced cut remains one normal
  Undoable edit. At rest, show only a tiny notch and reveal the full control on hover or focus. These
  visible sections are a projection, not new stored clips.
- Keep ordinary Zoom and Camera Emphasis regions directly editable, but use quieter fills, one
  selection outline, and consistent resize handles.
- Make the bottom navigation range a restrained overview rail. Reveal its handles on hover or focus
  instead of making all parts equally prominent.
- Use the existing graphite, soft-white, and muted steel-blue tokens. Do not add glass, gradients,
  colored glow, or decorative animation.
- **Done on 2026-08-25:** Replace production native HTML option menus with one keyboard-accessible
  `AppSelect` primitive. Its trigger and popup use the shared graphite and muted steel-blue tokens,
  so the host macOS accent cannot turn menus green. Keep green semantic-only.
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

1. Use multilingual Parakeet TDT 0.6B v3 through pinned FluidAudio `0.15.6` as the primary Apple
   Silicon Mac engine. Keep Parakeet v2 as an internal English benchmark and Whisper as the product
   fallback. All engines stay behind the existing typed STT contract.
2. Klippt owns the verified 482 MB INT8 v3 cache. It downloads only the 21 runtime files from one
   immutable model commit and checks every SHA-256 before atomic publication. A clean install never
   requires Koett. FluidAudio is Apache 2.0 and the Parakeet Core ML model is CC BY 4.0; both notices
   ship with the app.
3. The calm right-side **Transcript** facet is implemented. It starts only when the user presses
   **Transcribe**, so model download and inference never delay Record, Pause, Stop, project opening,
   or basic editing.
4. Put one visible **Copy** action in the pane header. Copy the current edit as plain text in
   timeline order. Exclude removed clips, applied trimmed words, and internal silence markers. Keep
   punctuation and separate clips with paragraph breaks.
5. The first exposed slice stays read-only apart from click-to-seek, Transcribe/Retry, and Copy. It
   does not expose the inherited content-editable deletion surface unchanged.
6. Keep **Captions** separate: Transcript is text for reading, copying, and future text editing;
   Captions are text rendered in the video. Both derive from the same clip-scoped source-time words.
7. Add a versioned custom vocabulary for names such as Claude Code, MCP, and Anthropic.
8. Remove a selected text range through the same normal timeline trim operation and one Undo step.
9. Detect repeated phrases and false starts as review suggestions. Never call them “takes”.
10. Keep transcript, captions, pause protection, and timeline edits on one source-time mapping.

### Next small creator slice — Transcript and Copy

This is a small utility slice, not the full text editor:

- reveal one Transcript icon in the existing right rail;
- replace only the recognizer adapter, not the queue or project model: route Parakeet v3 through
  the current local transcription queue and clip-scoped timing contract;
- replace the inherited content-editable presentation with a calm, selectable reading view;
- show transcription progress per clip without blocking the editor;
- let a word click seek the preview;
- copy the complete current edit with one button and temporary neutral check feedback;
- compute copied text from project data rather than the rendered DOM;
- keep **Copy with timestamps**, speaker labels, find/replace, and text-based removal for later.

Acceptance checks:

- a multi-clip project copies words in timeline order with one paragraph per clip;
- removed clips and words inside applied trims do not enter the copied text;
- Split, reorder, Undo, Redo, save, and reopen preserve copy order and word ownership;
- a missing or failed transcript shows one clear Transcribe or Retry action;
- a 90-minute project remains responsive while the pane is open;
- captions and copied text still resolve from the same word timing;
- Parakeet word starts and ends stay aligned through long-file chunk seams, Split, trim, speed,
  reorder, save, reopen, preview seeking, and native export;
- this Mac has Klippt's verified 482 MB Parakeet v3 cache, while a clean install downloads and
  verifies its own model without Koett;
- model load and transcription run after editor entry, cancel for a new recording, and never make
  the 90-minute project UI unresponsive;
- the shipped app includes the FluidAudio and Parakeet model license notices.

### Parked transcript hardening

The first Transcript slice and its bounded source pipeline are complete. Do not make more transcript
features the next product slice. A real 80-minute project exposed the old renderer-side full decode,
which briefly used about 2.4 GB of memory; the replacement keeps extraction and recognition in the
main process and holds one short PCM window at a time. Keep custom vocabulary, mixed-import
diarization, safe text-based editing, and subjective ASR tuning in the backlog until the creator
corpus and paid-alpha gates need them. The release gate still requires a real 90-minute RSS,
responsiveness, seam, and cancellation run on the signed app.

Implementation status on 2026-08-22:

- **Implemented:** the **Pacing** section of the right-side **Audio** pane has Natural, Balanced,
  and Tight pacing; live policy tuning; reusable presets; selected-range preview; and one-step
  batch Apply.
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
- **Automatic pacing:** treat slow camera growth during sustained speaker-led moments and a faster
  return when meaningful screen interaction resumes as a measurable editing hypothesis, not a
  universal retention rule. Build it from existing camera, microphone, cursor, and screen-activity
  observations. Keep the result sparse, deterministic, non-overlapping, and stored as ordinary
  editable camera regions. Put timing, growth, exit speed, motion style, and density in a versioned
  typed policy so presets can tune them without a new analyzer;
- **Supporting media:** let the creator add or drag selected images, video, diagrams, and B-roll at
  a timeline point. Klippt can fit the asset, add a restrained entrance/exit, adapt it to delivery
  shapes, and make every choice editable. It must not fetch, invent, publish, or license media
  without the creator's clear action;
- **Optional sound and music direction:** suggest licensed or user-owned music and sound effects,
  with audition, timing, gain, ducking, and removal controls. Keep suggestions off by default and
  never create surprise copyright exposure. Motion, sound, and extra media must serve the idea or
  clarify a change; they must not become constant activity added only to chase retention;
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
4. **Done on the development Mac:** Build the packaged Klippt app and verify current projects,
   preferences, capture permission, and the legacy user-data location. Clean-Mac verification
   remains part of the signed alpha test.
5. **Done:** Developer ID signing and notarization proof. Dyberg & Co AB's paid Apple
   Developer membership is active. A Developer ID Application certificate is installed, backed up,
   and accepted by a real signed Klippt build. A separate Klippt app-specific password is validated
   in the local `klippt-notary` Keychain profile and stored as a private GitHub Actions secret. The
   first signed Apple Silicon DMG is accepted under submission
   `ce41d670-4071-4e1a-b1b7-8939cc74aa4c`. Apple's ticket is stapled, `stapler validate` passes,
   and Gatekeeper reports `source=Notarized Developer ID`. A one-submission local monitor completed
   the final steps and then unloaded and disabled itself. The exact accepted app is installed at
   `/Applications/Klippt.app`; the prior Apple Development-signed bundle remains in a recoverable
   local backup. The notarized app was not auto-launched.
6. **Done:** Use a private-alpha update channel that does not require a GitHub repository token in
   customer installs. Stable builds publish immutable artifacts first and mutable manifests last to
   the private `klippt-updates` R2 bucket at `updates.dyberg.co/klippt`. The generated macOS app
   includes this feed even when CI packages with `electron-builder --dir`.
7. **Done:** Save diagnostics only after a user action. Exclude project documents, media,
   transcripts, cursor/keyboard telemetry, and credentials. Bound and redact remaining logs before
   writing a local `klippt-diagnostic-*.json` file. Do not upload diagnostics automatically.

## Recording-HUD refinement — implemented

The recording workspace now uses one HUD surface that changes density with the recording state.

1. Keep the full two-row surface while idle and paused, when source controls and clip history matter.
2. During active recording, the same surface collapses into one compact pill with the recording
   indicator, total time, Pause, and Stop.
3. Keep the pill visible, readable, draggable, and slightly translucent. Do not make it fully
   transparent or let the backing window block input outside the painted pill.
4. The full surface returns on Pause or explicit expansion without moving the native window.
5. The configurable global Pause/Continue shortcut defaults to `Command-Shift-Space` on macOS.
   Do not use `Command-Space`, because macOS reserves it for Spotlight.
6. The 240–280 ms state transition uses a short ease-out curve and honors reduced-motion settings.
   Continue to measure click interception, startup lag, focus stealing, and recording stability in
   long real recordings.
7. **Done on 2026-08-28:** the idle HUD first appears without activating itself on macOS. The user
   can click another application immediately. A deliberate HUD click still makes its controls
   interactive, and the HUD keeps its always-on-top behavior.

## Accessibility and keyboard interaction — implemented

The recording HUD, editor, project dialogs, timeline splitters, and export dialog now share a
tested keyboard and focus contract. Visible controls have accessible names and focus indicators.
Dialogs contain and restore focus. Tooltips also open from keyboard focus. The editor leaves Tab to
normal navigation and uses Alt-Up or Alt-Down for annotation cycling. Reduced Motion removes
decorative HUD, timeline, pane, and dialog animation without removing state feedback. A real-browser
smoke protects these paths, while a native policy test protects the macOS non-activating HUD show.
