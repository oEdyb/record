# Agent CLI foundation plan

Date: 2026-09-18. Author: Claude (Fable 5.1). Scope: the decision on what the Klippt agent
interface should be (CLI, MCP, or code), how atomic it should be, what makes it foolproof, and
the ordered work to get there. Inputs: local measurements on this checkout, the 2026-09-18
[skill audit](cli-skill-audit-2026-09-18.md), the [orchestrator handoff](ORCHESTRATOR-HANDOFF-2026-09-18.md),
and three primary-source sweeps (sources listed at the end).

## Decision

Implementation clarifications from Codex, September 18:

- Phase 1 is the active slice. The launcher preserves stdout, stderr, argument
  boundaries, caller working-directory semantics, and exit status. It must not keep
  only the last JSON line. Existing multi-envelope output remains explicit until
  phase 2 changes the command layer itself.
- Install the development launcher in an existing PATH directory (`~/.local/bin`
  on this Mac). Do not change shell startup files or install over Klippt.app.
  Shipping a packaged launcher is a separate distribution check; bundled skill
  content must work without reading Markdown from the caller's working directory.
- Command layers describe intent, not a blanket mutation guarantee. `cutpoint` is
  analysis, some workflow commands have read modes, and live `transport` changes
  playback. State each command's actual effects; `receipt` is recovery inspection.
- Reinterpreting existing bare raw/source numbers as edited time would break the
  phase 2 compatibility rule. Phase 3 needs explicit new input options or a major
  contract version, with migration tests, before changing those meanings.
  Runtime review also identified the export clock: `preview --time` uses
  speed-adjusted output seconds, while `frame(s) --at` converts the editor clock.
  Phase 3 must preserve or explicitly migrate that distinction too.
- RMS is supporting evidence, not proof of clipped speech. Phase 6 must validate
  its detector on positive and negative audio cases before using an error gate.
  Evaluate workflow safety as well as end state: a correct final file cannot show
  whether an agent ignored proposal authorization or retried an uncertain write.

The comparison supports keeping the existing transaction design. It does not
establish a universal best-in-class ranking, and MCP schema-loading costs depend
on the host's discovery implementation. Neither affects the local phase 1 scope.

Keep the CLI. Do not build an MCP server now. Do not build a code-mode SDK now. Spend the
effort on the foundation the CLI is missing: one entry path, one output contract, one time
base, proposals by default, one observation command, one batch runner, content-level
verification, and fresh-agent evaluations.

Why, in order of weight:

1. The measured cost of the CLI is already low. On this Mac with the dev editor open, `guide`
   takes 0.35 s and `state --at` 0.40 s wall. Replies are 4 KB (`state`), 8 KB (`history`),
   19 KB (`check` page). Electron boot per call is not a bottleneck.
2. Every primary source that made this decision for a comparable product chose CLI plus a skill
   file: Playwright (CLI over MCP for token efficiency), Vercel agent-browser (skill delegates to
   `skills get`), Remotion (deprecated its MCP for skills), Cap (`cap guide --json` contract),
   Anthropic's own Claude Code (Bash plus skills). Anthropic's tools guidance says few
   workflow-shaped tools beat many thin wrappers.
3. MCP earns its cost when a remote, shared service needs discovery across hosts. Klippt is one
   machine, one editor, one socket, and the agent already has a shell. MCP would put 42 schemas in
   context up front; the CLI loads one with `guide --command`. MCP tool annotations are advisory
   only; the MCP project itself says they are not a safety mechanism.
4. Code mode (Anthropic 150k → 2k tokens, Cloudflare 1.17M → 1k) solves schema-in-context at
   thousands of endpoints. Klippt has 42 commands. What Klippt does hit is the second half of that
   finding: intermediate results should not round-trip through the model. The shot map is 30 beats
   × 3–4 calls × ~4 KB ≈ 100k+ tokens. A batch runner fixes that without a sandbox (see phase 5).

Counter-case, stated so the decision is honest:

- If Klippt customers should plug Claude Desktop or ChatGPT into the editor with one click, MCP
  is the distribution format (Descript and DaVinci Resolve 21.1 shipped MCP for exactly that).
  Answer: later, as a thin adapter over the same broker contract. It changes nothing in this
  plan because both would call the same command layer.
- If agents end up writing 20+ sequential porcelain calls per beat and the batch runner is not
  enough, a typed TypeScript client over the existing socket protocol is a small step. Revisit
  when the evaluation harness shows it, not before.

## What the interface is

Three altitudes, made explicit in `guide` and in the skill. Today all 42 commands sit in one
flat list and a fresh agent cannot tell which layer it is on.

| Layer | Commands | Rule |
|---|---|---|
| Observe (read, free, never mutate) | `live`, `state`, `check`, `frame(s)`, `preview`, `geometry`, `transcript`, `assets`, `inspect`, `timeline`, `item`, `media`, `history`, `staged`, `contracts`, `guide`, `operations`, new `shot` | Call any time. Replies label evidence source (live or saved) and time base. |
| Porcelain (workflow writes) | `edges`, `pauses`, `cutpoint`, `text add`, `broll add/swap`, `zoom add`, `camera set`, `layout set`, `clip replace`, `auto`, `preset`, `settings set`, `accept`, `reject`, `undo`, `redo`, new `batch` | Each is a documented composition of plumbing. Each stages footage removal by default. Each returns one terminal envelope with a verify block. |
| Plumbing (atomic writes) | `plan`, `apply`, `receipt`, `import-plan`, `clone`, `open`, `transcribe`, `transport` | For anything porcelain does not cover. Revision-bound, request-id idempotent. |

Atomic or workflow is the wrong question. Both exist and both stay. The fix is that the agent
must always know which layer a command is on and what it proves.

## What "foolproof" means here

The transaction layer already matches the strongest pattern in the survey (Premiere MCP
confirmation tokens, Kinocut intent/decide, FCP MCP hash-checked undo): strict Zod input,
revision-bound plans, stable request ids with receipts, check gate on plan, verify block on
apply, gzip before/after snapshots, undo/redo, proposal lane. Keep all of it.

What is missing is around the transaction layer, and every item below is a repeat failure from
the last two days, not a hypothetical:

1. **Entry.** The canonical skill is not linked into `~/.agents/skills`, `~/.claude/skills`, or
   `~/.codex/skills`. No `klippt` binary exists; the skill says `klippt agent …` while dev needs
   the eight-word Electron incantation with a stderr pipe trick.
2. **Syntax drift.** The skill documents `cutpoint --out X --in Y`; the parser wants
   `--time X --edge out|in`. Nothing tests the Markdown against the parser.
3. **Output.** Docs say one envelope; placement and swap commands print two (`planned`, then
   terminal). A single-JSON parser broke on that. Exit codes are 0/2 only.
4. **Time.** Three time bases (edited, raw, source) across commands, labelled in some replies and
   not others. Wrong-time edits are the top wrong-edit class.
5. **Proposals.** `plan --stage`, `staged`, `accept`, `reject` exist and the skill never mentions
   them. Olle's rule is that footage removal is a proposal first.
6. **Observation.** "What is on screen at 3:50 and is it live?" takes three commands and a
   conversion. Workers claimed screenshots inspected while pills were invisible.
7. **Content proof.** Checks prove structure and transcript; audio evidence is cached peaks.
   Clipped words ("experiment", "yourselves") passed every check. FCP MCP built filmstrip plus
   waveform sampling for exactly this reason.
8. **Evidence of agent behavior.** 3,402 unit tests, zero fresh-agent task evaluations. The
   only benchmark of agentic video editing (AgenticVBench, 2026) puts the best stack near 30 %
   success and blames harness variance more than model capability.

## The map

Each phase has a runnable acceptance check. Order is by dependency and by how often the failure
happened. Phases 1–3 are one day of work each or less. Nothing here touches the live project;
live tests run on clones.

### Phase 1: one entry path (skill and shim)

- Add `scripts/klippt` (zsh) that runs `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . agent "$@"`
  with `--json` default when stdout is not a TTY and stdout/stderr passed through intact.
  Preserve the caller's cwd and accept the documented `klippt agent ...` prefix exactly once.
  Symlink into an existing PATH directory. Packaged launcher distribution is checked separately.
- Add `klippt agent skill` (and `guide --skill`): prints the version-matched SKILL body from the
  installed build, the way agent-browser `skills get core` and `playwright-cli --help` do. The
  Markdown source lives in the repo under `electron/cli/skill/` and ships in the build.
- Shrink `~/dev/skills/skills/klippt-edit/SKILL.md` to under 120 lines: what the tool is, the
  loop, Olle's taste rules, the cut-measurement rule, and "run `klippt agent skill` for syntax".
  Delete `references/commands.md`; the installed CLI owns syntax.
- Link the skill into `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` and add it to the
  skills repo README. Add `compatibility: Requires klippt on PATH, ffmpeg` to the frontmatter.
- Acceptance: a fresh Codex and a fresh Claude session both list `klippt-edit`; `klippt agent
  guide` works from any cwd; `skills-ref validate` passes; every code block in the skill body
  runs through `parseAgentCommand` in a test (examples are tests).

### Phase 2: one output contract

- One terminal envelope per invocation on stdout. Progress and planned envelopes go to stderr as
  NDJSON, or to stdout only with `--stream`. Add a test that runs every command's fixture and
  asserts exactly one stdout JSON line.
- Exit codes: 0 completed, 2 invalid input, 3 blocked by checks or confirmation required (the
  reply carries the exact `confirm_command`), 4 editor or owner unavailable, 5 revision or
  history conflict, 6 timeout with a receipt to query. Document in `guide`.
- Error object always has `code`, `message`, `hint` (one sentence, what to run next),
  `retryable`, `field_errors`. No fuzzy suggestions; unknown flags fail.
- Additive-only rule for `api_version 1.x`: new flags and commands only; a removed or repurposed
  flag bumps the major version. A contract snapshot test enforces it.
- Acceptance: `agentMain.test.ts` and `editorAgentBroker.test.ts` assert the envelope count and
  exit code per command class; the doc section "Start and discover" is regenerated from the
  contract, not hand-written.

### Phase 3: one time base

- Every time flag accepts `m:ss.s` or seconds and an optional domain suffix: `1:43` and `103e`
  mean edited, `125.3r` raw, `10.4s` source. Bare numbers are edited everywhere. `transport
  seek` and `cutpoint --time` accept edited input and convert; their replies carry all three
  values for the resolved instant.
- Every reply that contains a time carries `time_base` next to it, as `state` already does.
- Acceptance: a resolver test table with real clip values (103 edited = 125.324 raw =
  10.418 source) and a `check --rule` that flags any reply field named `*Sec` without a base.

### Phase 4: proposals by default, and `shot`

- Any porcelain command whose plan removes footage (`edges`, `pauses`, `cutpoint`, trims in
  `plan`) stages by default. `--accept` applies directly and needs a reason string, like
  `--force`. The skill loop becomes: propose, `staged`, Olle or the agent reviews, `accept`.
- New observe command `shot --at 3:50 [--words "…"] [--live]`: resolves the instant in all
  three bases, reports project id, revision, dirty flag, the visible layers with their sizes and
  anchors, the transcript ±5 s, the nearest cuts, staged proposals in range, and one image. The
  image is the saved render unless `--live` seeks the editor and grabs the live preview; the
  reply says which. This is audit recommendation 2, unchanged.
- Acceptance: on a project clone, `edges` with no flags leaves the project hash unchanged and
  `staged` lists the cuts; `shot --at 4:25.7` returns the mid-sentence cut Olle reported with
  the sentence text and the staged pill that causes it.

### Phase 5: batch runner (code mode without the sandbox)

- `klippt agent batch --input steps.json [--stop-on error|warning] [--verbosity summary|full]`:
  a JSON array of porcelain invocations run in one Electron process against the live editor, in
  order, each as its own guarded apply with its own request id derived from the batch id and
  index. Output is one summary: per step status, introduced findings, hashes before and after,
  and only the first failure's full reply. Frames for every touched instant land in a folder;
  the reply lists paths, not pixels.
- This is what the 30-row shot map needs: one call, one review, one undo point per group.
  `history` records the batch as a group so `undo --to` reverts it in one step.
- Acceptance: the shot map's first six rows as a batch on a clone: one stdout envelope under
  20 KB, six history entries plus one group, `undo --to GROUP` restores the hash, and the
  contact sheet exists.

### Phase 6: content-level proof

- `verify --range a b` (also run inside the verify block when `--deep`): decode the real audio
  and compute RMS per 20 ms across every cut edge in range with ffmpeg; flag any cut where the
  level 0–120 ms after the out point is within 15 dB of the word tail. Sample real frames at
  each cut and each overlay edge into a filmstrip with the waveform under it. Findings join the
  normal check output as `cut.clipped-word` (error) and `frame.black|frame.identical` (warning).
- Receipts gain `sha256_before` and `sha256_after` of the project file and of any imported
  media, like Kinocut's video receipts, so a later agent can prove what an edit touched.
- Acceptance: the restored "experiment" and "yourselves" cases become fixtures; the old
  tightened trims must fail `cut.clipped-word` and the restored ones must pass.

### Phase 7: fresh-agent evaluations

- `scripts/agent-eval/` with the three audit cases plus the held-out ones: what is at 3:50 and
  is it live; place the round-one restrictions card; propose a pause removal then recover from
  an interrupted reply; swap a B-roll; undo a batch. Each case is a prompt, a project clone, and an
  end-state grader (hash, staged count, check counts, transcript diff, frame presence). Graded
  on end state only, the Terminal-Bench rule. Run one agent at a time on this Mac.
- Record runs in the skill's `evaluations` section: date, skill version, CLI version, pass/fail
  per case, tokens, wall time, wrong-time edits, unintended mutations.
- Acceptance: a first run of old skill versus new skill with fresh Codex sessions. Report the
  numbers to Olle; a gap that does not close is a CLI bug, not a prose fix.

## Accepted refinements from ffmpeg-skill (September 18)

Olle approved these additions after reviewing `kajisho5/ffmpeg-skill`. They extend the
existing phases; they are requirements, not a claim that the running CLI implements them.
The orchestrator chooses implementation order and agent assignments. Finish the current acceptance
pass first, retain its evidence, and identify already-satisfied requirements before adding
work. Prioritize verification requirements and capability checks.

### Verification requirements in the contract (phases 2, 4, 6)

Each editing command declares effects and required evidence in machine-readable metadata
from the same registry as discovery. Separate commit status from verification status
(pending, passed, failed, unavailable). Preserve receipts when proof fails; never encourage
repeating a committed mutation. A command cannot claim an agent watched or listened.

- Camera, zoom, and B-roll changes need inspection of the changed span and boundaries.
  Live-preview defects need live playback and seek evidence. Saved renders cannot satisfy
  live requirements. Motion and cut changes also need an affected-span export.
- Speech cuts need isolated audio evidence and listening; RMS remains supporting evidence.
- Record revision/hash, time base, live/saved/export source, requested and observed time,
  freshness, and artifact paths where applicable.
- Acceptance: a camera edit with only a saved PNG leaves live verification pending; stale
  frames cannot pass; a committed edit with missing proof retains its recovery receipt.

### Command-scoped capability checks (phases 1, 2)

Add readiness inspection, for example `doctor --command shot --json`, identifying CLI,
editor, and relevant native component builds and capabilities. Assess compatibility from
the required contract and capabilities, not version labels alone or a blanket requirement
that build IDs match. Report available, unavailable, or unknown, with reasons and next actions.

- Acceptance: an unreachable editor leaves saved reads available but live operations
  unavailable; an unrecognized component reports unknown; a renderer without fresh-frame
  evidence cannot claim live verification support.
- Probe only relevant dependencies. Reuse valid results and invalidate them after session
  or build changes. Inspection must not restart the editor or switch projects.

### Tests prevent contract drift (phases 1, 2)

Couple flags, defaults, command effects, and verification metadata to the executable
registry. Require metadata for new commands instead of inventing defaults. Acceptance:
changing a flag updates discovery from the same source; incompatible changes fail the
versioned contract gate; every shipped skill example parses without mutating a user project.

### Compact output preserves recovery (phases 2, 5)

Offer opt-in compact replies for ordinary calls and retain the batch summary design.
Keep status, commit status, request/receipt identity, revision, evidence source/freshness,
finding counts, recovery hints, and artifact paths. Put bulky details and images in artifacts;
avoid inline base64 by default. Preserve the full contract for compatibility. Acceptance:
compact and full replies support the same action/recovery decision on completed, failed,
stale, and unknown-commit fixtures.

### Visual comparisons target cut boundaries (phases 6, 7)

Provide before/after contact sheets and consecutive frames around affected cuts and effect
edges. Label source, clock, revision, and cadence. Sparse samples cannot prove a one-frame
flash absent; creating a sheet does not constitute visual review. Live proofs must come
from the live compositor.

Acceptance: clone-based regression coverage includes the edited 59.904-second camera seam
in [the live-preview evidence](../artifacts/swarm-launch-footage-2026-09-18/screen-57/REVIEW.md).
Include a known flash and a corrected control. Check seeking and continuous playback.
A clean export must not mask failed live verification. Grade pixels, timestamps, and honest
reporting; matching a success phrase is insufficient.

### Local skill routing

Klippt project edits, reviews, and exports use `klippt-edit` by default, including implicit
references to the current project. `ffmpeg-skill` handles explicit FFmpeg work, standalone
media processing, supporting file measurements, and disclosed fallbacks for operations the
installed Klippt interface cannot perform. A video filename alone does not select FFmpeg.
External rendering must not silently replace native editable project work.

The shared installed FFmpeg skill at `~/.agents/skills/ffmpeg-skill/SKILL.md` carries this
local routing adjustment; Claude and Codex link to it. Retain that boundary on vendor
upgrades. `klippt-edit` retains the durable default and fallback rule. Acceptance: active
project flash reports and B-roll zooms select Klippt; explicit FFmpeg transcoding and
standalone audio extraction select FFmpeg; file measurement does not authorize project edits.

Sources inspected September 18 (source/test review, not an executed upstream test run):
[contract](https://github.com/kajisho5/ffmpeg-skill/blob/main/docs/contract.md),
[contract and capability implementation](https://github.com/kajisho5/ffmpeg-skill/blob/main/scripts/_contract.py),
[contract tests](https://github.com/kajisho5/ffmpeg-skill/blob/main/tests/test_contract.py),
[visual inspection tool](https://github.com/kajisho5/ffmpeg-skill/blob/main/scripts/look.py).
These support engineering patterns; they do not establish editorial quality or change the
CLI-first decision.

### Not in this plan

- MCP adapter for customers: after the paid alpha, over the same broker.
- Typed TypeScript client over the socket: only if evaluations show batch is not enough.
- Windows and Linux capture, billing: `PRODUCT_PLAN.md`, not this week.

## Evidence base

Local, measured 2026-09-18 on this checkout with the dev editor open on a real project:
command latency, reply sizes, command count, symlink absence, envelope count in
`electron/cli/agentMain.ts`, the audit's failed cutpoint probe. Failure history from
`HANDOFF.md`, the orchestrator handoff, and the project memory.

External, fetched 2026-09-18 (primary unless noted):

- Anthropic, Writing effective tools for agents (2025-09-11); Code execution with MCP
  (2025-11-04, 150k → 2k tokens); Building agents with skills (2026-01-22); Agent Skills
  specification (agentskills.io: three-level disclosure, SKILL.md under 5,000 tokens, one
  reference level deep, `compatibility`, `allowed-tools`, `skills-ref validate`).
- Cloudflare, Code Mode (2025-09-26) and Code Mode MCP (2026-02-20, 1.17M → 1k tokens at
  2,500 endpoints).
- Vercel, Agent skills FAQ (2026-01-26) and Skills Night (2026-02-20): MCP too heavy for
  knowledge; skills for procedure, MCP for external services. agent-browser SKILL.md delegates
  to `skills get`.
- Microsoft playwright-cli README: CLI as skill over MCP for token efficiency; state on disk,
  agent reads what it needs. The 4× figure circulates only in secondary posts.
- MCP project blog: tool annotations are a risk vocabulary, not a guarantee (2026-03-16);
  2026-07-28 spec is stateless with tasks as an extension.
- Arcjet, Designing a CLI for AI agents (2026-06-02): additive-only contracts, exit-code
  taxonomy, confirmation envelope with `confirmCommand`, no fuzzy suggestions, TTY-aware output.
  Weishu Zhang, The shell is a protocol now (2026-07-16): two-step mutations, idempotency keys,
  hierarchical help. Armin Ronacher, Agentic coding recommendations (2025-06-12): CLI over MCP.
- Terminal-Bench: grade end state, not transcript. AgenticVBench (arXiv 2605.27705): best stack
  near 30 %, harness choice changes failure modes.
- Descript, Don't ship your API as an MCP (2026-06-23): one agentic endpoint, spec-driven
  instructions; Descript MCP docs. DaVinci Resolve 21.1 native MCP (88 tools). Premiere Pro MCP
  (preview token before commit, `capture_frame` proves structure not pixels). FCP MCP
  (filmstrip plus waveform `preview_check`, hash-checked undo journal). Kinocut (preflight
  guardrails, SHA-256 receipts, release checkpoint). Cap `cap guide --json` and explicit
  confirmation before destructive ops. Remotion deprecated MCP for skills (2026).
- clig.dev: `--json`, exit codes, errors that guide, `--dry-run`, crash-only retry. No agent
  content.
