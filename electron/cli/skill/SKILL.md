---
name: klippt-edit
description: Instructions for the installed Klippt agent CLI.
---

# Edit with the Klippt agent CLI

Use the CLI as the default editing interface. This document ships inside the executable;
read it again after switching builds. `app_version` is the package version, not a unique ID
for uncommitted code. `content_sha256` identifies these instruction bytes only. A running
editor can still be an older build than the CLI; do not infer renderer parity from either field.

## Discover before acting

```sh
klippt agent skill --json
klippt agent guide --skill --json
klippt agent guide --command cutpoint --json
klippt agent guide --command batch --json
klippt agent operations --type addTrim --json
```

`skill` and `guide --skill` return identical content. Discovery needs no project or editor.
Use `guide --command` for the installed flags and `operations --type` for edit payload schemas.
Do not guess flags from another tool, an old skill, or a future plan. This build includes
`shot`, `verify`, `batch`, `e`/`r`/`s` time suffixes, and stage-by-default footage removal.

The development launcher is `scripts/klippt`, normally linked as `klippt` on PATH. It keeps the
caller's working directory for relative input/output paths, follows launcher symlinks, clears
`ELECTRON_RUN_AS_NODE`, and adds `--json` when stdout is not a terminal. It never selects the old
installed app. If the built runtime is missing, follow the launcher's build instructions.
Packaged launcher installation is not provided by this development shim.

Examples below use concrete **fixture** IDs and paths. Discover real IDs first; do not send
fixture writes to a user's project. Read the editing brief. Work on a clone unless the user
explicitly authorizes the original. Back up a saved project before its first authorized write.
Never open a current project with an older app that cannot read its schema.

## Effects are different

- Read: `skill`, `guide`, `contracts`, `operations`, saved `inspect`/`timeline`/`item`/`transcript`,
  live `live`/`state`/`history`/`staged`, and settings/preset reads inspect state. They do not edit it.
- Analyze/render: `check`, `verify`, `cutpoint`, `edges`, and `pauses` can load observations,
  decode media, or start background analysis and caches. A ready `cutpoint`/`edges`/`pauses`
  result also stages its suggested cuts into the proposal lane by default; the document is not
  written. `shot` composes one-observation replies and writes one image file; with `--live` it
  seeks the editor first. `assets`, `frame(s)` and `preview` can decode/render media and write
  proof files; they do not apply document edits.
- Prepare/review: ordinary `plan` and `import-plan` prepare candidates; they do not commit them.
  `plan --stage` changes the temporary proposal lane for trim-only operations. `reject` changes
  proposal state and local rejection memory. Neither is a read-only query.
- Apply: `apply`, `accept`, placement commands such as `text add`/`broll add`/`broll swap`,
  `zoom add`, `camera set`, `layout set`, `clip replace`, settings writes, automatic edits,
  `undo` and `redo` can change the document. Preset save/delete change the preset library.
  `--accept "<reason>"` on `edges`, `pauses`, or `cutpoint` applies the suggested cuts directly.
- Other effects: `clone` writes a new saved project; `open` changes the editor's project.
  `transcribe` starts transcript generation and can update the document. `transport` can seek,
  play, pause, click or scroll the live editor. It is not passive inspection.

## Time bases and suffixes

There is no single universal time base, but there is one input syntax. Any time flag accepts
an explicit clock suffix: `103e` edited, `125.3r` raw, `10.4s` source. An `m:ss.s` timecode
such as `1:43` is always edited. Without a suffix, a bare number keeps the command's documented
default base below; bare numbers are not edited everywhere.

| Input                                                                                                           | Default base for a bare number                                                 |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `state --at`, `check --range`, `frame(s) --at`, placement `--at`/`--from`/`--to`, `shot --at`, `verify --range` | Edited playback seconds                                                        |
| `preview --time`                                                                                                | Speed-adjusted export/output seconds                                           |
| `cutpoint --time`, transcript word times, trim operation `startSec`/`endSec`                                    | Source asset seconds; cutpoint requires a clip ID                              |
| `geometry --time`                                                                                               | Source seconds in the selected visible clip                                    |
| `transport` script `seek.sec`                                                                                   | Raw virtual timeline seconds, not the compressed edited clock                  |
| Legacy region fields such as `startMs`/`endMs`, unanchored zoom regions                                         | Raw virtual timeline positions; milliseconds or seconds as named by the schema |

Word anchors follow a resolved transcript phrase. Source anchors belong to a clip; edited
anchors use the edited clock. Source offsets in B-roll belong to the overlay's own media.
Use `state` to resolve edited time to raw/source coordinates and clip identity before building
low-level operations; `state`, `cutpoint`, and `transport` seek replies carry all three bases.
`frame(s) --at` accepts the trim-compressed editor clock and converts it to speed-adjusted
export/output time. `preview --time` uses that output clock directly.
With the first 10 s at 2× speed, `frame --at 6` corresponds to `preview --time 3`.
Using `preview --time 6` would inspect a later moment.

```sh
klippt agent live --json
klippt agent state --project_id proj_fixture --at 1:43 --range 1:40 1:46 --json
klippt agent state --project_id proj_fixture --at 125.3r --json
klippt agent shot --project_id proj_fixture --at 1:43 --json
klippt agent transcript --project_id proj_fixture --clip clip_fixture --json
klippt agent cutpoint --project_id proj_fixture --clip clip_fixture --time 20 --edge out --json
klippt agent cutpoint --project_id proj_fixture --clip clip_fixture --time 23.73 --edge in --json
klippt agent pauses --project_id proj_fixture --preset balanced --json
```

Poll analysis using the same command until `data.status` is `ready`; read missing-evidence flags.
Follow pagination fields to avoid treating a partial list as the complete result.

## Stage removals, review, then accept

Footage removal is a propose → staged → review → accept loop. `pauses`, `edges`, and
`cutpoint` stage their suggested cuts into the editor's proposal lane by default: nothing is
written and no project is saved. Review the lane, then accept or reject. Staging does not
authorize acceptance. Accept only when the user has explicitly authorized those removals or
delegated acceptance within this editing scope. Otherwise leave them staged.

```sh
klippt agent edges --project_id proj_fixture --json
klippt agent staged --project_id proj_fixture --json
```

For cuts from your own analysis, copy reviewed pause operations or proposed trim corrections
into a trims-only JSON file, validate its payload shape with `operations`, and stage it
explicitly:

```sh
klippt agent plan --project_id proj_fixture --input "/tmp/klippt fixture/cuts.json" --stage --json
klippt agent staged --project_id proj_fixture --json
```

The next commands are **mutating examples**, only for a fixture or an authorized selection:

```sh
klippt agent accept --project_id proj_fixture --ids pause_fixture --json
klippt agent reject --project_id proj_fixture --ids pause_fixture --json
klippt agent pauses --project_id proj_fixture --preset balanced --accept "reviewed in staged; cuts match silence" --json
```

`--accept "<reason>"` skips the lane and applies through guarded plan/apply, recording the
reason on the trim operations. Without IDs, `accept` applies selected proposals and clears
the lane. With IDs, it accepts those exact proposals, even if deselected. Switching projects
or restarting clears proposals; local rejections persist. Do not restart an editor to clear
uncertainty or lose a user's review work.

## Read the complete output and recover unknown writes

In JSON mode, stdout carries exactly one terminal JSON envelope per invocation. Progress and
`planned` envelopes are NDJSON on stderr, together with diagnostics; `--stream` moves them
onto stdout for single-stream callers. Do not treat a `planned` envelope as an applied edit.

Exit codes are part of the contract: 0 completed; 2 invalid input (fix the flagged
`field_errors`); 3 blocked by checks or confirmation required (the reply carries the exact
`confirm_command`); 4 editor or owner unavailable; 5 revision or history conflict; 6 timeout;
7 failed. Every error object carries `code`, `message`, `hint`, `retryable`, and
`field_errors`. `api_version` 1.x is additive-only: new commands and flags only.

Inspect the terminal `status`, `error`, `commit_status`, receipt and `next_actions`, plus the
process exit status. A `completed` request can still return `data.status: "analyzing"`.
`check` always exits zero, even for a failed request; its counts and status must be inspected.
`failed` with `commit_status: "committed"` means a write may have succeeded before proof failed.
Exit 6, `recovery_required`, or a disconnected process leaves the commit state unknown.

For ordinary writes, prepare a plan, inspect its summary/candidate, and apply only the reviewed
plan using a stable request ID. When the commit state is unknown, the write may have committed:
query `receipt` with the ORIGINAL request ID BEFORE any retry, and make the retry reuse that
same request ID; a fresh request ID can duplicate a committed write.

```sh
klippt agent plan --project_id proj_fixture --input "/tmp/klippt fixture/layout.json" --json
klippt agent apply --project_id proj_fixture --plan_id plan_fixture --request_id fixture-layout-001 --json
klippt agent receipt --project_id proj_fixture --request_id fixture-layout-001 --json
klippt agent history --project_id proj_fixture --json
```

Reuse the original operation request ID when available, not a later inspection request ID.
Pass `--request_id` to `accept` to keep a known recovery ID. Without it, preserve the generated
response ID. If the reply is lost before you learn it, inspect history and state; do not blindly repeat
acceptance. Guarded writes require a saved, synchronized project. Preserve unsaved work when
reported dirty; have the owner save or reconcile it. A stale plan needs a fresh reviewed plan;
`--force` is not a remedy for unknown commit state or permission to overwrite user work.

For many sequential writes, `batch --input steps.json [--stop-on error|warning] [--verbosity
summary|full]` runs the steps in order in one process and returns one summary envelope with
per-step status and exit codes; every step is validated before any write runs. Steps without
their own `--request_id` join one undo group, reverted with `undo --to <batch_id>`. Nested
batches are rejected. Query `guide --command batch --json` for the step format.

## Proof and limits

`state` and `check` inspect the live editor document and return its revision/document hash.
Saved `inspect`, `timeline`, `item`, and `transcript` read files, which can lag unsaved edits.
`assets`, `frame`, and `frames` load the canonical saved project by ID. They exclude unsaved
editor changes. Their hashes and rendered pixels describe that saved document, not the live
editor document. `preview` renders a saved snapshot/candidate. Neither rendering path is a
screenshot of the live transport or proof of successful playback. If the editor is dirty,
saved frame proofs cannot verify its unsaved changes; preserve and reconcile that work first.
`geometry` describes planned bounds without decoding pixels. Use authorized transport sampling
for live behavior. Inspect actual proof images, not just returned paths.

`shot --at`/`--words` answers "what is on screen at this instant" in one reply: the instant on
all three time bases, revision and dirty flag, visible layers, transcript ±5 s, nearest cuts,
staged proposals in range, and one image — the saved render by default, the live canvas frame
with `--live`; `image.source` and `evidence` say which. A `--live` image also carries
`image.frame_settled` and `image.freshness`: `"settled"` when the settle handshake proved the
painted frame postdates the seek; `"possibly_stale"` with `image.freshness_note` otherwise
(`frame_settled` is `false` on older shells — never silent). Cross-check a possibly-stale
image against the saved render before trusting it.

`verify --range a b` decodes the real media at every cut and overlay edge in the edited-time
range with ffmpeg: `cut.clipped-word` (error), `frame.black` and `frame.identical` (warnings),
and `content.unavailable` (error — nothing was verified at that edge, so the range is not a
pass). Frames plus a filmstrip land in `--out` or the agent cache; at most 100 edges per run.
`apply --deep` adds this decoded content pass over the touched span to the write's verify
block. `check --rule reply.time-base` audits a reply for unlabeled `*Sec` fields.

```sh
klippt agent inspect --project "/tmp/klippt fixture/edit.klippt" --json
klippt agent check --project_id proj_fixture --all --deep --json
klippt agent verify --project_id proj_fixture --range 1:40 1:50 --json
klippt agent frames --project_id proj_fixture --at 103,104,105 --out /tmp/klippt-proof --json
```

Checks cover implemented structural rules and available transcript/audio evidence. Zero findings
are not a guarantee of legal or perceptually correct edits. Read skipped-evidence notes. Cutpoint
is an estimate; transcription can miss words or misalign endings. Quiet energy is not speech proof.
Before tightening a real cut, measure **isolated microphone** RMS in 20 ms bins from 0.3 s before
to 0.6 s after the candidate. Confirm the track, not just `0:a:0` in a mixed recording. A sustained
drop at least 15 dB below the word tail is a review threshold, not a certificate; reject renewed
word-tail energy and listen across the actual seam. Do not cut from a short in-word quiet pocket.

Video B-roll draws above the screen and its zooms in the native compositor. Adding a screen zoom
does not zoom that overlay. Verify the actual B-roll framing; do not claim the zoom affects it.
Keep the camera off the evidence, one text card per claim, and camera/zoom boundaries coherent
with cuts. Prefer fewer clean cuts. Never caption a claim the footage contradicts or expose
confidential material. Apply the user's current content brief and taste rules.

Before reporting completion, inspect frames at changed moments, run relevant checks, listen to
changed seams and watch a real export when authorized. State which evidence was actually obtained
and which was unavailable. No command or static instruction guarantees a good edit.

## Readiness, proof status, and compact replies

`doctor --command <name> [--live]` probes only dependencies relevant to that command.
It never restarts, seeks, or switches projects. Saved reads remain available without
an editor. Unknown component contracts remain `unknown`, even if version labels
match. CLI and renderer build IDs identify the answering build; different IDs alone
do not establish incompatibility. Read `guide --command` for command effects,
capabilities and required evidence. Native render/audio components without a recognized
report remain unknown; discovery is not a successful decode or export.

```sh
klippt agent doctor --command inspect --json
klippt agent doctor --command shot --live --json
klippt agent guide --command camera --compact --json
```

Editing replies distinguish `commit_status` from `verification.status`: pending,
passed, failed, or unavailable. Missing evidence remains pending. A committed edit
keeps its receipt when proof fails. Query that receipt; do not repeat the mutation to
obtain proof. A saved PNG cannot satisfy live seek/playback proof. Visual inspection
and listening require an actual review; the command cannot claim either happened.

`--compact` is opt-in. It retains status, receipt/revision identity, proof status,
source/freshness, finding counts, recovery hints and artifact paths. Bulky fields
and inline media move to `full_reply_path` under `klippt-agent-artifacts` in the
caller's directory. If saving that artifact fails, stdout retains the full reply
and reports `output_mode: full_fallback`. Full output remains the default.
