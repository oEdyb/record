# Klippt handoff

- **As of:** 2026-09-05
- **Repository:** `github.com/oEdyb/record` (private)
- **Working branch:** `checkpoint/klippt-beta-hardening-2026-09-01`
- **Verified code checkpoint:** `5e7bc7e9f6f2d2bfefc72597138bd467ad810c82`
- **Product rules:** [`AGENTS.md`](AGENTS.md)
- **Delivery plan:** [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md)
- **Detailed execution ledger:** [`docs/cutting-edge-execution-plan.md`](docs/cutting-edge-execution-plan.md)

This is the current handoff for Klippt. Read it before an implementation session. Reference docs
describe the current architecture. Dated audits and the inherited OpenScreen roadmap are evidence
and history, not the active queue.

## Product in one paragraph

Klippt is a proprietary, Mac-first recorder and editor for creators. Its core advantage is
clip-native recording: record a section, pause, remove a bad clip, continue, and return to a
polished editable timeline. Screen, camera, microphone, system audio, cursor input, and safe
interaction telemetry remain separate enough for later editing. Automatic direction, pause
shortening, transcripts, layouts, and audio delivery are normal reversible edits. The product must
feel **calm, intelligent, and powerful**.

## Current working state

The core Mac flow works in development and in a locally signed package:

1. Open the idle recording HUD and select a screen or window.
2. Select microphone, system audio, camera, and cursor settings.
3. Record, Pause, Continue, and remove the previous clip.
4. Stop and return to the editor.
5. Split, remove, restore, reorder, and insert clips.
6. Generate or edit ordinary Screen Zoom and Camera Emphasis regions.
7. Shorten pauses, transcribe local audio, and apply optional delivery controls.
8. Export MP4 or GIF through the native compositor and atomic publisher.

This is not yet an outside beta. The beta gate still needs release and long-session proof.

## Work completed in the latest hardening wave

### Export and cache reliability — `17d38ed9`

- Unknown-duration imported media now receives a real duration before MP4 or GIF estimation and
  publication.
- Native export verifies stream structure and duration before publication.
- Export remains atomic: a failed or cancelled export does not replace a good destination file.
- Temporary browser source copies use a bounded OPFS lifecycle instead of accumulating indefinitely.

### Desktop security and release pipeline — `0e4df20a`

- Electron moved from 41 to supported Electron `44.1.0`.
- Packaged renderer and approved local media use the contained `klippt://app` origin.
- `webSecurity` is enabled. A strict CSP, sandboxing, navigation guards, and child-window guards are
  active.
- Privileged IPC uses central sender validation for origin, top-level frame, window role, and
  payload shape.
- Project media uses opaque grants, canonical path checks, range requests, and restricted CORS.
- Production fuses disable unsafe runtime paths and enforce ASAR integrity.
- Release CI notarizes and staples before it creates the update ZIP. It validates the nested app,
  DMG, update metadata, and source identity.

### Signed helper provenance — `c13d5eb5`

- Helper provenance now ignores only Mach-O link-edit metadata that Developer ID signing is known
  to change.
- Executable-code differences still fail the provenance gate.

### Retina preview workload — `5e7bc7e9`

- The editor previously rendered a 1280×720 CSS preview as a 2560×1440 RGBA frame on a Retina
  display. Each frame was about 14.7 MB.
- `computePreviewRect` now gives the offscreen native preview the visible CSS size. Export keeps its
  independent full resolution.
- The renderer still pulls at about 30 FPS and skips unchanged generations.
- A Retina regression proves device-pixel ratio 2 still creates a 1280×720 native preview for a
  1280×720 visible panel.

Before this fix, local telemetry measured Metal readback at about 19.1 ms mean, 42.5 ms p95,
58.8 ms p99, and 151.0 ms maximum. The p95 missed the 33 ms budget for 30 FPS. The machine also had
36.3 GB of swap in use, so system pressure amplified the problem. A fresh post-fix workload report
is still required.

### macOS Screen Recording permission repair

The installed app and several old builds shared the legacy bundle identifier
`com.etiennelescot.openscreen` but had different signatures. LaunchServices and TCC presented one
misleading enabled row while the running app returned `denied`.

The repair removed stale LaunchServices registrations, reset the bundle-specific Screen Recording
grant, and added the exact installed app once. Runtime checks then returned `granted`. The source
selector opened and returned one screen with a thumbnail plus 35 windows. The current signed app is
installed at `/Applications/Klippt.app`. The previous bundle is recoverable at:

`~/Library/Application Support/Klippt/Backups/Klippt-pre-permission-repair.bundle-backup`

The bundle identifier is still legacy. A Dyberg-owned identifier must replace it before public
distribution. That migration will require a new one-time permission grant.

## Fresh verification at the hardening checkpoint

The latest complete hardening gate passed:

- both TypeScript projects;
- repository lint, with one known warning in a large evidence file;
- 250 Vitest files: 2,668 passed and one intentional skip;
- 20 supply-chain files: 118 tests passed;
- all 166 Rust compositor tests;
- seven browser editor and accessibility flows;
- real Electron MP4 and GIF export tests;
- production renderer and Electron builds;
- package signing, hardened runtime, Electron fuses, and ASAR integrity;
- zero reported npm vulnerabilities;
- all 13 locales and documentation checks;
- two independent code reviews with no remaining finding in the reviewed hardening scope.

The preview-size follow-up passed 18 focused tests, scoped Biome, the production renderer/Electron
build, and Developer ID package verification. It has not yet repeated the complete matrix above.

## What is left, in priority order

### 1. Close the preview performance gate

- Use the installed fixed app and judge play, pause, seek, scrub, resize, and long-timeline feel.
- Capture a fresh `klippt-workload-v1` report at the new CSS-size preview configuration.
- Confirm p95 frame delivery is below 33 ms at 30 FPS and that input delay has no visible spikes.
- Do not start a native `CAMetalLayer` preview unless measured copies remain the bottleneck.

### 2. Prove the packaged creator flow

- Run one 30–90 minute packaged recording with screen, microphone, system audio, and camera where
  available.
- Exercise Pause, Continue, remove-to-zero, Stop, reopen, edits, transcript, pause shortening, and
  final export.
- Test capture failure, device loss, low disk space, sleep/wake, crash recovery, and relaunch.
- Confirm the final MP4 decodes, stays in sync, and can be uploaded without repair.

### 3. Finish the release path

- Create an authorized fresh notarized and stapled artifact from the current source.
- Move Apple and R2 credentials into the GitHub `release` environment after the hardened workflow
  reaches the release branch.
- Publish immutable update artifacts and the first feed manifests.
- Prove a quarantined version N to N+1 update with signature, bundle, hash, and rollback checks.
- Arrange a clean or second-Mac install test. If Olle has no spare Mac, use an outside tester with a
  clean user account and capture the same evidence.

### 4. Freeze product identity

- Select and freeze a Dyberg-owned bundle identifier. `app.klippt.desktop` is the current candidate.
- Migrate user data, TCC permissions, Keychain state, update identity, file associations, recent
  projects, and recovery journals without deleting the legacy data.
- Remove remaining visible OpenScreen identity from shipped metadata and end-user surfaces.
- Keep the upstream MIT notice and all generated third-party notices.

### 5. Finish the paid-beta surface

- Configure real Lemon Squeezy store, product, variant, checkout, webhook, and licence identifiers.
- Test purchase, activation, offline grace, cancellation, restore, and read-only expiry behavior.
- Publish the one-page `klippt.app` site with privacy, terms/EULA, refund, support, company details,
  consent, and unsubscribe behavior.
- Keep commercial enforcement disabled until the full real checkout path passes.

### 6. Validate creator-quality features

- Add consented Swedish, English, technical-term, code-switching, and long-session fixtures to the
  creator corpus.
- Tune automatic direction only from labelled corrections. Do not add another detector by default.
- Validate decoded AAC loudness, true peak, duration, priming, tail, and discontinuities.
- Keep Clean Voice optional and out of paid packages until model redistribution rights and the
  labelled audio-quality gate pass.
- Build editable 16:9, 9:16, and 1:1 delivery variants from one project. Include a flexible vertical
  split with screen/camera order, proportions, and direct screen framing.

### 7. Continue differentiation after beta trust is proven

- Complete the shared typed command service for UI, CLI, and agent parity.
- Add named creator presets.
- Add custom vocabulary and safe text-based editing.
- Add fast media insertion with automatic motion and transitions.
- Evaluate native AVFoundation camera capture, ProRes/source bundles, and automatic vertical
  reframing behind measured gates.

## Known risks and constraints

- The current bundle identifier can make TCC state ambiguous when several differently signed builds
  exist. Keep only the intended app registered during tests.
- The current installed package is Developer ID signed but is not the final notarized beta artifact.
- Large source recordings and browser source caches can consume many gigabytes. Keep recovery first;
  clean disposable caches, not source media.
- The creator corpus manifest exists but contains no approved private media by default. Unit tests do
  not replace real long-session evidence.
- The automatic direction engine is deliberately deterministic. Add policy values and labelled
  examples before adding branches for individual timestamps.
- Do not let optional transcription, cleanup, or analysis block Record, Pause, Continue, Stop,
  project opening, or basic editing.
- Do not use TestSprite.

## Architecture map

| Area | Current owner |
| --- | --- |
| Product behavior and language | [`AGENTS.md`](AGENTS.md) |
| Delivery sequence and commercial gates | [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md) |
| Detailed research-backed task ledger | [`docs/cutting-edge-execution-plan.md`](docs/cutting-edge-execution-plan.md) |
| Current process map | [`technical-documentation/architecture/overview.md`](technical-documentation/architecture/overview.md) |
| Project document and migrations | [`technical-documentation/architecture/document-model.md`](technical-documentation/architecture/document-model.md) |
| Capture and HUD | [`technical-documentation/architecture/recording.md`](technical-documentation/architecture/recording.md) |
| Preview | [`technical-documentation/architecture/preview.md`](technical-documentation/architecture/preview.md) |
| Export | [`technical-documentation/architecture/export-pipeline.md`](technical-documentation/architecture/export-pipeline.md) |
| Renderer/main security boundary | [`technical-documentation/architecture/native-bridge.md`](technical-documentation/architecture/native-bridge.md) |
| Packaging and release | [`technical-documentation/engineering/build-and-packaging.md`](technical-documentation/engineering/build-and-packaging.md) and [`release-and-secrets.md`](technical-documentation/engineering/release-and-secrets.md) |
| Performance evidence | [`technical-documentation/engineering/rendering-performance.md`](technical-documentation/engineering/rendering-performance.md) and [`workload-telemetry.md`](technical-documentation/engineering/workload-telemetry.md) |
| Manual release proof | [`technical-documentation/testing/manual-e2e-checklist.md`](technical-documentation/testing/manual-e2e-checklist.md) |
| UI system | [`design/DESIGN.md`](design/DESIGN.md) and [`docs/ui-system-audit-2026-08-30.md`](docs/ui-system-audit-2026-08-30.md) |

## Documentation status

- This handoff pass audited all 71 tracked or pending Markdown paths in the repository. It updated
  the files whose product state, architecture, release state, or agent guidance had changed.
  Accurate specialist references were left intact. `THIRD-PARTY-NOTICES.md` and the vendored
  PipeWire README remain upstream/legal records and were not rewritten.
- `AGENTS.md`, `PRODUCT_PLAN.md`, `HANDOFF.md`, `design/DESIGN.md`, and
  `technical-documentation/` are current sources.
- `docs/ui-system-audit-2026-08-30.md`, the STT POC report, and older benchmark sections are dated
  evidence. They do not override current code or this handoff.
- `ROADMAP.md` is the inherited OpenScreen roadmap and is historical only.
- `website/docs/` is the inherited OpenScreen Docusaurus content. Its pages are marked as drafts so
  they cannot be mistaken for the planned original `klippt.app` beta site.
- `openscreen-*` helper, environment-variable, rein, and internal schema names remain where changing
  them would break compatibility. A legacy internal identifier is not current product branding.

## Normal commands

Use the pinned Node `22.22.1` and npm `10.9.4`. Use npm only.

```bash
npm install
npm run dev
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
npx vitest --run path/to/test.ts
npm run test
npm run lint
npm run i18n:check
npm run docs:check
npm run build:native:mac
npm run build-vite
```

The normal Vite/Electron build does not prove that the native helper is current. Rebuild and stage
the native Mac helpers before a package or real capture check.

## Performance implementation — 2026-09-05

The [audit](docs/performance-audit-2026-09-04.md) was followed by an authorized
[implementation and verification pass](docs/performance-implementation-2026-09-05.md).
The performance commit builds on `8635cda9`; the older committed checkpoint above
remains historical. Export audio and decoder memory are bounded, preview presentation is
serialized and rate-limited, auxiliary windows load less JavaScript, history shares immutable
data, caches have retention rules, and confirmed retired code/dependencies were removed.
Packaging fixtures and CI setup were simplified without dropping the release gates.

The implementation note records unit/build/type/lint results, independent review, a real
60-second 2560 × 1440 capture/export, GUI clip editing, and measured 5/30-minute and 500-source
native memory probes. Test typecheck now passes. Real GUI testing also exposed an existing
terminal-seek defect and legacy opening defects. The rebuilt GUI verifies the fixes;
the implementation note records the final runtime evidence and review.

## Next recommended slice

Finish W5.1 without adding new architecture:

1. Run the fixed installed app through play, seek, scrub, and resize on the long project.
2. Save a fresh workload report.
3. Compare the new frame-delivery percentiles with the pre-fix numbers in this handoff.
4. If the target passes, mark W5.1 complete and move to the packaged 30–90 minute flow.
5. If it fails, profile the remaining readback, IPC, or main-thread stage before changing code.

## External references used for the latest decisions

- [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Electron `desktopCapturer`](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Electron `systemPreferences`](https://www.electronjs.org/docs/latest/api/system-preferences)
- [Apple ScreenCaptureKit capture guidance](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [Apple Metal resource synchronization](https://developer.apple.com/documentation/metal/resource-synchronization)
