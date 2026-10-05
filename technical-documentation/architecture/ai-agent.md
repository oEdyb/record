# AI agent

The agent layer lives in `electron/ai-edition/`. It exposes a fixed set of validated operations over the shared project document. The `klippt agent` CLI (`electron/cli/`) drives those operations through `agentEditPlan.ts`, which calls `executeAgentTool` in `agent-tools.ts`.

> **In-app chat: removed on 2026-10-05.** Klippt is recording-only. The in-app LLM chat panel, its LangChain tool loop (`deep-agent/`), `chat-service.ts`, `chat-compaction.ts`, chat sessions, per-message checkpoints and rewind, and the renderer chat UI (`LeftPanel`, `ChatWelcome`, `ProviderSettings`, `chatAvailability`, `chatBudget`, `useChatPromptBus`) were deleted. The last source that contains them is the git tag `archive/pre-cleanup-2026-10-05`; read the earlier version of this page there for the tool loop, checkpoint, context-compaction, and session design. Provider configuration is archived in [llm-providers.md](llm-providers.md).

## What remains

- `agent-tools.ts`: the Zod argument schemas and the pure, synchronous executor (`executeAgentTool`). It has no IPC and no filesystem access.
- `agentEditPlan.ts`, `agentVerification.ts`, `agentHistory.ts`, and the other `agent*.ts` modules used by the CLI and the agent editor session.
- `document-service.ts` and `projectTransactions.ts`, which own saved snapshots and transactions for every writer.

No code in the app talks to a language model.

## Tool schema

No caller free-writes the project document. Writes go through the fixed tool set validated against the Zod argument schemas in `agent-tools.ts`; the executor parses JSON, validates arguments, and returns either a new schema-valid snapshot or an error. The tools operate on the same [document model](document-model.md) as manual editing.

| Tool | What it does | What it mutates |
|---|---|---|
| `getCurrentDocument` | Reads a compact project, asset, clip, trim, and modifier snapshot with explicit time bases. Each asset reports `hasCameraTrack` / `cameraVisible` / `hasCursorTelemetry` beside `hasTranscript` (`hasCursorTelemetry` is three-valued: `true`, `false` when the asset was checked and has none, `null` when it was not checked — never `false` for something we failed to look at), the document reports `hasAnyCamera` and `autoFocusAll`, and each zoom reports the `renderedScale` the viewer will see plus `customScale` / `depthIsOverridden` when a custom scale makes its `depth` inert. | Nothing. |
| `getTranscript` | Reads the transcript segments for an asset, or the primary asset, in full. On the production path a segment is one word, so a half-hour recording is a few thousand of them — there is no cap, and no per-model context budget to derive one from. | Nothing. |
| `getCursorTrack` | Reads the recorded pointer telemetry for an asset as a DIGEST: the moments the cursor sat still or clicked, each with its hold, its average position, its click count, its source time and the `virtualSec` that `addZoom` takes — never the raw samples. Answers `available:false` with `reason:"no-sidecar"` (checked, this asset has none) or `reason:"unavailable"` (could not be read from here), and the two are never conflated. | Nothing. |
| `addTrim` | Adds one source-time cut inside a clip. | `timeline.trimRanges`. |
| `addTrims` | Adds many cuts in one call, replaying `addTrim` per entry so the rules cannot drift apart. Each range stands alone: one that cannot be placed is refused by itself and named with its index and reason while the rest are applied, and the result leads with `requested` / `appliedCount` / `refusedCount`. Only a batch where nothing landed is an error. | `timeline.trimRanges`. |
| `setTrim` | Moves or resizes an existing source-time trim. | The matching `timeline.trimRanges` entry. |
| `setClipRange` | Changes a clip's source in/out points and relays clips back-to-back. | The clip range and any anchored regions clamped or removed by the shared timeline mutator. |
| `moveClip` | Reorders a placed clip by naming the clip it should play before (`null` = last). Preserves every clip id, source range, trim and anchored modifier. | Timeline clip order; anchored modifiers' derived ms follow their clip. |
| `replaceTimeline` | Rebuilds the primary-asset timeline from kept source-time intervals. Preserves the id, origin and label of every clip an interval reproduces exactly, carries existing trims through, and never touches another asset's trims. Refused when it would merge away, shorten or drop a clip, or when the intervals are not ascending (a reorder it cannot perform — the refusal points at `moveClip`). | Timeline clips and trim ranges. |
| `addZoom` | Adds a clip-anchored zoom over virtual timeline time. `depth` is an ordinal selecting from `ZOOM_DEPTH_SCALES` (1.25×–5.0×, non-linear); the result reports the resulting `renderedScale`. | `zoomRanges`. |
| `addZooms` | Adds many zooms in one call, replaying `addZoom` per entry, with the same per-entry refusal and reporting contract as `addTrims`. | `zoomRanges`. |
| `setZoom` | Moves, resizes, or restyles a zoom pill. Changing `depth` clears any `customScale` on that pill — otherwise the write is a no-op at render — and says so in the result. | The clip-anchored `zoomRanges` fragments represented by that pill. |
| `addSpeed` | Adds a clip-anchored speed region over virtual timeline time. | `legacyEditor.speedRegions`. |
| `setSpeed` | Moves, resizes, or changes an existing speed pill. | The corresponding `legacyEditor.speedRegions` fragments. |
| `addAnnotation` | Adds a positioned text annotation over virtual timeline time. | `annotations`. |
| `setAnnotation` | Moves, resizes, or changes an annotation's text. | The corresponding clip-anchored `annotations` fragments. |
| `addCameraFullscreen` | Adds a camera-fullscreen region over virtual timeline time; refused when no clip under the span comes from an asset with a linked `cameraTrack`, since such a region can only render nothing. | `legacyEditor.cameraFullscreenRegions`. |
| `setCameraFullscreen` | Moves or resizes a camera-fullscreen pill, under the same camera requirement as `addCameraFullscreen`. | The corresponding `legacyEditor.cameraFullscreenRegions` fragments. |
| `removeTrim` | Deletes a trim so its source span plays and exports again. | `timeline.trimRanges`. |
| `removeModifier` | Resolves and deletes a zoom, speed, annotation, or camera-fullscreen modifier by ID. | The matching modifier collection. |
| `removeClip` | Deletes a placed clip, closes the gap, and drops effects anchored only to it. The result names the modifiers and trims it took with it. | Timeline clips and affected anchored modifiers. |

Clips and trims use source time. Zoom, speed, annotation, and camera-fullscreen tools use virtual edited-timeline time; the executor converts these spans to the clip-anchored millisecond representation used by the document.

## Known gaps

- `allowAgentEdits` refusals: `executeAgentTool` still returns a `consent_required` payload for writes when its options say edits are not allowed. The in-app setting that fed it was removed with the provider layer.
- Cursor telemetry reaches `executeAgentTool` through its `cursorTelemetry` option. The only production loader for that context (a `CursorTelemetryReader` in the removed `deep-agent/service.ts`) went with the chat path, so a caller that passes none gets `hasCursorTelemetry: null` and an unavailable cursor track.
- The digest reports dwells and click counts, not the raw samples, and `readCursorSidecar`'s normalizer flattens `double-click` / `right-click` / `middle-click` to `move` before the digest sees them, so those clicks are currently invisible. The digest already counts the wide union; the narrowing is upstream, in `CursorRecordingSample`.
