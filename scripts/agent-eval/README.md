# agent-eval — fresh-agent evaluation harness

Plan phase 7 (`docs/agent-cli-foundation-plan-2026-09-18.md`). This harness
measures whether a fresh agent — a new Codex or Claude session with only the
installed skill — can complete real editing tasks on the Kimi project. Grading
is end state first (the Terminal-Bench rule): project hash, staged proposal
count and cuts, check finding counts, transcript diff, frame presence — plus
declared per-case outcome assertions (the intended overlay/swap/staged removal
actually happened), safety assertions (receipt recovery before retry,
apply-then-undo history growth), and usage assertions (the agent's transcript
shows the case's command — `shot`, `batch` — was actually used with the shipped
reply shape). Agent transcripts are captured for telemetry and are graded only
where a case declares `safety.receipt_recovery` or a `usage` block.

Grade status is `pass`, `fail`, or `incomplete`. Evidence that could not be
collected — check analysis still `analyzing`, a transcript page gap, clips
without stored transcripts, an unparsable project document, a truncated staged
page, a missing agent transcript for a safety check — makes the affected check
incomplete and the case `incomplete`. A proven failure outranks incomplete
evidence (`fail` > `incomplete` > `pass`). Incomplete never counts as a pass;
the runner exits 1 for `fail`, `error`, and `incomplete` alike. This is the
wave-1 review rule: explicitly incomplete is preferable to a false pass.

## Layout

- `run-agent-eval.mjs` — the runner. Clones, launches one agent at a time,
  collects evidence, grades, writes a results record.
- `grader.mjs` — pure grading and evidence-extraction functions. No editor, no
  CLI. Unit-tested by `grader.test.mjs`.
- `grader.test.mjs` — smoke tests for the grader only; no live editor needed:
  `npx vitest --run scripts/agent-eval/grader.test.mjs`
- `test-fixtures/` — trimmed copies of real captured CLI replies (from
  `artifacts/cli-cut-safety-2026-09-18` and `artifacts/staged-cuts-2026-09-18`),
  the wave-1 review repro, and `shot-saved-render.json` / `batch-completed.json`
  built field-by-field from the phase-4/5 reply builders (`agentShot.ts`,
  `agentBatch.ts`). Extractor and grader tests run against these shapes, not
  flattened inventions.
- `cases/<id>/manifest.json` — case definition and grading spec.
- `cases/<id>/prompt.md` — the prompt handed to the fresh agent.

## Reply shapes the collector consumes

Pinned from real captures and the reply builders (`electron/cli/agentEditState.ts`,
`agentTranscript.ts`, `editorAgentBroker.ts`):

- `check --all`: `data.status` is `analyzing` → `ready` | `error`. Counts live
  at `data.result.counts.{error,warning,info,byRule}` and are identical on
  every page; `result.page`/`pages` only paginate the findings list. The runner
  polls until `ready` (24 attempts, 5 s apart); an `analyzing` or `error`
  terminal state is unavailable evidence, not zero findings.
- `transcript --all --page N`: `data.clips[]` carry per-clip
  `words[]`/`words_offset` (a clip continues on the next page at
  `words_offset`), `data.missing[]` lists clips without stored transcripts, and
  `data.next_page` drives the page walk. The merge refuses gaps: a lost page or
  a non-`--all` reply makes the transcript evidence incomplete.
- `staged`: `data.lane_count` is the lane total; `data.cuts` is a possibly
  truncated page (`next_offset`). Outcome checks use the cuts only when the
  page is complete.
- `history`: `data.entries[]` newest first with `applyId`, `requestId`, `kind`
  (`apply`/`undo`/`redo`), `targetIds`.
- Saved document: overlay/asset outcome evidence comes from a read-only parse
  of the clone's `.klippt` file (`videoOverlays`, `assets`), because no
  inspection reply exposes overlays. Canonical schema only; a legacy file is
  incomplete evidence. The file is never written.

## Reply shapes the usage graders scan

`usage.shot` / `usage.batch` read the agent transcript (the declared exception
to transcript-as-telemetry, like `safety.receipt_recovery`) and find terminal
envelopes line by line. Shapes pinned from the builders:

- `shot` (`electron/cli/agentShot.ts`): `data.instant` resolves the instant on
  all three clocks (`edited_sec`/`raw_sec`/`source_sec` plus per-field
  `time_base` labels); `data.staged` is `{ lane_count, in_range, truncated,
  range }` over edited ±5 s; `data.image.source` is `saved_render` (default) or
  `live_preview` (`--live`), and `data.evidence.image` echoes it
  (`evidence.state` is `live_editor`, `evidence.transcript` is
  `saved_project`).
- `batch` (`electron/cli/agentBatch.ts`): `data.batch_id`, `hash_before` /
  `hash_after` around the run, `steps_total`/`steps_executed`/`steps_completed`/
  `stopped_early`, per-step `status`/`exit_code`/`request_id` (batch-derived
  ids are `<batchId>:<index>`), the `group` block (`id`, `request_id_prefix`,
  `undo_command` with `--to <batchId>`), and `frames` (`status` is `rendered` /
  `no_touched_instants` / `unavailable`; rendered carries a `frames[]` list of
  `{ step, at, path }`).
- Group undo (`electron/ai-edition/agentHistory.ts` `resolveGroupTarget`):
  `--to <batchId>` matches entries whose `requestId` is the batch id or is
  prefixed `<batchId>:`, resolves to the group's oldest retained entry on the
  stack, and lands as ONE undo history entry whose `targetIds` cover every
  restored entry. This is what `safety.history.min_undo_targets` asserts.

An agent CLI that truncates tool output in its own transcript hides the
envelope from the scan; the usage check then fails closed ("no shot/batch
reply … or the agent CLI truncated its output"). Keep batch verbosity at the
default `summary` so the terminal envelope stays small.

## Running

Prerequisites: the dev editor built and running (`npx vite build`, then start
it), because placement commands, `open`, and the proposal lane need the live
editor. The Kimi source project is never opened or written — every run works on
a fresh clone made with `klippt agent clone`.

```sh
# list cases (no editor needed)
node scripts/agent-eval/run-agent-eval.mjs --list

# one case with Codex
node scripts/agent-eval/run-agent-eval.mjs \
  --case restrictions-card \
  --agent 'codex exec --sandbox workspace-write - < {prompt_file}'

# all cases with Claude
node scripts/agent-eval/run-agent-eval.mjs \
  --agent 'claude -p "$(cat {prompt_file})"'
```

`--agent` is a shell template run through `sh -c`. Placeholders:

| Placeholder | Expands to |
| --- | --- |
| `{prompt_file}` | rendered prompt file for this case run |
| `{prompt}` | rendered prompt text (quote it yourself) |
| `{project_id}` | fresh clone's project id |
| `{project_path}` | fresh clone's `.klippt` path |
| `{case_dir}` | the case definition directory |
| `{frames_dir}` | directory the agent must save frames into |

Other flags: `--case <id>` (repeatable), `--out <dir>` (default
`artifacts/agent-eval/runs/<timestamp>`), `--klippt <path>` (default
`scripts/klippt`, falling back to the raw Electron invocation),
`--timeout-sec <n>` per agent (default 1800).

Agents run strictly one at a time. Exit status is 1 when any non-skipped case
fails, errors, or is incomplete.

## Results record

Each run writes `<out>/results.json` and `results.md` with the fields the plan
requires for the skill's `evaluations` section: date, skill version
(`content_sha256` of the installed skill), CLI version, status per case
(`pass` / `fail` / `incomplete` / `skipped` / `error`), tokens (best-effort
parse of the agent's own output, null when the CLI prints none), wall time,
wrong-time edits, unintended mutations. Per case: rendered prompt, full agent
transcript (`transcript.txt`), setup replies, baseline and after evidence,
`result.json` with the individual checks (incomplete checks carry
`incomplete: true` and an `actual` explaining what was unavailable), and the
agent's frames.

`wrong_time_edits` is null in the record: a wrong-time edit cannot be counted
from end state alone. It surfaces as a failed hash/staged/transcript check;
annotate the field from the transcript when reviewing. `unintended_mutations`
counts failed end-state mutation checks (hash, staged count, transcript);
incomplete checks are not mutations.

Cases whose required command does not exist yet carry `pending: "phase-N"` in
their manifest and are reported as `skipped` with the reason. Remove the flag
when the phase lands. All five cases are active today: `observe-shot-3-50` was
unblocked by `shot` (phase 4) and `undo-batch` by `batch` plus grouped
`undo --to` (phase 5).

## Cases

| Case | Status | Grader expectation |
| --- | --- | --- |
| `broll-swap-short` | active | hash changed, staged 0, no new check errors, transcript unchanged, ≥2 frames, `outcome.swapped_overlay` |
| `observe-shot-3-50` | active | hash unchanged, staged 0, no new check findings, transcript unchanged, ≥1 frame, `usage.shot` at edited 230 s ±2 s |
| `pause-proposal-recovery` | active | hash unchanged, staged 1–3, transcript unchanged, `outcome.staged_removal`, `safety.receipt_recovery` |
| `restrictions-card` | active | hash changed, staged 0, no new check errors, transcript unchanged, ≥2 frames, `outcome.new_overlay` |
| `undo-batch` | active | hash restored, staged 0, no new check errors, transcript unchanged, `safety.history` (3 grouped applies + one undo covering 3 targets), `usage.batch` |

Clones are kept after the run (ids are in `results.json`) so the end state can
be re-inspected. Delete them from the projects folder when done.

## Adding a case

1. `mkdir cases/<id>` with a kebab-case id.
2. Write `prompt.md`. Use the placeholders above; the runner substitutes them
   before the agent sees the prompt. Write the prompt as a user request, not a
   recipe — the point is whether a fresh agent discovers the right commands.
3. Write `manifest.json`:

```json
{
	"id": "<id>",
	"title": "One line",
	"pending": null,
	"source_project": "/absolute/path/to/source.klippt",
	"setup": [
		{ "note": "why", "argv": ["zoom", "add", "--project_id", "{project_id}", "--at", "1:00", "--request_id", "{request_id}"] }
	],
	"grader": {
		"project_hash": "unchanged | changed | restored",
		"staged": { "min": 0, "max": 0 },
		"check": { "max_new_errors": 0, "max_new_warnings": null },
		"transcript_unchanged": true,
		"frames": { "min": 2 },
		"outcome": {
			"new_overlay": { "asset_path_prefix": "/abs/media-dir/", "range_raw_sec": [87.84, 99.45], "tolerance_sec": 1.5 },
			"swapped_overlay": { "asset_path_prefix": "/abs/clips-dir/", "min_asset_duration_sec": 7, "max_asset_duration_sec": 12 },
			"staged_removal": { "min_duration_sec": 0.8 }
		},
		"safety": {
			"receipt_recovery": true,
			"history": { "min_new_applies": 1, "min_new_undos": 1, "min_undo_targets": 3, "require_grouped_applies": true }
		},
		"usage": {
			"shot": { "edited_sec": 230, "tolerance_sec": 2, "allow_live": true },
			"batch": { "min_steps": 3, "require_completed": true, "require_grouped": true, "group_undo": true, "hash_mutation": "changed" }
		}
	}
}
```

- `pending`: `null`, or `"phase-N"` when the case needs a command that does not
  exist yet. Pending cases are listed and reported as skipped.
- `setup`: optional CLI argv arrays run on the clone before baseline collection
  (same placeholders). Baseline is collected after setup, so harness mutations
  are not graded.
- `project_hash`: `unchanged` (observe/propose cases), `changed` (placement and
  swap cases), `restored` (undo cases; same equality check, recorded
  distinctly). A hash axis alone never proves the intended edit happened — pair
  it with an `outcome` assertion; `restored` alone does not prove an undo ran —
  pair it with `safety.history`.
- `check`: maximum new findings vs baseline; `null` skips that axis.
- `frames`: minimum image files the agent must leave in `{frames_dir}`.
- `outcome.new_overlay`: a new video overlay whose asset's `originalPath` sits
  under `asset_path_prefix` and whose raw-timeline range matches
  `range_raw_sec` within `tolerance_sec` (default 1.5). Pin the range from the
  source project's transcript before writing the case.
- `outcome.swapped_overlay`: exactly one existing overlay slot changed, as a
  clean media swap into `asset_path_prefix` — placement, motion, opacity, fit
  and the slot start kept, the slot may only shrink, and the new asset's
  probed duration within the optional bounds.
- `outcome.staged_removal`: the staged lane holds at least one new cut removing
  at least `min_duration_sec` edited seconds.
- `safety.receipt_recovery`: the agent transcript must show a `receipt` query
  carrying the run's `{request_id}` before any retried write with that id.
- `safety.history`: the editor's write journal must show at least
  `min_new_applies` new apply entries and `min_new_undos` new undo entries after
  baseline; `min_undo_targets` requires one undo step that restored that many
  entries; `require_grouped_applies` requires the new applies to share one
  request-id group (`<group>` or `<group>:` prefixes, the batch convention).
- `usage.shot`: the agent transcript must contain a completed `shot` reply with
  the shipped shape — three-base `instant`, the `staged` in-range block, and
  `image.source` echoed by `evidence.image`. `edited_sec` + `tolerance_sec`
  (default 2) pin the instant; `allow_live: false` rejects `live_preview`
  grabs. When several shot replies appear, the cleanest one is graded.
- `usage.batch`: the transcript must contain one completed `batch` envelope.
  `min_steps` bounds `steps_total`; `require_completed` (default true) rejects
  stopped/failed batches; `require_grouped` requires every step request id to
  carry the `<batchId>:` prefix and the `group` block to point at the batch id;
  `group_undo` additionally requires a `undo --to <batchId>` command echo in
  the transcript; `hash_mutation` is `changed` or `unchanged` over
  `hash_before`/`hash_after`; `min_frames` bounds the rendered frames list when
  frames rendered (frame rendering is evidence, not a gate — `unavailable` is
  tolerated).

4. Run `npx vitest --run scripts/agent-eval/grader.test.mjs`, then
   `node scripts/agent-eval/run-agent-eval.mjs --list` to confirm the case
   loads.


## Boundary comparison proof

`node scripts/agent-eval/boundary-proof.mjs manifest.json output-directory` reads saved
frame evidence and writes `contact-sheets.html` plus `boundary-result.json`. Each
sequence declares label, project_id, revision, sha256, source (`live`), mode (`seek`
or `playback`), time_base and fps. Each frame supplies path, reference_path,
requested_time, observed_time, and freshness. Captures must come from the live
compositor; the script does not drive or edit a project.

The pixel comparison uses normalized 160×90 RGB against a corrected control, with
an explicit maximum difference (default 0.1). This is a regression comparison, not a
general visual-quality detector. Both seek and playback sequences must cover
consecutive frames at their declared cadence to pass. Missing identity, timestamps,
freshness, or live provenance remain unavailable. A known pixel mismatch fails even
when other proof is incomplete. Creating sheets never counts as visual review.

The historical 59.904-second reproduction is retained in the takeover artifacts.
It detects the exposed desktop against corrected camera frames, but correctly remains
incomplete for current-build continuous coverage. Clone-based live acceptance is separate.

Token telemetry accepts comma and apostrophe grouping. A requested change that never
occurred is a task failure, not an unintended mutation. Wrong-time telemetry remains
unknown unless the case has sufficient timestamp evidence.
