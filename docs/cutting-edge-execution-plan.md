# Klippt cutting-edge execution plan

- Status: active
- Created: 2026-08-28
- Product source of truth: [`../AGENTS.md`](../AGENTS.md)
- Product roadmap: [`../PRODUCT_PLAN.md`](../PRODUCT_PLAN.md)
- Research source: `~/Documents/Notes/Agent/03 - Research/Other/2026-08-28 Finding cutting-edge upgrades for Klippt.md`

## Purpose

This is the complete implementation plan for moving Klippt from its current working product into a
safe paid Mac alpha, then into a differentiated creator product.

The order is intentional. Agents complete low-risk, independent work first. Olle is needed only at
explicit hold points for irreversible identity choices, listening judgments, account actions,
legal approval, or physical clean-Mac checks.

Klippt keeps its current architecture:

- Electron and React for the application shell and editor.
- Swift, ScreenCaptureKit, and AVFoundation for native Mac capture.
- Rust, Metal, and VideoToolbox for preview composition and export.
- Normal MP4 clips, isolated audio roles, cursor/input sidecars, and non-destructive project edits.
- One deterministic automatic-direction plan that produces ordinary editable timeline regions.
- One project model shared by the UI, CLI, and future agent bridge.

Do not rewrite the app in Swift. Do not add a second AI timeline. Do not add detectors only because a
new model or paper exists.

## Labels

| Label | Meaning |
| --- | --- |
| **AUTO** | An agent can implement, test, review, and document this without Olle. |
| **HOLD** | An agent prepares the complete change, but Olle must make one decision or perform one real-world action before release. |
| **LAB** | Build only as an isolated prototype. It cannot affect normal projects or release packages until its gate passes. |
| **LATER** | Keep in the roadmap. It does not block the paid alpha or the next product gate. |

## Operating rules

1. Preserve source media. Every edit and derived artifact stays reversible.
2. Protect the dirty worktree. Do not mix unrelated changes or create a blind checkpoint.
3. Use one small branch or isolated worktree per risky migration.
4. Add characterization tests before changing a large or mixed-responsibility module.
5. Keep preview, native preview, GUI export, CLI export, and agent commands on shared contracts.
6. Keep automatic work local, deterministic, versioned, and editable.
7. Fail closed for privacy, source identity, permissions, media corruption, and stale revisions.
8. Record the actual encoder, model, source role, timing basis, and derived-artifact identity.
9. Measure before optimizing. Keep performance changes only when a representative benchmark wins.
10. Do not combine Electron, React, Vite, TypeScript, N-API, FFmpeg, and media changes in one upgrade.
11. Do not use TestSprite.
12. Finish each slice with tests, an independent review, a product-plan update, and a rollback point.

## Execution map

```text
Wave 0: Protect and measure
  ├─ checkpoint preparation
  ├─ dependency and release gates
  ├─ test corpus scaffolding
  └─ performance and failure telemetry
          │
          ▼
Wave 1: Paid-alpha correctness
  ├─ atomic export
  ├─ explicit audio roles and bounded transcription
  ├─ exact SDR / FPS / encoder contracts
  ├─ decoded AAC validation
  └─ bounded export audio
          │
          ▼
Wave 2: Desktop security and identity
  ├─ secure app/media protocol
  ├─ narrow IPC and capture permissions
  ├─ supported Electron
  ├─ release provenance and licences
  └─ Dyberg-owned bundle identity ── HOLD A
          │
          ▼
Wave 3: Paid-alpha proof
  ├─ long-session soak and fault matrix
  ├─ signed/notarized update proof
  ├─ commercial entitlement path ───── HOLD B
  ├─ legal/support pages ───────────── HOLD C
  └─ clean-Mac validation ──────────── HOLD D
          │
          ▼
Wave 4+: Differentiation
  ├─ native camera
  ├─ phrase-level voice leveling
  ├─ labelled automatic editing
  ├─ editable vertical reframing
  ├─ ProRes/source bundles
  └─ agent-native command parity
```

## Release gates

### Gate A — Safe implementation base

All of these conditions must hold before a broad migration:

- The current source is reviewed, committed, pushed to the private remote, and tagged.
- A clean isolated checkout builds with the pinned Node, npm, Rust, Swift, and native toolchain.
- Recordings, caches, models, generated binaries, signing material, and secrets are absent from Git.
- The npm lock has no known high or critical advisory.
- Rust, Swift, native helper, model, and binary dependencies have an inventory.
- Normal development and release packages can be traced to one source commit.

### Gate B — Paid-alpha trust

- A failed export never replaces an existing good file.
- Transcript, VAD, pause analysis, preview, export, and source bundles identify microphone and system
  audio explicitly.
- Long transcription and export use bounded memory.
- Preview and export agree on timing, crops, color, frame rate, audio, and direction-group behavior.
- The app uses a supported Electron major with `webSecurity` enabled.
- Every privileged IPC and capture permission checks origin, frame, window role, sender, and payload.
- The paid package has a Dyberg-owned identity and complete licence notices.
- Finished AAC is measured after decoding.
- A three-hour creator session stays synchronized and recoverable.

### Gate C — Paid Mac alpha

- One real purchase, activation, offline grace, cancellation, and restore flow works.
- Privacy, terms/EULA, refund, support, and third-party notice pages are live.
- The signed and notarized app installs and updates through the intended private-alpha path.
- A clean Mac completes install, permissions, record, pause, continue, remove, stop, edit, export,
  relaunch, update, and recovery.
- No open Critical or Important issue can cause media loss, project corruption, privilege misuse,
  billing lockout, or preview/export disagreement.

### Gate D — Creator beta

- Automatic direction meets the labelled-corpus correction target.
- 16:9 and 9:16 variants remain one project with editable framing.
- Native camera or the retained browser camera path passes the same sync and recovery gate.
- Audio cleanup and leveling remain optional, non-destructive, and consistent in preview/export.
- Normal creators can make complete 30–60 minute videos without developer intervention.

## Wave 0 — Protect and measure first

Everything in this wave is **AUTO**. It gives later agents a safe base and produces no visible product
change unless noted.

### W0.1 — Prepare and create the current checkpoint

- Label: **AUTO**
- Priority: P0
- Depends on: nothing

Work:

1. Inventory every tracked and untracked path in the live worktree.
2. Classify each path as product source, documentation, test fixture, generated artifact, cache,
   model, recording, credential, or unknown.
3. Inspect ignore rules and the staged diff for secrets, recordings, model weights, native build
   output, notarization files, and user-specific data.
4. Run the complete current verification matrix.
5. Create intentional commits by product slice. Do not use one blind “everything” commit.
6. Push to the private `oEdyb/record` remote.
7. Tag the verified state and record the build/runtime versions.
8. Prove that a fresh isolated checkout can restore dependencies and build.

Acceptance:

- The private remote contains the complete product source.
- The tag identifies one known-good state.
- A fresh checkout builds without hidden local files.
- No personal recording, secret, model cache, or generated package entered Git.

### W0.2 — Make dependency checks permanent

- Label: **AUTO**
- Priority: P0
- Depends on: W0.1

Work:

1. Keep Node `22.22.1` and npm `10.9.4` as the reproducible repository baseline.
2. Run `npm ci` only in a disposable checkout or clean CI workspace.
3. Add `npm audit --audit-level=high` and `npm audit signatures` to CI.
4. Install and run `cargo audit` for every Cargo lockfile.
5. Add `cargo deny` policies for advisories, licences, sources, bans, and reviewed duplicates.
6. Add dependency review for pull requests.
7. Add CodeQL or an equivalent static analysis lane.
8. Add full-history secret scanning with a documented false-positive process.
9. Generate one release inventory across npm, Cargo, Swift, FFmpeg, WebAssembly, models, and helpers.
10. Produce an SPDX 3.x or CycloneDX 1.7 SBOM for each release.

Acceptance:

- A vulnerable or unapproved new dependency blocks release.
- Every shipped executable, model, and WebAssembly artifact appears in the inventory.
- The audit is reproducible from the lockfiles.
- Local stale `node_modules` cannot be mistaken for the locked release dependency set.

### W0.3 — Bind release artifacts to source

- Label: **AUTO**
- Priority: P0
- Depends on: W0.1

Work:

1. Make every job resolve the release tag to one exact SHA.
2. Make every job check out that SHA.
3. Build or select the Whisper helper only from a workflow run whose `head_sha` matches.
4. Put source SHA, toolchain versions, upstream revision, and file SHA-256 values in every native
   helper artifact.
5. Verify the helper manifest before packaging.
6. Include helper and model manifests in the final release inventory.
7. Pin GitHub Actions to reviewed full commit SHAs.
8. Reduce default workflow permissions to read-only. Grant write access only to publishing.
9. Protect stable signing and publishing secrets with an approval environment.
10. Publish immutable artifacts before mutable update manifests.
11. Fetch every public feed artifact after publishing and compare size plus SHA-512.

Acceptance:

- A release cannot package a helper built from another commit.
- A manually dispatched build cannot name a different tag than its checked-out source.
- Public feeds cannot reference a missing or mismatched artifact.

### W0.4 — Close licence and notice gaps

- Label: **AUTO**, with legal confirmation in HOLD C
- Priority: P0
- Depends on: W0.2

Work:

1. Document the exact FFmpeg configuration used for `web-demuxer.wasm`.
2. Provide the matching corresponding source, required notices, and permitted relinking method.
3. Generate the complete transitive Cargo licence inventory.
4. Verify Electron, FFmpeg, FluidAudio, Parakeet, DeepFilterNet, updater, icon, font, and bundled
   asset rights.
5. Keep Clean Voice out of paid packages until the DeepFilterNet model-artifact distribution right
   is confirmed in writing.
6. Keep the Klippt helper code proprietary. Do not label it MIT only because an upstream dependency
   offers MIT.
7. Make the release notice set reproducible from the release inventory.

Acceptance:

- `THIRD-PARTY-NOTICES.md` has no unresolved shipped-artifact placeholder.
- The WebAssembly binary, corresponding source, configuration, and notice set match.
- Every paid package has a generated, reviewed notice inventory.

### W0.5 — Build one versioned creator corpus harness

- Label: **AUTO** for infrastructure; later samples can enter through normal dogfood use
- Priority: P0
- Depends on: W0.1

Work:

1. Define a versioned corpus manifest with consent, source role, language, device, app/context,
   resolution, FPS, aspect ratio, noise condition, duration, and expected invariants.
2. Keep raw fixtures outside Git when licences or privacy require it. Store hashes and metadata.
3. Separate development, tuning, and locked holdout sets.
4. Add reproducible fixture extraction for short committed regression cases.
5. Add result schemas for capture, export, audio, ASR, automatic direction, and UI performance.
6. Store tool, model, policy, and source hashes with every result.
7. Never silently move a holdout failure into the tuning set.

Initial corpus coverage:

- Swedish, English, code-switching, names, and technical vocabulary.
- Laptop mic, external mic, system audio, bleed, quiet room, noisy room, and low-level speech.
- IDE, terminal, browser, spreadsheet, small text, scrolling, drag selection, typing, and app changes.
- 1440p and 4K, 30 and 60 fps, camera motion, low light, and device disconnects.
- 16:9, 9:16, square, and stacked screen/camera layouts.
- Short fixtures plus 30-minute, 3-hour, and 8-hour soak projects.

Acceptance:

- Every automatic or model upgrade can run against the same locked fixtures.
- Results can distinguish tuning improvement from holdout overfitting.
- No private text, audio, video, or identity enters telemetry or Git without explicit consent.

### W0.6 — Add media workload telemetry

- Label: **AUTO**
- Priority: P0
- Depends on: W0.1

Measure locally:

- Capture and camera FPS requested versus delivered.
- Pending and dropped frames.
- Capture, camera, mic, and system-audio timestamps and drift.
- Writer queue depth and fragment-finalization time.
- VideoToolbox hardware-encoder selection and fallback.
- Preview Metal readback, native-boundary, IPC, browser main-thread, and draw time.
- Export phase duration and throughput.
- Audio block and queue memory.
- Process RSS and estimated GPU allocation.
- Thermal state, Low Power Mode, and camera pressure state.
- Disk free space, write latency, and disk-full transition.

Rules:

- Keep normal telemetry local and inspectable.
- Do not send filenames, URLs, transcripts, cursor/key events, audio, video, window titles, or project
  names.
- If remote crash/performance telemetry is added later, use separate consent and structured codes.
- Never silently lower screen resolution or source FPS under pressure.

Acceptance:

- Every long-session failure has a phase, resource, and fallback record.
- Performance claims use measured percentile data, not one terminal sample.
- Normal recording remains more important than background analysis or export.

### W0.7 — Add an accessibility and interaction smoke lane

- Label: **AUTO**
- Priority: P1
- Depends on: W0.1

Work:

1. Add an automated accessibility smoke for launch, editor, recording HUD, modal, and export flows.
2. Replace click-only overlay elements with semantic controls or complete keyboard behavior.
3. Audit every `outline: none` rule for a visible focus replacement.
4. Ensure tooltip help works with keyboard focus and assistive technology.
5. Remove `autoFocus` where it steals the user's position during editor updates.
6. Verify Reduce Motion in the recording HUD, timeline, pane changes, and modal transitions.
7. Test full keyboard recording and editing flow.

Acceptance:

- Core tasks work without a pointer.
- Focus is visible and stable.
- No tooltip contains the only available explanation.
- Motion reduction changes animation without removing state feedback.

## Wave 1 — Paid-alpha correctness

Start this wave after Gate A. Most work remains **AUTO**.

### W1.1 — Make export output atomic

- Label: **AUTO**
- Priority: P0
- Depends on: W0.1, W0.6

Implementation:

1. Resolve the final destination and create a unique staging file in the same directory.
2. Preserve an existing final file until verification succeeds.
3. Preflight available capacity for the expected output plus safety margin.
4. Recheck capacity during long exports.
5. Write and finish every video, audio, and container stream to staging.
6. Reopen the result and verify stream presence, dimensions, codec, duration, timestamps, color,
   frame rate, audio layout, and decoder readability.
7. Synchronize the file and, where supported, its directory.
8. Atomically rename staging to final.
9. Clean abandoned staging safely during startup.
10. Return structured failure phases to the UI and CLI.

Tests:

- Cancel at startup, mid-frame, audio flush, trailer, verification, and rename.
- Force disk full at each phase.
- Replace an existing output and prove it survives every failed attempt.
- Export to local APFS, external media, and a slow destination.
- Verify that partial files never appear as finished exports.

### W1.2 — Make transcript source roles explicit

- Label: **AUTO**
- Priority: P0
- Depends on: W0.5

Implementation:

1. Extend the transcription request with an explicit source role.
2. Resolve `qac` as **You** for native Klippt recordings.
3. Optionally resolve `qab` as **System** and transcribe it independently.
4. Never transcribe `qaa` unless the user imported or explicitly selected the mixed track.
5. Merge timestamped role transcripts after recognition. Do not mix PCM first.
6. Preserve stable word IDs, source times, source role, backend, model and artifact hashes, language
   evidence, confidence, and alignment method.
7. Use diarization only for mixed imports whose source role is unknown.
8. Fail clearly when role metadata is absent or inconsistent. Do not guess silently.

Tests:

- Mic speech plus unrelated system speech.
- System-only speech.
- Duplicate speech in preview mix.
- Mic muted, system enabled; system muted, mic enabled.
- Split, trim, reorder, speed, save/reopen, and source bundle.
- Transcript and pause-analysis agreement on the same mic samples.

### W1.3 — Make long transcription bounded

- Label: **AUTO**
- Priority: P0
- Depends on: W1.2

Implementation:

1. Move extraction to a bounded native or main-process worker.
2. Decode the selected role directly to the backend's required sample format.
3. Process fixed-duration chunks with explicit overlap.
4. Preserve absolute sample time, decoder delay, and chunk-seam ownership.
5. Stream results instead of accumulating complete-session PCM in the renderer.
6. Support cancellation, model unload, memory pressure, and project close.
7. Make cache identity include source content, role, extraction contract, backend, model, language,
   vocabulary, and alignment version.

Acceptance:

- A 90-minute project stays responsive.
- RSS reaches a plateau.
- No missing or duplicated words occur at chunk seams.
- Cancellation stops decode and inference promptly.
- A stale or partial cache is rejected.

### W1.4 — Qualify the corrected Parakeet encoder

- Label: **AUTO**, with optional Olle blind review at HOLD E
- Priority: P0
- Depends on: W0.5, W1.2, W1.3

Implementation:

1. Add the exact FluidAudio issue-760 reproduction as a regression fixture.
2. Pin a reviewed FluidAudio commit containing the int8 v2 encoder or a later verified release.
3. Pin the exact new model commit and every artifact hash.
4. Select `.int8V2` explicitly.
5. Keep the current Parakeet and Whisper paths available in the benchmark harness.
6. Compare Swedish, English, code-switching, names, code terms, silence, music, and long recordings.
7. Measure WER, named-term accuracy, word-time error, hallucinations, model load, ANE use, memory,
   real-time factor, and thermal state.
8. Prefer the verified Whisper fallback for a language/device/case that fails the gate.

Acceptance:

- The issue-760 fixture passes.
- The candidate does not regress the locked creator holdout.
- Model provenance and hashes are reproducible.
- The editor reports the real backend and model identity.
- The product does not claim acoustic language identification until the backend exposes it.

### W1.5 — Lock one SDR color contract

- Label: **AUTO**
- Priority: P0
- Depends on: W0.5

Implementation:

1. Define capture source interpretation.
2. Define compositor working color space and texture assumptions.
3. Define RGB-to-YUV matrix and video/full range.
4. Set BT.709 primaries, transfer, matrix, and container metadata.
5. Apply the same contract to preview, H.264, HEVC, ProRes, thumbnails, and source bundles where
   applicable.
6. Report source and output color metadata in diagnostics.
7. Keep HDR out of normal settings until the separate LAB gate passes.

Tests:

- Black, near-black, white, saturated patches, skin tones, thin terminal text, gradients, and alpha.
- QuickTime, Chromium preview, decoded export, YouTube sample, Final Cut, and Resolve.
- Metadata and decoded-pixel comparisons across hardware and fallback encoders.

### W1.6 — Preserve source and selected frame rate

- Label: **AUTO**
- Priority: P0
- Depends on: W0.6

Implementation:

1. Carry rational source and chosen output frame rates through project, scene, preview, and export.
2. Remove unconditional 30-fps fallbacks.
3. Support exact 24, 30, and 60 presets and rational 23.976, 29.97, and 59.94 where required.
4. Keep capture frame reordering disabled for recovery.
5. Permit export B-frames only through an explicit tested codec policy.
6. Report requested, source, delivered, and output FPS separately.

Acceptance:

- Duration differs by no more than one output frame.
- No cadence duplication appears in 24/30/60 fixtures.
- Audio/video drift remains within the release gate.
- Size estimates change with resolution, FPS, codec, and quality.

### W1.7 — Make encoder selection truthful

- Label: **AUTO**
- Priority: P0
- Depends on: W0.6, W1.5, W1.6

Implementation:

1. Derive candidates from the encoders present in the bundled FFmpeg and runtime VideoToolbox.
2. Remove unavailable `libopenh264` and `libkvazaar` claims unless the shipped build gains them.
3. Add the VideoToolbox-surface HEVC candidate before any software fallback.
4. Report selected codec, encoder, hardware state, profile, GOP, rate mode, target, and fallback reason.
5. Define H.264 export policy: High profile, CABAC, closed GOP, tested keyframe interval, VBR, and
   export-only B-frames when supported.
6. Replace the fixed HEVC 0.6 size assumption only after the codec corpus measures it.

Acceptance:

- The UI, CLI, logs, diagnostics, and file probe agree on the actual encoder.
- Hardware selection is confirmed rather than assumed from an encoder name.
- Missing hardware produces an honest fallback or a clear unsupported result.

### W1.8 — Validate decoded AAC delivery

- Label: **AUTO**
- Priority: P0
- Depends on: W0.5, W1.1

Implementation:

1. Keep 48 kHz stereo AAC-LC at 384 kbps as the normal MP4 delivery setting.
2. Name `-14.5 LUFS` and `-2 dBTP` the **Klippt Creator** preset.
3. Encode through the shipped path.
4. Decode through the shipped FFmpeg.
5. Decode a golden subset through AudioToolbox.
6. Measure integrated LUFS, decoded true peak, duration, encoder priming, final tail, NaN, clipping,
   and discontinuities.
7. If decoded peak exceeds `-1 dBTP`, reduce gain and re-encode.
8. If target loudness would require destructive limiting, preserve dynamics and report achieved
   loudness.

Acceptance:

- Decoded true peak is no higher than `-1 dBTP`.
- No sentence tail is clipped.
- Duration and sync remain inside the release gate.
- GUI and CLI create the same mastered result.

### W1.9 — Stream export audio in bounded blocks

- Label: **AUTO**
- Priority: P0
- Depends on: W0.6, W1.8

Implementation:

1. Decode fixed-duration blocks.
2. Retain only resampler, time-stretch, fade, gain, compressor, and limiter state.
3. Use a bounded first pass for global loudness analysis.
4. Encode during a bounded second pass.
5. Keep microphone, system, voiceover, and other buses explicit.
6. Preserve trim, split, speed, crossfade, clean-mic replacement, and source-role behavior.
7. Record maximum block, queue, and working-set memory.

Acceptance:

- Memory does not grow with timeline duration.
- A three-hour project stays below the agreed compositor-baseline delta.
- Output matches the existing short-project golden files within defined tolerances.
- No boundary click, missing tail, source duplication, or drift appears.

### W1.10 — Add source-health analysis

- Label: **AUTO**
- Priority: P1
- Depends on: W0.5, W1.2

Measure without changing audio:

- Sample rate and channel layout.
- Timestamp or sample discontinuities.
- DC offset.
- Hard/soft clipping and peak hold.
- Silent or empty channels.
- Polarity and phase risk during downmix.
- Broadband noise floor and hum candidates.
- Microphone/system delayed correlation and possible bleed.
- Approximate reverberation evidence.

Safe automatic actions:

- Select a non-empty correctly tagged channel.
- Downmix only after a phase-safety check.
- Apply DC blocking only above a measured threshold.
- Resample once through a pinned path.
- Report clipping or discontinuity instead of inventing replacement samples.

## Wave 2 — Desktop security, product identity, and release integrity

Most of this wave is **AUTO**. Bundle identity becomes **HOLD A** only after the migration is fully
prepared and tested in isolation.

### W2.1 — Add a secure application and media origin

- Label: **AUTO**
- Priority: P0
- Depends on: W0.1

Implementation:

1. Register a standard secure app origin such as `klippt://app`.
2. Register project media through opaque IDs, not encoded filesystem paths.
3. Enable the exact protocol privileges required for standard origin, secure fetch, streaming, and
   controlled CORS. Never enable `bypassCSP`.
4. Keep an app-owned registry from opaque media ID to approved canonical path and source revision.
5. Validate origin, media ID, project ownership, range, method, and cancellation.
6. Support `GET`, `HEAD`, one byte range, `206`, `Content-Range`, `Accept-Ranges`, correct lengths,
   and `416`.
7. Reject traversal, arbitrary absolute paths, unknown IDs, stale IDs, and unsupported methods.
8. Add seek tests for MP4, MOV, WebM, waveform extraction, Mediabunny, WebCodecs, and CLI playback.

Acceptance:

- Long media seeks and scrubs correctly.
- Unknown origins and IDs cannot read local files.
- `http:`, `data:`, arbitrary `file:`, subframes, and remote pages cannot reach approved media.

### W2.2 — Restore renderer security defaults

- Label: **AUTO**
- Priority: P0
- Depends on: W2.1

Implementation:

1. Restore `webSecurity: true` for the editor and CLI renderer.
2. Add a restrictive CSP without unsafe remote script or arbitrary connect sources.
3. Deny navigation away from the exact app origin.
4. Deny `window.open` by default. Route allowlisted external URLs through main.
5. Deny unexpected webviews, subframes, downloads, and permission requests.
6. Set `sandbox: true` explicitly and enable the app sandbox mode that prevents configuration drift.
7. Keep `nodeIntegration: false` and `contextIsolation: true`.

Tests:

- Stored and generated content containing HTML, script, URLs, images, frames, and navigation.
- Development origin and production origin.
- External link allowlist.
- Renderer reload and recovery paths.

### W2.3 — Create one privileged IPC boundary

- Label: **AUTO**
- Priority: P0
- Depends on: W2.2

Implementation:

1. Add one registration wrapper for every privileged `ipcMain.handle` and `ipcMain.on`.
2. Validate exact origin, top-level frame, expected `webContents`, window role, lifecycle, and payload
   schema.
3. Split the shared preload into the smallest surfaces needed by editor, HUD, setup, CLI, entitlement,
   and updater windows.
4. Return structured errors without leaking paths or secrets.
5. Convert save-dialog output into a short-lived export-path capability.
6. Make export consume the capability instead of an arbitrary absolute path.
7. Restrict reveal-in-folder to known current project, media, export, and diagnostics paths.
8. Deny destroyed windows, stale capabilities, subframes, remote frames, and wrong-role calls.

Acceptance:

- A compromised low-trust window cannot call recording, export, filesystem, entitlement, or LLM
  methods outside its role.
- Every privileged method has a negative sender and payload test.

### W2.4 — Restrict capture permissions

- Label: **AUTO**
- Priority: P0
- Depends on: W2.3

Implementation:

1. Allow screen, camera, and microphone requests only from the trusted top-level app frame.
2. Require the expected recording/setup window role.
3. Bind the selected screen result to the active recording session.
4. Deny remote, unknown, subframe, editor-only, and CLI callers unless their role explicitly needs
   the permission.
5. Clear session capabilities on close, cancel, crash, and transition.

Acceptance:

- Wrong-origin and wrong-role capture tests fail.
- Normal setup, pause reconfiguration, camera preview, and recording still work.

### W2.5 — Migrate to a supported Electron line

- Label: **AUTO**
- Priority: P0
- Depends on: W2.1–W2.4

Sequence:

1. Use a clean isolated install of locked Electron 41.10.7 as the short stabilization baseline.
2. Capture behavior and package goldens.
3. Migrate one supported major at a time: 41 → 42 → 43 → 44.
4. Rebuild every native `.node` binary after each major.
5. Keep the smallest version that passes as a temporary fallback, but target Electron 44 for the
   paid alpha.
6. Do not combine React 19, Vite 8, TypeScript 7, Motion 13, FFmpeg 9, or N-API 3 with this work.

Gate each major on:

- Screen, camera, mic, system audio, and permissions.
- Pause, Continue, Remove Previous Clip, Stop, and recovery.
- Media protocol seek, waveform, Mediabunny, and WebCodecs.
- Native add-on loading and handle lifecycle.
- Preview, export, CLI, updater, signing, notarization, and both Mac architectures.

### W2.6 — Review hardened-runtime entitlements and fuses

- Label: **AUTO**
- Priority: P0
- Depends on: W2.5

Entitlements:

1. Split main-app and helper entitlement files.
2. Test removal of unsigned executable memory first.
3. Test removal of disabled library validation next.
4. Keep JIT or other exceptions only where the shipped runtime proves they are required.
5. Verify microphone, camera, and screen entitlements only on components that need them.

Fuses after the secure protocol works:

- Disable RunAsNode.
- Disable production `NODE_OPTIONS`.
- Disable CLI inspect in production.
- Enable ASAR integrity.
- Load application code only from ASAR.
- Disable unneeded `file://` privileges.

Acceptance:

- Packaged app launches, records, previews, exports, updates, and notarizes.
- A changed ASAR or unsigned injected library is rejected.

### W2.7 — Prepare the Dyberg-owned identity migration

- Label: **AUTO** until HOLD A
- Priority: P0
- Depends on: W0.1, W2.5

Prepare:

1. Use `app.klippt.desktop` as the working bundle-ID candidate.
2. Replace OpenScreen application identities in Mac, Windows Store, Linux metadata, protocol,
   updater, and example configuration.
3. Keep legacy project formats readable.
4. Add a one-time migration for user data, settings, entitlements, model/cache ownership, recovery
   journals, and recent-project state.
5. Test side-by-side old/new installation and rollback.
6. Test macOS TCC permission behavior, Keychain access, updater identity, `.klippt` association, Dock,
   Finder, and project opening.
7. Preserve the old data until the new app proves a successful migration.

HOLD A — Olle:

- Approve the final immutable bundle identifier and visible publisher identity.

After approval:

- Freeze the identifier in release documentation and CI.
- Never change it casually after paid distribution starts.

### W2.8 — Harden updates and release archives

- Label: **AUTO**
- Priority: P0
- Depends on: W2.5–W2.7

Work:

1. Notarize and staple the app before producing update ZIP and DMG where the pipeline supports it.
2. Correct any documentation that claims an unstapled ZIP is stapled.
3. Verify an actual quarantined update from the private feed.
4. Verify signature, bundle ID, version, public size, SHA-512, and expected source SHA.
5. Reject a wrong-signer or wrong-bundle update.
6. Keep Windows release out of the paid Mac alpha. A later Windows release requires Authenticode,
   publisherName, wrong-signer tests, and signed NSIS artifacts.

## Wave 3 — Paid-alpha proof and hold points

### W3.1 — Run the long-session and fault matrix

- Label: **AUTO** for automated and same-machine runs
- Priority: P0
- Depends on: Waves 0–2

Test:

- 30-minute, three-hour, and eight-hour recording sessions.
- 4K60 screen with the highest supported camera mode.
- Mic-only, system-only, both, camera off/on, cursor/input telemetry, and hundreds of clips.
- Low Power Mode and serious thermal pressure.
- Less than 10 GB free space and actual disk full.
- Display sleep, display replacement, permission changes, and device hotplug.
- Force kill during capture startup, fragment write, Pause, Continue, Stop, recovery, export, trailer,
  verification, and rename.
- Repeated launch, close, sleep/wake, and update.

Hard gates:

- Zero fatal writer error in the passing matrix.
- Zero unexplained timestamp discontinuity.
- Audio/video drift at or below one frame and 20 ms after three hours.
- Crash loss no greater than one fragment plus one GOP.
- Correct role tags in every recovered clip.
- Bounded RSS after warm-up.
- Existing completed media survives later failure.

### W3.2 — Run the codec and export-quality matrix

- Label: **AUTO**
- Priority: P0
- Depends on: W1.1, W1.5–W1.9

For 10–20 representative projects compare:

- H.264 and HEVC at equal quality and equal bitrate.
- Wall time, throughput, energy, thermal state, and hardware selection.
- Size, VMAF NEG, SSIM, PSNR, OCR retention, text-edge retention, banding, and color patches.
- QuickTime, YouTube, Final Cut, and Resolve playback.
- 24/30/60 and rational frame rates.
- Decoded audio loudness, peak, duration, and sync.

Only after this matrix:

- Replace the HEVC size estimate.
- Select a default quality/bitrate policy.
- Decide whether a fast edit-free remux path has enough real eligible projects to build.

### W3.3 — Complete entitlement and checkout proof

- Label: **HOLD B**
- Priority: P0 commercial
- Depends on: Waves 1–2

Agents prepare:

- Product, variant, price, trial, checkout, webhook, activation, device, offline grace, cancellation,
  restore, refund, and expired read-only behavior.
- Test fixtures and sandbox account paths.
- Recovery from webhook delay, duplicate webhook, clock change, offline use, device replacement, and
  corrupt local entitlement.
- Capability checks in main process, not only disabled UI.

Olle must:

- Provide or approve the final Lemon Squeezy public identifiers.
- Complete one real controlled purchase and cancellation when the package is ready.

Acceptance:

- A valid customer can activate, work offline during grace, restore, and update.
- An expired customer can inspect projects and recover raw media but cannot record, import, edit,
  regenerate, or export a finished video.
- Payment failure cannot corrupt a project or source file.

### W3.4 — Complete legal and support pages

- Label: **HOLD C**
- Priority: P0 commercial
- Depends on: W0.4, W2.7

Agents prepare:

- Terms/EULA.
- Privacy policy.
- Refund and cancellation policy.
- Support and contact page.
- Third-party notices and model disclosures.
- Local-processing and optional-download explanations.
- Trial and expired-access behavior.
- Clear distinction between Klippt Creator loudness preset and platform rules.

Olle must:

- Approve the public wording and business details.
- Obtain legal review where needed.

### W3.5 — Clean-Mac release test

- Label: **HOLD D**
- Priority: P0 commercial
- Depends on: W2.8, W3.1–W3.4

Agents prepare one exact checklist and diagnostic bundle. Olle or another trusted person must use a
Mac that has never run the development app.

Test:

1. Download through the real path.
2. Verify Gatekeeper and notarization.
3. Install and launch.
4. Grant screen, mic, and camera permissions.
5. Record, Pause, Continue, Remove Previous Clip, Stop, and recover.
6. Edit, regenerate, transcribe, shorten pauses, and export.
7. Quit, relaunch, reopen, and restore settings.
8. Activate and exercise trial/offline/restore behavior.
9. Install an update through the real channel.
10. Remove the app while preserving or intentionally removing user data.

No agent can honestly replace this physical gate on the current development Mac.

## Wave 4 — Creator audio quality

This wave follows paid-alpha correctness. Normal processing remains optional.

### W4.1 — Phrase-level microphone leveling

- Label: **AUTO**, then optional HOLD E listening
- Priority: P1
- Depends on: W1.8–W1.10

Implementation:

1. Derive phrase candidates from conservative speech and transcript regions.
2. Measure speech-only K-weighted loudness.
3. Exclude uncertain, whispered, laughed, clipped, or music-overlapped spans from target estimation.
4. Create a continuous mic-only gain envelope.
5. Freeze gain during pauses so room tone does not rise.
6. Smooth edit boundaries.
7. Use the same envelope in preview and export.
8. Keep one normal Undoable setting and show the applied envelope only in Advanced inspection.

Starting hypotheses:

- Maximum correction: ±6 dB.
- Attack: 250–500 ms.
- Release: 0.8–1.5 seconds.
- Normal gain slew: at most about 2 dB/s.
- Ignore phrases shorter than about 300 ms.

Add a gentle optional soft-knee compressor only after the envelope passes. Do not default to static
EQ, aggressive de-essing, dereverberation, or generative speech replacement.

### W4.2 — Complete the Clean Voice product gate

- Label: **LAB** until all gates pass
- Priority: P1
- Depends on: W0.4, W0.5, W1.10

Work:

1. Confirm commercial distribution rights for the exact DeepFilterNet model artifact.
2. Run the fixed bilingual creator corpus and locked holdout.
3. Measure semantic preservation, speaker identity, alignment, P.835-style quality, bypass rate,
   memory, RTF, and thermal state.
4. Keep raw microphone permanent and use one complete raw-or-clean resolver.
5. Keep cleanup separate from leveling and delivery normalization.
6. Preserve system audio unchanged.
7. Fall back for the complete clip on any missing, stale, corrupt, cancelled, or mismatched stem.
8. Validate packaged helper presence, freshness, signing, notarization, both Mac architectures, and
   transitive licences before inclusion.

Acceptance:

- Clean inputs remain transparent.
- No phoneme or sentence tail is lost.
- Preview and export use the same complete stem.
- Normal release remains raw while any gate is open.

### W4.3 — Compare DPDFNet as the first challenger

- Label: **LAB**
- Priority: P2
- Depends on: W0.5, W4.2 harness

Use the same extraction, timing, cache, quality, and release gates as Clean Voice. Compare quality,
semantic safety, binary/model size, CPU/ANE/GPU behavior, RTF, memory, and licence clarity. Do not
replace DeepFilterNet from model-card results.

### W4.4 — Add conservative audio-event keep evidence

- Label: **LAB**
- Priority: P2
- Depends on: W0.5

Prototype FireRedVAD or another reviewed local event detector for speech, singing, music, laughter,
and meaningful reactions. It can only add **keep** regions. It cannot authorize a cut. Keep system
audio, screen activity, transcript, raw VAD, cleaned VAD, and uncertainty as independent vetoes.

### W4.5 — Prototype offline echo/bleed reduction

- Label: **LAB**
- Priority: P2
- Depends on: W1.10

Use the exact system track as the reference. Estimate delay and drift first. Bypass under uncertain
alignment, double-talk, saturation, or low correlation. Process only a derived microphone stem. Do
not put AEC in live capture or replace the raw source.

### HOLD E — Olle audio/transcript judgment

Agents can generate blind A/B sets and measurements. Olle is needed only after automated gates pass:

- Select the more natural phrase-leveling behavior.
- Listen for pumping, breaths, room-tone lift, sibilance, lost phonemes, and changed identity.
- Compare Parakeet candidate/fallback on real creator language.
- Approve Clean Voice as opt-in or keep it in Lab.

## Wave 5 — Native camera and preview performance

### W5.1 — Cap and measure the current preview

- Label: **AUTO**
- Priority: P1
- Depends on: W0.6

1. Render preview at the visible CSS size, not export resolution.
2. Default preview to 24 or 30 fps unless a higher rate is visible and useful.
3. Keep export resolution and FPS independent.
4. Measure Metal readback, native copy, IPC, browser main-thread, and draw time.
5. Measure resize, seek, play, full-screen, and one-hour memory behavior.

Targets:

- 95th-percentile frame delivery below 33 ms at 30 fps.
- Seek to correct frame below 100 ms.
- Renderer input delay below one display frame at the 95th percentile.
- Stable memory during one hour of normal interaction.

### W5.2 — Prototype native AVFoundation camera capture

- Label: **LAB**, then promote after the complete gate
- Priority: P1
- Depends on: W0.6, W3.1

Implementation:

1. Probe exact camera resolution/FPS combinations.
2. Capture through AVFoundation with a shared host-time clock.
3. Use the same clip index, pause/continue, fragmentation, journal, recovery, and source-role model
   as screen capture.
4. Preserve camera as a separate editable source.
5. Handle device pressure, hotplug, interruption, format change, and failure.
6. Keep the floating camera monitor a low-priority non-recorded preview.
7. Keep camera crop, size, position, and zoom as editor data.

Promotion gate:

- Better or equal sync, quality, CPU, thermal, file recovery, and device behavior than MediaRecorder.
- No regression in webcam format selection.
- Three-hour drift within the normal release limit.

### W5.3 — Prototype a native Metal preview surface

- Label: **LAB**
- Priority: P2
- Depends on: W5.1 measurement

Only start if preview copies remain a measured bottleneck. Embed a native CAMetalLayer/NSView without
using private Chromium IOSurface APIs. Keep the existing preview as rollback. Require frame, seek,
input, resize, accessibility, window-lifecycle, and package tests.

### W5.4 — Benchmark ScreenCaptureKit pixel formats

- Label: **LAB**
- Priority: P2
- Depends on: W1.5, W0.6

Compare BGRA with `420v`/`420f` for bandwidth, small-text quality, conversion cost, Metal behavior,
encode throughput, power, and thermal state. Do not trade terminal/code readability for theoretical
bandwidth savings.

## Wave 6 — Automatic direction and delivery variants

### W6.1 — Turn dogfood corrections into labelled evidence

- Label: **AUTO** infrastructure; passive creator use supplies examples
- Priority: P1
- Depends on: W0.5

For each automatic region record locally:

- Observation evidence and context boundary.
- Selected target, scale, duration, and group.
- Reason for selection or rejection.
- Whether the user kept, deleted, reframed, resized, moved, or restyled it.
- Correction time.

Metrics:

- Unchanged rate.
- Delete rate.
- Missing-useful-focus rate.
- Crop violation rate.
- Scale and focal-point correction.
- Pans and entrances per minute.
- Review and correction time.
- Preview/export parity.

First holdout target: at least 80% of automatic regions remain unchanged. Never tune on the holdout
and then use it as proof.

### W6.2 — Add calm regeneration review

- Label: **AUTO**
- Priority: P1
- Depends on: W6.1

1. Show a compact before/after summary after regeneration.
2. List added, removed, changed, preserved-manual, and uncertain regions.
3. Let the user jump to an uncertain edit.
4. Add a collapsed “Why this edit?” view with evidence and policy values.
5. Keep all resulting edits as normal Zoom and Camera Emphasis regions.
6. Keep full policy parameters in Lab/Advanced, not the normal editing path.

### W6.3 — Prototype velocity-continuous connected motion

- Label: **LAB**
- Priority: P2
- Depends on: W6.1

Keep quintic smootherstep as the baseline. Prototype a velocity-continuous spring or equivalent for
connected pans. It must have zero overshoot, strict cursor containment, trim/speed parity, and
preview/export equality. Adopt only if blind review and correction metrics improve.

### W6.4 — Make delivery variants first-class

- Label: **AUTO**
- Priority: P1
- Depends on: W1.5–W1.7

1. Add a versioned `deliverables` model.
2. Keep one master clip order and shared edits.
3. Store variant-specific output shape, safe areas, layout, screen framing, camera framing, and
   automatic reframe regions.
4. Migrate current layout settings into the active variant without visible change.
5. Support 16:9, 9:16, and 1:1 from one project.
6. Preserve current 50/50 vertical stack and swap order.
7. Add direct divider drag without resetting either pane's framing.
8. Save screen and camera crop, fit, scale, and focal position independently.
9. Export one active variant, then all variants.

### W6.5 — Add editable automatic vertical reframing

- Label: **AUTO** for deterministic base; model signals remain LAB
- Priority: P1
- Depends on: W6.1, W6.4

Store normalized crop/focus rectangles, source-time keyframes, interpolation, aspect ratio, safe-area
constraints, confidence, provenance, and analysis version. Run current cursor/typing/click/direction
observations through an aspect-aware policy. Save results as normal variant-specific framing regions.
Direct preview correction promotes them to manual ownership.

Support signals can later include local text boxes, OCR geometry, face presence/stability, and motion
vectors. They can veto or support a crop. They cannot become hidden editorial truth. Do not store
screen text by default and never ask an LLM to choose pixel coordinates.

### W6.6 — Prototype multi-output render fanout

- Label: **LAB**
- Priority: P2
- Depends on: W6.4, W0.6

Decode the source timeline once, then render horizontal, vertical, and square targets into separate
Metal textures and VideoToolbox sessions. Measure total wall time, encoder concurrency, memory,
thermal state, and per-output correctness. Fall back to sequential export when the device or thermal
state cannot sustain parallel fanout.

## Wave 7 — Professional export and interchange

### W7.1 — Add ProRes master export

- Label: **AUTO**
- Priority: P1
- Depends on: W1.1, W1.5–W1.9

Add ProRes 422 LT and 422 MOV with runtime capability checks, exact color metadata, 48 kHz audio,
honest size estimates, and atomic output. Keep HQ for a later explicit need. Use 4444 only for alpha.

### W7.2 — Add an original-source bundle

- Label: **AUTO**
- Priority: P1
- Depends on: W1.2, W1.10

Bundle:

- Screen and camera source media.
- Isolated mic and system roles.
- Optional lossless 48 kHz PCM CAF or ALAC roles.
- Cursor, click, keyboard-safe, and context sidecars.
- Common time-zero manifest, gaps, discontinuities, source hashes, and roles.
- Project document and versioned processing recipes.

Keep compact AAC isolation as the normal capture default until lossless recording storage and
recovery are proven.

### W7.3 — Add current FCPXML interchange

- Label: **AUTO** generation; application import proof needs the installed apps
- Priority: P2
- Depends on: W7.1, W7.2

1. Target current FCPXML 1.14 behavior.
2. Generate an `.fcpxmld` bundle with media.
3. Use rational media times, unique IDs, file URLs, stable roles, and relinkable paths.
4. Export clips, trims, timing, retimes, camera offset, and audio roles.
5. Bake Klippt-only effects when the target cannot express them.
6. Validate against the matching DTD and import into Final Cut Pro 12.3 and Resolve 21.
7. Test 23.976, 29.97, 59.94, Unicode paths, missing media, relink, and speed changes.

Do not claim Resolve compatibility from XML validation alone.

### W7.4 — Add transparent cursor-only export

- Label: **LATER**
- Priority: P2
- Depends on: W7.1

Use ProRes 4444 or an image sequence. Do not promise transparent H.264 MP4.

### W7.5 — Evaluate an edit-free packet-remux path

- Label: **LAB**
- Priority: P2
- Depends on: W3.2 measurements

Only applies when the project has no crop, Zoom, camera composition, cursor render, captions, speed,
color conversion, audio mastering, or other rendered effect. Prove timestamp, role, duration, player,
and recovery behavior before exposing it as Fast Export.

## Wave 8 — Agent-native editing

### W8.1 — Define one typed command service

- Label: **AUTO**
- Priority: P1
- Depends on: Gate B

Every command includes:

- Project ID and expected revision.
- Stable object IDs.
- Validated typed payload.
- Dry-run plan.
- Structured validation errors.
- Idempotent operation ID.
- Atomic batch behavior.
- One Undo history entry.
- Compact before/after summary.

The UI, CLI, and agent bridge call this service. No caller edits raw project JSON or source files.

### W8.2 — Complete inspection and edit parity

- Label: **AUTO**
- Priority: P1
- Depends on: W8.1

Inspection:

- Project, assets, clips, source roles, tracks, health, trims, Zooms, Camera Emphasis, layout,
  deliverables, transcript state, audio recipes, validation, and export settings.

Commands:

- Split, Remove, Restore, reorder, trim, insert, and record boundary.
- Layout, screen framing, camera framing, and delivery variant.
- Zoom, Camera Emphasis, motion, and automatic-direction regeneration.
- Audio source selection, pause shortening, leveling, cleanup recipe, and delivery normalization.
- Validate, pack, source bundle, and export.

Parity tests:

- The same UI, CLI, and agent command sequence creates the same document, history, scene, preview,
  and export.
- A stale revision fails without overwriting work.
- A repeated operation ID does not apply twice.
- A batch becomes one Undo.

### W8.3 — Add the local agent bridge

- Label: **AUTO**
- Priority: P1
- Depends on: W8.1, W8.2

1. Keep transport thin. It can later be MCP, JSON-RPC, or another local protocol.
2. Use narrow scopes and current MCP authorization principles.
3. Expose opaque project/media IDs, never arbitrary filesystem paths.
4. Keep inspect and dry-run available without write scope.
5. Require explicit approval for external publish, payment, destructive cleanup, or account actions.
6. Return machine-readable errors and a short human summary.
7. Add command discovery, schema versioning, and compatibility tests.

### W8.4 — Add safe agent workflows

- Label: **LATER** after command parity
- Priority: P2

First workflow:

1. Inspect a recording.
2. Remove or reorder clips.
3. Adjust normal Zoom and Camera Emphasis regions.
4. Create a 16:9 or 9:16 delivery variant.
5. Validate.
6. Dry-run export.
7. Apply as one reviewable batch.
8. Export only after approval when the destination is external.

## Wave 9 — UI structure and maintainability

### W9.1 — Refactor by domain, not file length

- Label: **AUTO**
- Priority: P1
- Depends on: characterization tests

Candidates:

- Split `electron/ipc/handlers.ts` into recording, project/media, export, window/security, entitlement,
  and agent domains behind one registration boundary.
- Split `useScreenRecorder.ts` into an explicit state machine, capture control service, camera
  sidecar ownership, and UI adapter.
- Split inspector panes and modals by facet.
- Keep project transforms and native scene generation pure and tested.

Do not refactor only to reduce line counts. Refactor when a boundary removes mixed responsibility,
reduces security scope, or makes a failure testable.

### W9.2 — Keep the editor calm and space-efficient

- Label: **AUTO**
- Priority: P1

1. Use one full-height side workspace for active Layout, Audio, Background, Effects, Cursor, Captions,
   Transcript, and Automatic controls.
2. Use the available width and height without nested cards or permanent empty columns.
3. Keep primary controls visible and put detailed parameters under Advanced.
4. Keep descriptions in accessible tooltips or info controls instead of long menu prose.
5. Keep direct preview manipulation for framing and layout.
6. Use one primitive system for select, slider, tooltip, popover, button, field, and section rhythm.
7. Keep graphite, soft white, and restrained steel-blue. Green remains semantic-only.
8. Verify fixed window states at 1100×700, 1280×800, and 1440×900.

### W9.3 — Keep the recording HUD simple

- Label: **AUTO**
- Priority: P1

1. Keep one HUD surface before, during, and after Pause.
2. Keep the empty clip-history row visible before recording.
3. Preserve stable transport positions across state changes.
4. Keep compact and expanded states reversible.
5. Keep the camera monitor separate, draggable, non-recorded, and low priority.
6. Keep Remove Previous Clip guarded by a small duration-aware confirmation.
7. Keep global shortcuts configurable and conflict-aware.
8. Measure launch, first camera frame, first click response, Pause, Continue, and Stop transitions.

## Wave 10 — Later product work

These do not block the paid alpha.

### W10.1 — Custom creator vocabulary

- Label: **LAB**

Use FluidAudio's acoustic candidate evidence. Store a versioned project or user vocabulary. Suggest a
correction while preserving the original recognition and timing. Do not apply global string
replacement. Add false-positive tests for short terms such as “AI”.

### W10.2 — Text-based editing and repeated-speech review

- Label: **LATER**

Use stable source-time words and normal timeline trims. Text deletion becomes the same reversible
trim command. Repeated phrases and false starts are review suggestions. Never call them “takes”.

### W10.3 — Supporting media

- Label: **LATER**

Let the creator drag or insert selected images, video, diagrams, and B-roll. Klippt can fit them,
apply a restrained transition, and adapt them to delivery variants. It must not fetch, invent,
license, or publish media without the creator's action.

### W10.4 — Music and sound suggestions

- Label: **LATER**

Support user-owned or licensed assets with audition, timing, gain, ducking, removal, and editable
motion. Keep suggestions off by default. Do not create copyright exposure or constant movement only
for retention.

### W10.5 — Translation, captions, and other platforms

- Label: **LATER**

Translation, advanced captions, cloud sharing, direct upload, Windows, Linux, and larger media
library workflows remain valid future work. They start only after the Mac creator workflow is
dependable.

## Watchlist — research without product commitment

### VideoToolbox and FFmpeg

- Standard macOS 26 VBR and supported preset controls: prototype after the normal codec contract.
- Beta Consistent Quality and Constant Quality Factor: watch only.
- FFmpeg 9: separate qualification lane for ABI, licences, resampling, VideoToolbox, and golden files.
- HDR10 capture/export: watch until ScreenCaptureKit behavior, 10-bit surfaces, HEVC Main10,
  metadata, SDR tone mapping, YouTube, and NLE behavior agree.
- Rectangular Dynamic Mask Metadata: watch until player and NLE support is real.

### Automatic understanding

- Local Vision text boxes, OCR geometry, face presence, and face stability can support or veto an
  edit. They cannot select intent alone.
- VideoToolbox motion estimation can provide movement evidence. Motion is not a subject.
- Semantic models can propose time spans or labels. They cannot choose pixel coordinates.
- Do not store private screen text by default.

### Speech and audio

- Apple SpeechAnalyzer: optional comparator or no-bundle fallback, not the reproducible authority.
- Qwen3-ASR: accuracy challenger; its forced aligner does not cover Swedish.
- FireRedVAD: keep-veto challenger only.
- DPDFNet: denoising challenger only.
- WebRTC AEC3: offline bleed-reduction prototype only.
- Generative speech repair: explicit manual repair only, with A/B, transcript, and identity checks.

## Rejected directions

Do not add these to the normal roadmap unless new hardware or product evidence changes the decision:

- A Swift rewrite.
- AV1 software export as the normal Mac path.
- `SCRecordingOutput` as the capture writer.
- Baked click visualization in source video.
- Dirty-rectangle-only encoding as a replacement for complete frames.
- Private Chromium IOSurface integration.
- A fixed “HEVC is 40% smaller” rule.
- VMAF as the only screen-content quality test.
- Default HDR.
- LLM-selected crop coordinates.
- A Zoom for every click.
- Continuous cursor chasing.
- A forced movement quota.
- Saliency-only crops.
- Gaze or gesture as the main trigger.
- Automatic full-screen camera.
- Cloud OCR or stored screen text by default.
- Automatic downloaded or generated B-roll.
- Automatic external publishing.
- Generative voice replacement.
- A destructive baked edit or separate AI timeline.
- A hidden agent-only mutation path.
- A broad dependency rewrite.

## Dependency lanes

| Lane | Action | Gate |
| --- | --- | --- |
| Electron | 41.10.7 bridge, then qualify 42/43/44 separately | W2.5 complete |
| electron-builder | Evaluate latest stable v26 patch only | Signed/package goldens |
| electron-updater | Keep 6.8.9 unless a measured need appears | Real quarantined update |
| FFmpeg | Keep 8.1.2 for P0 fixes; qualify 9 separately | Media and licence corpus |
| FluidAudio | Keep 0.15.6 baseline; qualify post-fix int8 v2 commit/tag | W1.4 |
| Parakeet | Repin only exact corrected model artifacts | W1.4 |
| Whisper | Keep independent fallback; bind helper to source SHA | W0.3 |
| Silero VAD | Keep 6.2.0 unless quality evidence appears | Pause safety corpus |
| DeepFilterNet | Keep narrow fork in Lab | Licence + corpus + package gate |
| Mediabunny | Qualify exact newer version after mux/voiceover tests | Preview/export parity |
| MP4Box.js | Remove if truly unused; otherwise update separately | Bundle and usage proof |
| Rust `metal` | Isolated move from 0.29 toward 0.33 | Native compositor tests |
| Rust `wgpu` | Defer; Mac compositor uses Metal | Explicit non-Mac need |
| N-API | Defer major 3 migration | Electron lane stable |
| React | Defer React 19 | Product or security reason |
| Vite | Defer Vite 8 | Dedicated build lane |
| TypeScript | Defer TypeScript 7 | Dedicated compiler lane |
| Motion | Defer Motion 13 | Dedicated UI-motion lane |

## Required verification matrix

### Every TypeScript/editor slice

```bash
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
npm run wb:typecheck
npm run i18n:check
npm run docs:check
npx biome check <changed-files>
npx vitest run <focused-tests> --config vitest.config.ts
git diff --check
```

Run the full suite before a checkpoint:

```bash
npm test
```

### Every Rust/compositor slice

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
```

Run commands in the correct crate or workspace. Keep preview/export goldens and native scene parity.

### Every Swift/native capture slice

- Build the exact release configuration for each helper.
- Run focused Swift tests and helper protocol tests.
- Run a physical ScreenCaptureKit/AVFoundation smoke test.
- Verify macOS 13 compatibility where the product still promises it.
- Run Swift concurrency and thread-safety review for lifecycle changes.

### Every release slice

- Clean checkout and pinned dependency restore.
- Full TypeScript, Rust, Swift, helper, locale, docs, and package checks.
- Dependency, licence, secret, and SBOM gates.
- Both Mac architectures where shipped.
- Signature, notarization, stapling, Gatekeeper, update, and artifact-hash checks.
- Independent code/security review with no open Critical or Important finding.

## User hold-point summary

The plan is designed so agents can work for a long time before asking Olle for anything.

| Hold | When it occurs | What agents prepare first | What Olle must do |
| --- | --- | --- | --- |
| A — Bundle identity | End of Wave 2 | Complete migration and rollback using `app.klippt.desktop` as candidate | Approve the final immutable identifier/publisher identity |
| B — Commerce | Late Wave 3 | Complete entitlement, checkout, webhook, and sandbox tests | Supply/approve identifiers and run one controlled real purchase/cancel |
| C — Legal | Late Wave 3 | Draft every public page and generate notices | Approve business wording and obtain legal review if needed |
| D — Clean Mac | End of Wave 3 | Exact signed package, checklist, and diagnostics | Run or arrange the physical clean-Mac test |
| E — Quality taste | After automated model/audio gates | Blind A/B sets and measurements | Listen only to finalists and choose the preferred behavior |

If Olle is unavailable, agents stop at the hold point and continue with the next independent AUTO
workstream. They do not guess an irreversible identity, legal statement, payment action, or subjective
audio preference.

## First agent queue

This is the recommended immediate order. It contains no required Olle action.

1. W0.1 — Current checkpoint inventory and clean-clone proof.
2. W0.2 — Permanent npm/Rust/dependency gates.
3. W0.3 — Release SHA and helper provenance.
4. W0.4 — FFmpeg WebAssembly and generated licence inventory.
5. W0.5 — Versioned creator corpus harness.
6. W0.6 — Local media workload telemetry.
7. W1.1 — Atomic export.
8. W1.2 — Explicit transcript source roles.
9. W1.3 — Bounded long transcription.
10. W1.5 — BT.709 SDR contract.
11. W1.6 — Exact frame-rate propagation.
12. W1.7 — Truthful encoder selection.
13. W1.8 — Decoded AAC validation.
14. W1.9 — Bounded streaming audio export.
15. W2.1 — Secure app/media protocol.
16. W2.2 — `webSecurity`, CSP, and navigation/window guards.
17. W2.3 — Narrow IPC and per-window preload surfaces.
18. W2.4 — Origin- and role-bound capture permissions.
19. W2.5 — Supported Electron migration.
20. W2.6 — Entitlement and fuse hardening.

Parallel work is allowed only where files and contracts do not overlap. The checkpoint, export
contract, source-role contract, secure protocol, and command service each need one owner and one
serial integration path.

## Definition of complete

This plan is complete when:

- Every item has an implementation commit, evidence, an explicit defer/reject decision, or a
  documented external hold.
- The paid Mac alpha passes Gate C.
- Normal 30–60 minute creator videos need no developer repair.
- Long sessions remain bounded, synchronized, recoverable, and exportable.
- Automatic editing reduces work on a locked holdout instead of producing cleanup.
- One project can create polished 16:9 and 9:16 outputs without changing source media.
- The UI, CLI, and agent bridge make the same safe edits through one command service.
- Release identity, licences, provenance, signatures, updates, and entitlements are stable enough to
  charge customers without relying on hidden local state.
