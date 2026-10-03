# Klippt agent CLI foundation

Status: proposed implementation plan, 2026-09-07. No runtime changes implemented by this document.
Code baseline: `2ddc722a7740f297ddd70ef47a0ec3d8b5768d17`.

## Decision and scope

Implementation authorized overnight on September 7. Olle authorizes engineering judgment on the
approach. The expanded target includes editor control parity, exact output-pixel placement and
edge-distance readback, and a supplied media-folder workflow: import images, videos, music and
sound effects; compose timed overlays; adjust audio; and create transitions. These require real
shared editor/render support, not CLI-only metadata. Deliver in verified slices; do not promise
the entire expanded editor will finish in one night.

Morning deliverable requested: an editable proof project plus rendered video using test media.
Demonstrate several zooms, imported overlays and entrance animations, a timed layout change,
camera size/position changes, and audio cues as implemented. Include an honest feature/evidence
manifest. The user will judge the result in the morning; never substitute a pre-rendered fake for
editable effects or claim unfinished capabilities from a static mock.

For media folders, discover supported files with bounded metadata first, inspect selected assets,
then explicitly import chosen assets with stable IDs and source preservation. Never execute media
folder content. Import is not deletion or permission to scan unrelated folders. Overlay transforms,
track timing, opacity, cropping, audio gain/fades, and supported transitions must share the GUI
model, Undo, preview, and export. Measure geometry with structured readback; use low-resolution
contact sheets for selection, targeted full-resolution crops for readability, and full frames
for composition. Avoid repeated image reads when only an exact numeric property changed.

Use normal Codex in the desktop app or CLI to operate Klippt through a documented local CLI.
Codex supplies reasoning; Klippt supplies accurate state, typed edits, persistence, rendering,
and evidence. Do not embed another agent runtime. Defer local models and the learned taste ranker,
as Olle requested on September 7. MCP is a possible later adapter, not a dependency.

The first useful outcome is: Codex locates a moment, sees its composed appearance, changes one
ordinary Zoom, verifies the result, and the user can Undo it normally. This is a measurable first
slice toward automatic editing. It is not a claim of state-of-the-art editorial quality.

This plan refines W8 in [the execution plan](cutting-edge-execution-plan.md#wave-8--agent-native-editing)
and supplies the agent evaluation path for W6.1. Existing release gates remain in force.
Read-only development can proceed without waiting for commercial checkout or release work.
External mutation release remains blocked until shared ownership and recovery tests pass.

## Assessment of the two research reports

Both September 6 reports support a strong core: shared typed commands, stable IDs, compact
inspection, rendered evidence, reversible changes, and evaluation on real creator tasks.
The implementation should keep these ideas and tighten the claims behind them.

| Research claim or suggestion | Decision |
| --- | --- |
| CLI first, thin MCP later | Adopt because this matches Olle's chosen Codex workflow. Do not claim CLI universally beats MCP. |
| Outline → timeline → item; visual readback | Adopt. Add search, time mapping, pagination, and explicit missing-evidence states. |
| Plan → confirmation token → apply | Use an immutable plan ID and expected revision. A plan token proves consistency, not human authorization. Previously authorized local edits do not need another confirmation. |
| No competitor exposes useful edit context | Reject the absolute. Tella documents composed frames and edit batches; Cap documents agent CLI discovery. See sources below. |
| Klippt has no intent layer or raw agent cursor evidence | Too broad for current code. There are typed observations and intermediate direction plans. `getCursorTrack` already returns downsampled samples. Semantic intent can improve later. |
| Build a full review tool before any agent slice | Start a small fixture/review loop with the first slice. A complete labelling UI is not a prerequisite to inspecting one edit through Codex. |
| Retained unmodified at export measures trust | Count only edits the creator actually reviewed. Track no-edit baseline, repair time, harmful edits, and rejected suggestions too. |
| Use a 0.2 s event collar; never use VMAF/SSIM | Treat timing tolerances as hypotheses to calibrate. VMAF/SSIM cannot grade editorial intent; they can still help with encoding regressions. |
| New accessibility signals, motion algorithms, local models, ranker | Separate future experiments. They must not delay or complicate the CLI foundation. Do not copy incompatible licensed implementations. |

The reports are research inputs, not shipping specifications. Claims such as "nobody does this",
"more evidence than anyone", or "copied" need stronger evidence than feature-page comparisons.
An old observation about one MCP client does not establish all clients' behavior in September 2026.

## What agent-friendly means here

An agent can discover available operations, locate relevant evidence without reading the entire
project, distinguish source footage from the composed result, make an exact bounded change,
recover from conflicts and timeouts, and check what actually happened. Measure this with completed
tasks, unintended changes, recovery success, time, and context usage. JSON alone is insufficient.

Current primary-source lessons, checked September 7, 2026:

- Cap's installed guide and version-aligned CLI/desktop documentation support keeping command
  knowledge in the binary and the skill short. [Cap agent guide](https://cap.so/docs/agents),
  [setup](https://cap.so/docs/agents/setup).
- Descript's June 23, 2026 account explains why agents need working transcript context before
  export. Inspection should not require an expensive job or silently launch one.
  [Descript engineering](https://www.descript.com/blog/article/dont-ship-your-api-as-an-mcp).
- Tella documents composed frames, short previews, explicit time coordinates, and validated
  batches. Its batch reference excludes cuts and warns about non-idempotent retries. Klippt must
  define and test its own guarantees. [Tella reference](https://www.tella.tv/docs/mcp-server).
- Anthropic's September 2025 tool guidance supports task-oriented operations and useful bounded
  responses. Its January 9, 2026 evaluation guidance supports checking actual outcomes, repeated
  trials, and separate capability/regression tests. Neither proves video-editing quality.
  [Tool design](https://www.anthropic.com/engineering/writing-tools-for-agents),
  [agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- Current Codex documentation distinguishes JSONL execution events from a schema-constrained
  final answer. Skills load progressively. Use those capabilities for an optional test harness;
  the desktop workflow only needs shell access and image inspection.
  [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
  [skills](https://learn.chatgpt.com/docs/build-skills).

These are maintained contracts and engineering accounts, not a benchmark establishing the best
CLI. Undated living references were checked on the date above; do not assign them invented
publication dates. Recheck exact pinned runtime APIs when each implementation slice begins.

## Existing seams and constraints

| Current code | Reuse or gap |
| --- | --- |
| `electron/cli/args.ts`, `cliMain.ts`, `src/lib/cliContracts.ts` | Existing record/export commands and NDJSON contracts must keep working. |
| `electron/cli/projectCommands.ts` | Legacy `editor`/single-video assumptions need canonical schema adapters before agent inspection. |
| `electron/ai-edition/agent-tools.ts`, `deep-agent/service.ts` | Useful validated operations and inspection exist. Some batches intentionally permit per-entry partial success; do not silently redefine that interface. |
| `src/lib/ai-edition/document/operations.ts` | Reuse pure document transforms; extend only for each supported command. |
| `electron/ai-edition/document-service.ts` | Atomic file writes and process-local queues exist; these do not provide cross-process revision checks. |
| `src/lib/ai-edition/store/projectStore.ts`, `documentHistory.ts` | GUI owns in-memory revisions, pending edits, and Undo. This ownership must be coordinated before external writes. |
| `src/lib/ai-edition/schema/index.ts` | Schema v9 has stable IDs but no persistent project revision. Preserve legacy project loading and source files. |
| `creator-corpus/manifest.json` | No approved assets/fixtures yet. Do not present corpus quality as measured. |

The current CLI skips Electron's GUI single-instance lock. An extra CLI process must therefore
never become a second project writer. The old instruction in `docs/cli.md` to edit JSON directly
must be replaced when the supported editing path ships.

## Public command contract

All names below are proposed, not available commands. Use one typed registry to generate argument
validation, JSON Schema, capabilities, help, reference pages, and contract examples. Keep product
logic out of argument parsing. API version and project schema version are separate.

| Command family | Purpose |
| --- | --- |
| `guide`, `schema <command>`, `doctor` | Version, capabilities, limits, help, compatibility, and local readiness; no project content in diagnostics. |
| `project inspect`, `timeline list`, `item get` | Outline, bounded timeline, exact item. Include IDs, readable labels, revision, readiness, and live/saved state. |
| `evidence find`, `evidence list`, `time map` | Transcript/click/typing search, bounded evidence, and explicit clock conversion. |
| `preview frame`, `preview sheet`, `preview range` | Composed PNG, contact sheet, and short local video plus manifests. |
| `edit plan`, `edit apply`, `operation get` | Validate typed operations, commit a bound plan, recover a result after timeout. |
| `history list`, `history undo`, `history redo` | Shared history, revision checked; no blind restoration over newer work. |
| `direction plan`, `project validate`, `export plan` | Existing deterministic direction, structural checks, and concrete output feasibility. |
| `job get`, `job wait`, `job cancel` | Bounded long-running work with durable terminal status. |

Rules for the new API:

1. `--json` emits one versioned JSON result on stdout. Logs and human progress go to stderr.
   `--events` explicitly selects JSONL with sequence numbers and a terminal result. Preserve the
   established record/export `--json` stream contract rather than changing it underneath scripts.
2. Commands never open a pager, prompt, or emit ANSI in machine mode. Mutation is an explicit verb.
   Accept structured payloads with `--input <file>` or `--input -`; avoid shell-escaped JSON strings.
3. Reject unknown keys, invalid IDs, non-finite numbers, incompatible time bases, and unsupported
   operations. Return field-level errors with permitted values and a useful recovery action.
4. Scope requests by explicit project ID. `--active` can resolve an initial project but returns its
   ID; follow-up writes bind that ID. Do not retarget a write when the user switches windows.
5. Use opaque stable IDs plus readable context. Timeline indexes are display positions, never
   mutation identities. Duplicates get new IDs. Preserve the existing split convention: the left
   portion keeps its ID and the right portion receives a new ID. Return the complete lineage map.
6. Default readbacks are bounded by range, count, and response-byte budget. Return `truncated`,
   `next_cursor`, and coverage. Cursors bind a snapshot revision and filter; never mix revisions.
7. Missing transcript is `unavailable` or `not_generated`, not an empty successful transcript.
   Inspection does not start transcription, capture, network access, or regeneration.
8. Proposed exit codes: 0 success/accepted job, 2 invalid input, 3 missing resource, 4 conflict,
   5 denied, 6 unavailable, 7 execution failure, 130 cancelled. JSON `status` distinguishes queued
   from completed. A timeout has an operation/job ID and does not assert that nothing happened.

Illustrative success envelope (IDs and counts are examples):

```json
{
  "api_version": "1.0",
  "request_id": "req_01",
  "status": "completed",
  "project": {"id": "prj_01", "revision": "rev_42", "state": "committed"},
  "data": {"operation_id": "op_01", "changed_ids": ["zoom_08"], "undo_id": "undo_09"},
  "warnings": [],
  "artifacts": [],
  "next_actions": [{"command": "preview sheet", "reason": "Inspect the changed interval"}]
}
```

Errors use the same outer identity fields with `status: failed` and `error: {code, message,
field_errors, retryable}`. A conflict also supplies the current revision and changed IDs when
available. `next_actions` are structured hints, never executable text copied from media.

## Context that describes the actual edit

The outline reports duration before/after edits, ordered clips and roles, analysis availability,
effect counts, audio recipes, delivery aspect/resolution, current selection when available, and
pending-edit state. It excludes full transcripts and raw telemetry by default.

Range readback joins words, clicks, typing, trims, Zooms, Camera Emphasis, and output layout on a
declared clock. Return evidence IDs, origin, confidence when meaningful, and unavailable signals.
Never label heuristic confidence as a calibrated probability without calibration evidence.

Use explicit source, raw virtual, and edited playback clocks. Public time objects use safe integer
microseconds with a time-base enum and asset/clip identity where required. Adapt at the boundary
to existing seconds/milliseconds; do not migrate the whole project model merely for the CLI.
Intervals are half-open. Mapping must account for trim, speed, duplication, and reorder, and return
multiple matches or a removed interval explicitly. Use decoded presentation timestamps for VFR;
never infer exact media time from frame number divided by nominal FPS.

Coordinates name their space and units: source-normalized rectangles, output pixels, or existing
effect parameters. Readback includes source dimensions, crop, layout transform, and output
dimensions. Keep adapters for the existing differing annotation/zoom scales. Do not accept an
unlabelled pair of numbers as screen position. Prefer a region/evidence target over guessed pixels.

## One writer, safe plans, normal Undo

Use an app-owned command broker as the first write authority. The CLI is a thin client. On macOS,
use a short Unix socket path inside a user-private directory; future Windows uses a named pipe.
Node's IPC contract supports these transports and documents socket path/lifecycle limits.
[Pinned Node 22.22.1 API](https://nodejs.org/download/release/v22.22.1/docs/api/net.html).

Enforce protocol negotiation, bounded messages, connection timeouts, and project read/write/export
scopes in the broker. Keep the socket directory private and reject unexpected endpoint ownership.
Do not expose a localhost HTTP server as an incidental convenience. Scopes constrain the bridge;
they do not isolate malicious software already running with the user's full filesystem access.

For the first release, external edits require the running compatible app. If absent, return
`OWNER_UNAVAILABLE` with a start instruction. Do not silently launch a second writer or capture
devices. A dedicated headless owner can follow after process ownership is proven. Offline
read-only inspection may read a saved snapshot and must label it as such.

The broker must own committed revision transitions and serialize every project write, including
GUI, chat, async enhancements, and CLI. During migration, disable external writes for a project
if any remaining mutation path bypasses that owner. Keep interactive gesture previews local,
but register their edit lease; external apply returns `EDITOR_BUSY` until commit/cancel. Recheck
the revision after every await. Never auto-commit an unfinished drag to satisfy a CLI request.
The barrier also covers dirty non-gesture state and queued saves. Flush only completed pending
edits through the authority, then recheck the caller's revision. If the flush advanced it, return
a conflict for reinspection/replanning. Never fall back to the disk version of a dirty project.

Plan/apply protocol:

1. Read a committed snapshot and its opaque persistent revision. Revisions change on every
   committed edit, including Undo/Redo. They are not `updatedAt` timestamps.
2. `edit plan` validates the full batch on a private candidate. It returns a bounded before/after
   diff, affected intervals, constraints, and an immutable plan ID bound to canonical operation
   hash, base revision, policy version, and relevant media/output identities. Planning writes no
   project state. The candidate can be rendered for review.
   Reserve generated IDs in the prepared plan; existing random ID allocation must not produce a
   different document on apply. Persist prepared plans with bounded lifetime, or return explicit
   expiration after restart. Never silently reconstruct an expired plan with fresh IDs.
3. `edit apply` takes that plan ID, expected revision, and caller idempotency key. Under the project
   queue it checks ownership, entitlement, idle gesture state, revision, and all constraints again.
4. Commit the candidate plus transaction metadata atomically. Return one receipt and one shared
   Undo entry. No per-entry partial success in this new batch API. No-op plans do not create Undo.
5. A duplicate key with the same payload returns the stored result. Reusing a key for different
   content fails. Look up duplicates before rejecting an old expected revision so a lost response
   can be recovered. A stale new request requires inspection and replanning; never silently rebase.

Persistence design must make the document and receipt one recoverable transaction. Preferred
first design: versioned project metadata stores revision, last transaction identity, and bounded
receipt records in the same atomic snapshot. Keep immutable before/after recovery blobs in the
project's managed history storage, durable before committing references to them. Do not put a
receipt only in a second sidecar and claim atomicity. Schema migration needs explicit compatibility
fixtures; legacy originals remain intact. If an older writer drops metadata or changes the file,
detect the content mismatch and invalidate the session rather than trusting a reused revision.

Advertise receipt retention. Preserve compact key/hash tombstones for the project's lifetime so
an expired receipt never causes a previously used key to execute again. Return `RECEIPT_EXPIRED`
when the full result is no longer retained. A project clone establishes a new mutation identity.
Undo uses the same command path and restores only the immediately applicable transaction; return
a conflict instead of wiping newer edits. Durable history is bounded and garbage-collected only
after references are safe. No source-media deletion belongs in these commands.
Missing referenced history blobs and interrupted garbage collection are release blockers until
recovery tests prove the document and available Undo history remain consistent.
Keep transaction metadata outside the content restored by Undo; revisions and receipt history
must never rewind. This distinction must hold even if both live in one serialized project record.

Crash tests must kill the process before/after blob durability, snapshot rename, and response
delivery. Recovery must expose either the old state or the new state with its receipt. GUI history
must recover a committed agent action even if the renderer never received its notification.
Verify parent-directory synchronization after rename where supported, as well as file/blob
synchronization. The current atomic write alone must not be described as proven power-loss
durability. Separate process-crash tests from filesystem/power-loss guarantees in the evidence.
Hold a brief live-edit barrier across commit and renderer application. A durable commit whose
renderer acknowledgement is missing reports `ui_sync: pending`, not full GUI completion. Block
new live edits until the renderer reconciles the receipt; retrying must not create another edit.
Read-only mode after entitlement expiry still allows inspection and original recovery, but not
editing or finished exports, consistent with existing product rules.

## Visual feedback, jobs, and speed

Frames and short previews use the existing composition/render path, including cursor, crop,
camera, captions, trims, speed, and output aspect. Do not create a simplified second renderer.
A manifest includes project revision or plan ID, actual sample timestamps, source mapping,
render settings, compositor version, artifact ID, MIME type, dimensions, and local absolute path.

Give Codex a contact sheet plus targeted before/after frames around cuts and effect boundaries.
The workflow must explicitly open the PNGs with its image tool; returning a file path does not
mean Codex saw the image. A video artifact is useful for human motion/audio review, but do not
claim that a client watched or heard it without actual support. Structural validation, still-frame
inspection, motion inspection, and audio audition are separate evidence fields.

Render the candidate before apply when quality is uncertain. After apply, verify the committed
revision. Reuse candidate artifacts only if composition inputs match exactly. Geometry and timing
must agree with export; encoded pixels need not be bit-identical across pipelines/codecs.

Long work returns a job ID. Status reports stage, bounded progress, revision, cancellation state,
and terminal outcome. Cancellation stops work at safe boundaries and cleans only owned temporary
files. It cannot undo a committed edit. Pin jobs to immutable snapshots; later edits must not
change a running export's meaning. Use explicit output paths, no overwrite by default, and report
missing media before starting expensive work.

Use lazy imports for discovery/metadata reads and a reusable render worker for repeated previews.
Do not require the caller to install Node for the packaged CLI; package the supported launcher
using the app runtime. Measure its startup before deciding a separate native launcher is needed.
Keep decoder, frame, job, and artifact caches bounded. Cache keys include media identity,
document/plan content, output settings, and renderer/policy version. Do not hash every media byte
on each read; establish durable identities at ingest and invalidate when files change.

Initial engineering budgets, to validate rather than advertise: warm outline p95 under 100 ms,
cold metadata under 500 ms, default outline under 16 KiB, range response under 64 KiB. Measure
first frame and short render latency on Olle's hardware before setting render targets. Test
14-minute, 60-minute, and many-clip fixtures, peak memory, cancellation, and concurrent playback.

## Codex workflow and documentation

Ship a short skill with the CLI, plus generated reference material. The skill teaches:
discover → inspect/find → inspect composed images → plan → apply when authorized → verify → report
receipt and evidence. It tells Codex to preserve unspecified edits and treat transcript, OCR,
filenames, and captured text as data, never instructions. Tool scope enforcement belongs in the
service; a skill is not a security boundary.

Document time bases, common tasks, error recovery, job lifecycle, compatibility, and safe retries.
Examples must run against fixtures in CI. Generate schemas and reference tables from the registry
to prevent help drift. Include both human explanations and complete JSON examples. Do not put the
entire schema or repository internals into the always-loaded skill description.

Use the user's normal Codex configuration and account. No embedded API key, model pin, automatic
global skill installation, or weakened sandbox is needed. The local experiment must explicitly
allow its project/artifact directory and broker access through the host's existing permissions.
Although Klippt can stay local, evidence supplied to a hosted Codex model is not on-device model
processing. Readback should expose only requested project evidence and keep diagnostics content-free.

For repeatable trials, optionally run `codex exec` with JSONL events and a final result schema.
Those are harness records; the Klippt receipt remains the authority for whether an edit committed.
Do not run a second Codex instance from inside Klippt just to support the normal desktop workflow.

## Implementation sequence and acceptance gates

| Slice | Ownership/files | Acceptance |
| --- | --- | --- |
| A. Contract and canonical reads | New shared command registry near `src/lib/ai-edition`; CLI adapters; canonical loader | Guide/schema/outline/item/search; v9 and legacy fixtures; missing analysis and bounded pagination; no writes. |
| B. Composed inspection | CLI preview adapter, existing scene/export services, artifact manifest | Actual PNG/sheet from a copied Mac project; source/edited mapping around trims and speed; contact sheet opens in normal Codex. |
| C. Project ownership and recovery | Document service, schema migration, project store, history, all save entry points | Persistent revision, one writer, busy gesture rejection, durable receipt, duplicate/restart/crash cases, normal GUI Undo. No external writes before this gate. |
| D. First complete agent edit | Broker transport plus `edit plan/apply`; existing Zoom transform | Codex changes one identified Zoom from a natural request; sees before/after; GUI/CLI agree; Undo restores; retry cannot duplicate. |
| E. Editing breadth | Existing operations and agent-tool adapters, one operation family per PR | Trim/split/remove/restore/reorder, camera/layout, audio recipes and deterministic direction added with parity and time-mapping tests. Discovery exposes only completed capabilities. |
| F. Workflow quality and packaging | Skill, generated docs, task harness, packaged launcher | Repeated normal Codex tasks, packaging/path-with-spaces tests, latency report, repair-time review; install and compatibility instructions. |

Dependency order: A → B; A → C; B + C → D; D → E. Documentation and a small task harness start
in A and expand throughout. F is the release check, not the first time an agent tries the tool.
MCP, headless write ownership, semantic intent enrichment, and new detectors are later slices.
Local models and ranker remain deferred until Olle changes that decision.

Testing should protect behavior, not duplicate validators line by line. Start with 12 realistic
tasks and at least three isolated trials each: locate a phrase, inspect a duplicate clip, change
one Zoom, preserve other effects, remove a bounded pause, handle missing evidence, respect a
gesture, reject stale edits, recover timeout-after-commit, Undo after restart, inspect 9:16 output,
and leave a good section unchanged. Enable tasks only when their command family exists.

Grade the final document, media preservation, requested change, collateral changes, receipts,
Undo, and composed output. Do not require one exact tool-call sequence. Track pass rate per task,
worst failures, time, tool calls, response bytes/tokens, and creator repair time. A small suite
finds defects; it cannot establish broad market leadership. Compare compact readback with full
readback on identical tasks before claiming token or latency gains.

Add deterministic regression cases for subsecond clips, VFR, speed changes, cuts at boundaries,
reordered duplicate sources, a moved file, schema mismatch, concurrent writers, and process death.
Use a small approved creator holdout for editorial judgment. Keep a no-edit baseline and label
which proposed changes were actually reviewed. The user cannot judge motion/audio from bed via
unit-test results; mark those checks pending until real review occurs.

At each implementation handoff, follow repository checks: targeted tests during development,
full unit suite once before code handoff, both TypeScript checks, lint, and relevant build/docs
checks. Rebuild native components when changed. Capture/preview/export changes need real Mac
verification. Preserve prior passing evidence only while the affected state remains unchanged.

The foundation is ready when normal Codex completes the first edit loop through the installed
interface, the user sees the same committed edit and Undo, retries survive a lost response, and
the evidence accurately states what was and was not verified. A passing parser is not that gate.
