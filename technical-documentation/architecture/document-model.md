# Document model

`AxcutDocument` is Klippt's internal project source of truth. The historical type name remains for
compatibility. New files use `.klippt`. The Zod schema lives in
`src/lib/ai-edition/schema/index.ts`; the renderer store lives in
`src/lib/ai-edition/store/projectStore.ts`; the main-process persistence service lives in
`electron/ai-edition/document-service.ts`.

## Current schema

`axcutSchemaVersion` is **9**. Every supported on-disk document is migrated before it reaches the
pure current-schema parser. A future unknown version fails the literal version check instead of
silently dropping data.

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Current literal version, `9`. |
| `project` | Stable project ID, title, timestamps, and optional primary asset. |
| `assets[]` | Recorded or imported media, source path, camera track, duration, and reversible derived-media intent. |
| `transcript` | Legacy primary transcript retained for compatibility. |
| `transcripts[]` | Current per-asset, source-role-aware transcript records. |
| `timeline` | Clips, gaps, clip-anchored trims, mute ranges, speed ranges, and caption ranges. |
| `annotations[]` | Clip-anchored text, image, figure, and blur regions. |
| `zoomRanges[]` | Clip-anchored Screen Zoom regions, including manual/automatic ownership and direction groups. |
| `legacyEditor` | Validated passthrough for editor settings that have not moved to first-class fields. |

Camera Emphasis remains in the compatible editor envelope. The current schema does not store
runtime cache paths, worker progress, file grants, window state, or derived-media failures. Those
values are disposable runtime state.

## Migration chain

Migrations are one-way and forward-only. `migrateRawDocumentToCurrent` composes the complete chain;
`documentSchema.parse` validates only the current shape.

### v3 to v4

Moves the project-level camera track onto its owning asset. It chooses the primary asset, or the
first asset when the old project had no primary ID.

### v4 to v5

Converts zoom, annotation, speed, and camera regions from ruler-only spans into clip-anchored
fragments. It derives the display milliseconds from the clip/source anchor.

### v5 to v6

Replaces the old runtime-only `native` aspect-ratio sentinel with a concrete ratio when source
dimensions are known. It keeps the sentinel when migration cannot resolve a safe value.

### v6 to v7

Anchors trim ranges to clips. When one asset appears more than once, the migration creates one
clamped trim per affected clip instead of guessing which clip the old asset-wide trim meant.

### v7 to v8

Adds the optional versioned Clean Voice recipe. Missing remains the canonical Original setting, so
opening an old project cannot start processing or change its sound.

### v8 to v9

Adds explicit transcript source roles and evidence. Legacy words and segments become
`unknown-mixed` with `legacy-unverified` evidence. The migration does not invent a speaker.

### Legacy editor v2 to current

`migrateProjectDataToAxcutDocument` converts the inherited `EditorProjectData` envelope. It creates
one asset and clip, carries the camera link and editor settings forward, converts the old region
shapes, then runs the normal migration chain. The function is pure: no filesystem, DOM, network, or
media probe.

## Persistence

The renderer holds one live document. The main process owns the bytes on disk.

| Concern | Contract |
| --- | --- |
| Location | `userData/projects/<id>.klippt` |
| Format | UTF-8 JSON with an explicit schema version |
| Current extension | `.klippt` |
| Legacy extensions | `.openscreen` and `.axcut` remain readable |
| Legacy migration | Validate, write an equivalent `.klippt` copy, and keep the original |
| Publication | Write a temporary file, synchronize it, then rename atomically |
| Concurrency | Serialize writes per project so two saves cannot interleave |

Every read of untrusted or on-disk project data must run the migration chain and then the current
schema parser. Do not call the current parser directly on an old file.

## Timeline and source-time invariants

Clips define timeline order and source in/out ranges. Modifiers remain attached to a clip and source
time. UI lanes project those anchors into playback time after trims. Preview, export, transcript
copy, pause shortening, and automatic direction must use the shared mapping helpers instead of
reimplementing time conversion.

Automatic regions use `source: "auto"` and can share a `directionGroupId`. Any direct user change to
a connected automatic region promotes the complete edited ownership group to manual before save.
Regeneration can replace only still-automatic regions.

## Derived media

The project stores a recipe and immutable source identity, not a cache path. A Clean Voice stem,
preview mix, waveform envelope, transcript cache, or other derived file can be rebuilt. Runtime
services publish a derived result only after identity, length, timing, and integrity checks pass.
Failure falls back to the complete raw source.

## Undo and revisions

Interactive Undo/Redo uses the bounded renderer snapshot stack in
`src/lib/ai-edition/store/undo.ts`. Normal multi-field operations must enter history as one document
edit. Disk persistence remains atomic but does not yet provide a durable user-facing revision
browser across app restarts.

Agent-native work must not write JSON directly. UI, CLI, and future agent bridges should call the
same typed project commands with stable IDs, an expected project revision, a dry run, validation,
and one Undo step.

## Known gaps

- Some compatible editor settings still live in `legacyEditor` instead of first-class fields.
- Persisted revision browsing and cross-relaunch Undo are not implemented.
- The shared typed command service does not yet cover the complete UI edit surface.
- Broader migration tests are still required before the Dyberg-owned bundle and data identity ship.

See [`../../HANDOFF.md`](../../HANDOFF.md) for the current release gate.
