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

Use [`HANDOFF.md`](HANDOFF.md) for the current branch, completed work, evidence, and next action.
Use [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md) for delivery order and release gates. The linked product behavior document owns detailed behavior; this file owns shared engineering constraints.

## Research before implementation

For project inspection, editing, review, playback, or export, load the canonical
`klippt-edit` skill at `/Users/olle/dev/skills/skills/klippt-edit/SKILL.md`, then run
`klippt agent skill` for instructions shipped with the installed CLI. Use the CLI
as the default interface for every supported editing action. Query exact command
schemas instead of relying on remembered flags. Report unsupported capabilities;
do not bypass the CLI with direct project JSON edits. Software development still
follows the development skill.

Before each feature slice, inspect at least one current primary source that can falsify the planned
implementation. Prefer official platform documentation, the exact dependency's source or API
reference, a maintained reference implementation, or a relevant paper. Confirm version-specific
behavior before editing code. Use secondary articles only to find primary sources.

Keep this step proportional. A small UI fix can use the platform or component reference. Capture,
media, security, billing, release, and architecture changes require the relevant official contracts
and reference code. Record the sources and the decision in the implementation note or technical
documentation after the code works. Do not replace implementation time with long research prose.

## Product behavior by task

Before changing product behavior, read the matching section of [product behavior](technical-documentation/product-behavior.md). Use its headings to select recording controls, floating panel, camera monitor, editor, pause shortening, voice cleanup, captions, automatic direction, export, audio delivery, or visual direction. Do not load unrelated product sections for a small edit.

Preserve clip-native recording, durable original media and project compatibility. Recording state must match actual writer state; UI-only success is not completion. Preview and export must agree. A new product decision updates the relevant section of the product behavior document.

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
- Customer updates use the owned generic feed at `updates.dyberg.co/klippt`. The private GitHub
  repository is not an update server and no repository credential may ship in the app. Publish
  versioned artifacts before the mutable feed manifests.
- Diagnostic exports are local and user-triggered. Never include project documents, media,
  transcripts, cursor/keyboard telemetry, or credentials. Redact and bound logs before saving.

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

Run targeted tests during development. For code changes, run the full suite once before final code handoff; documentation-only changes need relevant document checks. Never use the
non-terminating test watcher.

The normal app build does not rebuild the Swift/C++/Rust capture helpers. Rebuild the full
platform-native directory before trusting native results. A successful Electron build does
not prove the helper contains the current source.

## Code and test rules

- Never use TestSprite for Klippt. Do not install it, run it, or mention it in progress or completion reports.
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
- Installed local Mac builds must retain the Dyberg Developer ID signing identity and existing
  bundle/helper identifiers. The `afterSign` guard must pass before replacing `/Applications/Klippt.app`.
  Never install an Apple Development or unsigned CI build over the permission-granted app.
  See `docs/permission-and-control-consistency-2026-09-09.md` for the stale Accessibility grant repair.
- Keep the first working path small and real. Do not substitute a visual mock for working
  media behavior.
- Do not expose controls that claim an operation succeeded when only local UI state changed.
- Do not call the first version working until real files, project state, playback, and export
  agree.
- Update the relevant product behavior section when Olle changes a durable product decision.
