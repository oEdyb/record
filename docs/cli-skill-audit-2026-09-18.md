# Klippt agent CLI skill audit

Date: 2026-09-18. Scope: read-only command probes, source inspection, and primary-source comparison. No editor edits, skill installation, application changes, or restarts.

## Verdict

The CLI has a useful transaction foundation. The current `klippt-edit` skill is not yet a reliable, self-contained interface for a fresh agent. This is a concrete assessment of local failures, not a benchmark ranking against other tools.

Use the CLI as the normal interface for project inspection, editing, preview, and export. The skill should teach that interface and its limits. It cannot enforce correct agent behavior or supply missing editor features. Safety belongs in the CLI and document service; editorial judgment still needs visual and audio review.

Olle paused the requested round-one restrictions visual to assess this interface first. That visual and the request to reduce long full-camera sections remain pending. No new placement was made during this audit.

## Findings

| Priority | Finding and evidence | Required change |
| --- | --- | --- |
| P0 | Discovery is incomplete. The canonical skill exists at `/Users/olle/dev/skills/skills/klippt-edit`, but the three direct paths under `.agents/skills`, `.codex/skills`, and `.claude/skills` do not exist. The supplied session skill catalog does not list it. This session found it through the handoff. Other runtime-specific discovery routes were not exhaustively audited. | Register the canonical skill for supported runtimes and verify discovery in new chats. Make the project entry instructions route editing requests to it. |
| P0 | The quick reference documents `cutpoint --clip ID --out X --in Y`. The actual strict schema requires `--time X --edge out|in`, in source seconds. Running the documented form produced exit 2 and `INVALID_INPUT`. | Load exact syntax from `guide --command`; test any examples retained in Markdown against the parser. |
| P0 | Three time bases are easy to confuse. `state --at` uses edited playback time; `transport` seek uses raw timeline seconds; `cutpoint` uses source seconds. The quick reference's general edited-time statement does not explain these exceptions. | Explicitly label time domains now. Add a supported edited-time live-inspection command so routine viewing needs no agent-written conversion. |
| P0 | The skill does not clearly distinguish live state, saved renders, and actual live preview. `frames` reads saved state; `state` uses the editor bridge but does not seek. Our earlier verification checked saved frames before confirming the user's current picture. | A short inspect-at-time workflow must identify project, revision, dirty/sync status, time base, and whether the returned image is live or saved. Agents must inspect the image before making visual claims. |
| P0 | The skill's main cut workflow omits `plan --stage`, `staged`, `accept`, and `reject`, although the CLI guide exposes them and the user requested proposal-first cuts. It also omits recovery after uncertain writes. | Teach staging before footage removal, and receipt lookup with the original request ID before retrying uncertain writes. Preserve existing authorization rules. |
| P1 | Output framing is inconsistent with the documentation. `agent-cli.md` says one JSON envelope on stdout; `agentMain.ts` emits planned and terminal envelopes for placement/swap paths. Earlier successful writes triggered a single-JSON parser failure. | Document the existing stream immediately. Define and test one machine-output contract, with an explicit terminal result and reliable request recovery. Do not blindly retry on a parsing failure. |
| P1 | “The tool guarantees legality” overstates the evidence. Checks cover implemented rules, can lack audio evidence, and do not prove pacing, legibility, correct meaning, or audible word tails. | State exactly what each check proves and what remains unknown. Use the changed span for routine checks and a broader pass at final handoff. |
| P1 | The skill directory contains only `SKILL.md` and `references/commands.md`. It has no bundled evaluation cases or reusable helpers. This does not imply the CLI lacks unit tests; it has many. | Add fresh-agent task evaluations. Measure task completion, wrong-time edits, unintended mutations, recovery, tool errors, elapsed time, and visual quality. |
| P1 | Some editing capability is genuinely absent. Main-timeline zoom does not directly zoom a B-roll overlay. The current Agent-47 shot uses an export from an editable source clone. | Expose capability limits explicitly. Add the native editing feature when prioritized; do not disguise a rendered workaround as editable main-timeline B-roll zoom. |

## What to keep

`agentContracts.ts` already provides strict input schemas, a capability guide, per-command discovery, and operation discovery. Its workflow includes staged cuts, candidate inspection, stable request IDs, and receipt recovery. Plans carry a saved revision and prepared candidate; the guide documents stale-revision refusal. Existing history, checks, word anchors, and rendered frames are valuable foundations.

The skill already has a concise main file, focused reference material, and an inspect/edit/check/proof loop. The primary problem is not its length or lack of more general advice. It is mismatch with the executable interface, weak discovery, incomplete recovery instructions, and missing behavioral evaluation.

## Primary-source comparison

Sources checked on 2026-09-18. Repository `main` URLs are moving references, not pinned implementation dependencies. These are selected references with inspectable behavior; this audit does not establish a universal “state-of-the-art” winner.

1. **Vercel Labs agent-browser:** its current [skill entry file](https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skills/agent-browser/SKILL.md) delegates workflow loading to `agent-browser skills get core`, with specialized routes. This is directly useful for Klippt: keep the entry skill small and obtain version-matched usage from the installed CLI. Klippt already has `guide`; extend/reuse that mechanism before inventing another registry. Vendor performance claims were not used as evidence.
2. **Microsoft Playwright CLI:** its maintained [skill](https://raw.githubusercontent.com/microsoft/playwright-cli/main/skills/playwright-cli/SKILL.md) provides runnable examples, sessions, snapshots, and references obtained from those snapshots. Transfer the observe/act/observe pattern and explicit session targeting. Browser snapshots are not sufficient proof for video; Klippt still needs rendered pictures, playback, and audio evidence.
3. **Anthropic engineering:** [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents), published 2025-09-11, recommends realistic task evaluations, useful bounded responses, clear parameters, and a few workflow-oriented tools. It reports internal tool experiments, not a Klippt benchmark. This supports combining the common live-inspection sequence into one reliable operation and measuring whether that improves real tasks.
4. **Agent Skills specification and authoring guidance:** [specification](https://agentskills.io/specification), [script interfaces](https://agentskills.io/skill-creation/using-scripts), and [evaluation guide](https://agentskills.io/skill-creation/evaluating-skills) cover progressive loading, noninteractive structured interfaces, error recovery, and old-versus-new skill comparisons in clean contexts. Apply these as design guidance, not proof that our implementation works.

## Recommended delivery order

1. **Repair the entry path and instructions.** Verify discovery; replace stale syntax with installed command discovery; document output framing, all time domains, staged cuts, recovery, and current limits. Keep core safety checks in executable code.
2. **Make observing a shot one supported operation.** Proposed behavior: accept an edited timestamp or words; return resolved times, project/revision, visible layers, nearby transcript, and a useful image. Make moving the user's playhead explicit. Clearly distinguish live and saved evidence. This is proposed behavior, not an existing command claim.
3. **Evaluate three representative tasks first.** Run old and revised skills with fresh agents on isolated clones, sequentially on this Mac. Expand only after the first results identify gaps.
4. **Fix the CLI failures those tasks expose.** Prioritize wrong-time behavior, uncertain-write recovery, output consistency, and missing native edit capability. Avoid an unrelated rewrite.

Initial evaluation cases:

- “What is visible at 3:50, and is it live?” Pass requires correct edited/raw resolution, correct project, inspected live evidence when requested, and no false saved-versus-live claim.
- “Show the round-one restrictions while I explain them.” Pass requires transcript-grounded wording, readable visuals, correct timing, preserved narration, no camera obstruction, and an inspected changed-span render. Editorial quality needs human judgment as well as mechanical checks.
- “Suggest this pause removal, then recover after an interrupted response.” Pass requires an unaccepted proposal until authorized, no clipped words, receipt-based recovery, and no duplicate mutation. Use a test fixture or clone, never the original edit.

Later cases should cover unsaved GUI changes, stale plans, missing transcripts/media, project switches, undo, unsupported B-roll zoom, and preview/export agreement. Hold some cases out from instruction tuning. A few successful tasks are an initial gate, not proof of universal reliability.

## Verification and limits

Read-only probes saved under `artifacts/cli-skill-audit-2026-09-18`: `guide.stdout`, `cutpoint-guide.stdout`, `live.stdout`, `bad-cutpoint.stdout`, and `project-hashes.json`. The documented cutpoint example failed before analysis or mutation. The live editor was available. The Kimi project SHA-256 was identical before and after these probes.

No skill or application source was changed. No new agent evaluation, full test suite, or export was run during this audit. Prior agent behavior supplies failure cases; it does not substitute for the proposed controlled evaluation.
