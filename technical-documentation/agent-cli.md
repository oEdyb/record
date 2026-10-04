# Agent editing CLI (experimental)

Klippt exposes the same saved document, effects, compositor, and Undo history used by the editor.
The CLI does not call a language model. Use Codex to select commands and inspect their results.
This is a foundation for agent editing, not complete editor parity or a measured automatic-editing quality claim.

## Start and discover

Use the canonical `klippt agent ...` entry. In this checkout, `scripts/klippt` is the development
launcher; it can be linked onto PATH. It resolves symlinks, keeps the caller's working directory
for relative input/output paths, clears `ELECTRON_RUN_AS_NODE`, and uses this checkout's Electron
and built runtime. It never falls back to an installed app. Missing dependencies or a missing
build produce an actionable error. Use `npm install` and `DEVELOPER_DIR=/Library/Developer/CommandLineTools npx vite build`
from this checkout when needed. Packaged launcher installation is deferred.

```sh
klippt agent skill --json
klippt agent guide --skill --json
klippt agent guide --command cutpoint --json
klippt agent operations --type set-layout --json
```

`skill` and `guide --skill` need no editor, project, or broker. Both return the same bundled
Markdown in `data.content`, with `api_version`, `app_version`, and `content_sha256`. The content
is embedded during the build, not loaded from the caller's working directory. The package
version does not identify uncommitted source changes; the digest identifies instruction bytes
only. Neither field proves that an already running editor uses the same build.

For live editor commands, use Node 22.22.1 and a current app/native build. Launch the GUI with
`OPENSCREEN_AGENT_CLI=1` and open a **copy** of a project. The bridge is off by default.

```sh
env -u ELECTRON_RUN_AS_NODE OPENSCREEN_AGENT_CLI=1 ./node_modules/.bin/electron .
klippt agent live --json
```

The launcher defaults to JSON when stdout is not a terminal. On a terminal, `state` and `check`
use human output unless `--json` is supplied. In JSON mode every invocation prints
**exactly one terminal JSON envelope on stdout**. Progress and `planned` envelopes are NDJSON on
**stderr**; `--stream` moves them onto stdout for single-stream callers. Diagnostics stay on
stderr. The launcher preserves both streams and the runtime's exit status.

Exit codes are part of the contract and are listed in every `guide`/`contracts` reply under
`output_contract.exit_codes`:

| Code | Class                                      | Meaning                                                                                                                                       |
| ---- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | completed                                  | The terminal envelope carries `status: "completed"`.                                                                                          |
| 2    | invalid input                              | Fix the flagged `field_errors`; `guide --command NAME --json` shows the installed schema. Unknown flags fail; there are no fuzzy suggestions. |
| 3    | blocked by checks or confirmation required | The reply carries the exact `confirm_command` to run to proceed (for example an apply with `--force`).                                        |
| 4    | editor or owner unavailable                | Start Klippt with `OPENSCREEN_AGENT_CLI=1` and open the project, then retry.                                                                  |
| 5    | revision or history conflict               | Re-read `state`/`history` and rebuild the plan against the current revision.                                                                  |
| 6    | timeout                                    | Commit state is unknown; query `receipt` with the original request ID before any new write.                                                   |
| 7    | failed                                     | The terminal envelope's `error` object carries the details.                                                                                   |

`check` is the documented exception: it can exit zero with a failed request, so inspect its
payload. Every `error` object has the same five fields: `code`, `message`, `hint` (one sentence
on what to run next), `retryable`, and `field_errors`.

`api_version` 1.x is additive-only: new commands and flags only. A removed or repurposed flag
requires a new major version, and a snapshot test over every command's schema enforces it.

Read the terminal `status`, `error.code`, `commit_status`, receipt, and `next_actions`, together
with the process exit status. A planned result is not an applied edit. `completed` may contain
`data.status: "analyzing"`. A failed proof can follow a committed write. Recover an unknown write
with its original request ID before sending another write.

`guide --command NAME` returns the installed input schema. `operations --type NAME` returns the
actual strict edit schema. Unknown fields fail. Read the bundled instructions and installed
schemas instead of guessing. The instructions distinguish read, analysis, proposal, apply,
and live transport effects and explain the time bases and their `e`/`r`/`s` suffixes.
`pauses`, `edges`, and `cutpoint` stage their suggested footage removals into the proposal
lane by default — nothing is written until `accept`. `--accept "<reason>"` on those commands
applies directly through guarded plan/apply. Acceptance still requires explicit user authority.
`plan --stage` remains the explicit staging route for a trims-only operations file. The
foundation commands `shot` (one-instant observation), `batch` (ordered multi-step runs with
grouped undo), and `verify` (decoded content checks at cut/overlay edges) are listed by
`guide`/`contracts` like every other command.

## Plan, apply, recover

1. Save pending GUI changes. Read `live` for the active project ID and state.
2. Write a JSON array of operations to a local file. Prepare it with
   `agent plan --project_id ID --input operations.json`.
3. Inspect the plan summary. Apply its ID with
   `agent apply --project_id ID --plan_id PLAN --request_id UNIQUE_STABLE_ID`.
4. Keep that request ID. On an unknown result — a timeout (exit 6), a lost reply, or
   `commit_status` uncertainty — query `agent receipt --project_id ID --request_id ID` with
   the ORIGINAL request ID BEFORE any retry, because the write may have committed. A retry
   must reuse the same request ID for idempotency; a fresh request ID can duplicate a
   committed write.

Plans are private, bounded, and expire after 30 minutes. Apply compares the project revision and
uses the exact prepared candidate. Repeating the same request recovers its receipt without a second
edit. A changed project requires a new plan. Do not rewrite project JSON to bypass a conflict.
The normal editor Undo command reverses the edit; save to persist the undo.

If saving needs recovery, the editor offers receipt reconciliation, saving the local version as a
new project, or explicitly discarding unsaved changes and loading the saved version. An uncertain
external commit must be reconciled before local conflict recovery.

Example operations (normalized camera centers; output pixels; shared editor settings):

```json
[
	{
		"type": "set-layout",
		"settings": {
			"aspectRatio": "9:16",
			"outputResolution": { "width": 1080, "height": 1920 },
			"webcamPosition": { "cx": 0.75, "cy": 0.2 },
			"webcamSizePreset": 25,
			"screenFraming": { "scale": 1.3, "focalPoint": { "cx": 0.5, "cy": 0.5 } }
		}
	},
	{
		"type": "addZoom",
		"args": { "startSec": 2, "endSec": 5, "focus": { "cx": 0.4, "cy": 0.5 } }
	}
]
```

## Read only what the edit needs

- `inspect --project PATH`: bounded saved-project summary, effect IDs and content hash. This does not inspect live unsaved state.
- `timeline --project PATH --snapshot HASH --offset 0 --limit 25`: bounded clip page plus independent audio/effect lanes. Follow each lane’s `next_offset`.
- `item --project PATH --snapshot HASH --id ID`: one stable item. Array offsets are not mutation IDs.
- `geometry --project PATH --snapshot HASH --clip 0 --time 3`: planned native screen/camera bounds,
  centers, margins, and clipping at **source time**. Missing dimensions/cursor evidence is unavailable,
  not guessed. Geometry does not prove the visual contents are readable.
- `preview --project PATH --snapshot HASH --time 3 --out DIRECTORY --max_dimension 1280`: one composed
  PNG and a small manifest at **speed-adjusted export/output time**. `frame(s) --at` accepts the
  trim-compressed editor clock and converts it to this output clock; `preview --time` uses output
  seconds directly. With the first 10 s at 2× speed, `frame --at 6` corresponds to `preview --time 3`.
  The native compositor seeks the requested
  frame, including late frames in long recordings. It preserves the complete scene, clip indices,
  trims, speed regions, camera offset, and effect clocks. Limits: 128 clips, 128 assets, 1280 pixels
  per side, 8 MiB PNG, 30-second native frame deadline, and 90-second process deadline.
  Source media content is not hashed; project state is hash-bound. Rebuild native helpers before use.

Use geometry for position adjustments. Request images at decisions that require visual evidence:
readability, overlap, transitions, and the final composition. Avoid repeated full timeline reads.
Preview uses the native export frame quantization (60 fps), with a keyframe seek near the requested
source time and the export decoder advancement rule. It does not render earlier timeline frames
or audio. Cursor-track loading and smoothing still read the active source telemetry. A still image
does not establish animation continuity, audio quality, or final-resolution pixel quality.

## Time bases and suffixes (Foundation phase 3, September 18)

The timeline has four clocks, and one parser serves every time flag:

| Clock  | Meaning                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------- |
| edited | The trim-compressed playback ruler; what an agent means by "3:50"                                  |
| raw    | The stable document clock; trims still occupy their space                                          |
| source | A clip's own media time; what trims, `cutpoint`, and decoders use                                  |
| output | The speed-adjusted export clock (`preview --time`); only ever a default or a label, never a suffix |

Any time value accepts an explicit suffix that overrides the default: `103e` edited, `125.3r`
raw, `10.4s` source. An `m:ss.s` timecode such as `1:43` is always edited. Without a suffix, a
**bare number keeps each command's documented default base** — a deliberate compatibility
decision, so bare numbers are not edited everywhere: `state --at`, `check --range`,
`frame(s) --at`, placement `--at`/`--from`/`--to`, `shot --at`, and `verify --range` default to
edited; `preview --time` defaults to output; `cutpoint --time` and `geometry --time` default to
source; a `transport` script `seek.sec` defaults to raw. Replies that resolve an instant carry
all three timeline bases plus a `time_base` label map; raw input inside removed media resolves
to the seam. `check --rule reply.time-base` audits a reply payload for camelCase `*Sec` fields
whose object carries no `time_base` label (durations and offsets are exempt); it is CLI-local
and not part of the editor's document check rules.

## Words, silences, structure

- `transcript --project PATH --clip ID [--offset 0 --limit 200 --min_gap 0.5]`: the stored words,
  segments and silent gaps of one clip in **source seconds**, straight from the saved file. Gaps
  include the lead-in and tail. A clip without a stored transcript reports `not_stored` or
  `unavailable`; it never guesses.
- `transcribe --project_id ID`: asks the open editor to transcribe every timeline asset that has no
  stored transcript, then reports per-asset status (`stored`, `queued`, `running`, `failed`,
  `unavailable`, `missing`). Repeat the command to poll; it never restarts a running job. Save in
  the editor before reading the words with `transcript`.
- `pauses --project_id ID [--preset natural|balanced|tight] [--mode speech|audio-level]
[--min_pause S --shortened S --keep_before S --keep_after S --protect_system_audio true|false
--protect_screen_activity true|false --ignore_non_speech true|false] [--offset 0 --limit 200]
[--accept "REASON"]`: runs the editor's own Shorten
  Pauses detector (Silero speech activity, microphone envelope, transcript, screen-activity and
  system-audio protection) and returns paged suggestions plus ready `addTrim` operations. Speech
  mode first permits gaps between trusted local words (`sourceRole: "you"`, matching asset):
  sentence boundaries or gaps at least `--min_pause`. Audio refines inside those windows and
  keeps word margins. Absent/sparse transcript and clip edges require complete raw/cleaned
  detector silence; mic quietness and blip exemptions cannot override that evidence. Partial or
  invalid envelopes produce no proposals. `--mode audio-level` explicitly uses level alone and
  has no transcript-first safety guarantee. The first
  call answers `analyzing`; repeat the same command until `status` is `ready`. A ready page
  stages its operations into the proposal lane by default — nothing is written; review with
  `staged`, then `accept` or `reject`. `--accept "<reason>"` applies the page directly through
  guarded plan/apply and records the reason on the trim operations. The returned `operations`
  can also be written to a trims-only file and staged explicitly with `plan --stage`. A silence
  that touches a clip's start or end is cut back to the `keep_before` / `keep_after` padding, so a
  pass with `--min_pause 0.35` removes the half-second dead air at clip joins; a clip that is silent
  from start to end is never proposed for removal. `--ignore_non_speech true` (the default since
  2026-09-18) is the pane's "Ignore non-speech sounds" switch: a wordless microphone sound of at
  most 0.5 s between trusted words that no complete speech detector scores at 0.8 or more is part
  of the pause around it, and a
  wordless sound of at least 0.15 s inside a sentence is returned as its own suggestion with
  `kind: "blip"` (pauses carry `kind: "pause"`). `--clips a,b` limits suggestions and operations
  to those clip ids, so narration and gameplay can run with different settings; the gameplay
  recipe is `--min_pause 1.5 --protect_system_audio false --protect_screen_activity false
--clips <gameplay ids>` (the balanced padding, so `cut.loose-tail` stays quiet), because
  game audio and screen motion otherwise protect every moment of a gameplay clip.
- `edges --project_id ID [--pad_before 0.1 --pad_after 0.15 --min_gap 1 --max_clip_sec 120
--remove false --accept "REASON" --request_id ID]`: one call that finds the dead air of every
  take. At the start
  and end, complete raw/cleaned Silero envelopes and trusted local words protect where speech
  starts and ends. Inside the take, the shared speech-mode pause planner permits transcript
  gaps and requires detector silence outside transcript coverage. It never cuts on mic quietness
  alone during detected speech. Internal gaps retain `--pad_after` / `--pad_before`, disable
  wordless-blip removal, and require `--min_gap` seconds. `--min_gap 0` disables internal gaps.
  Existing trims and planned edge cuts remain protected. Clips longer than `--max_clip_sec`
  (gameplay) are skipped. Edge trims carry `reason: "edge-silence"`, gap trims
  `reason: "gap-silence"`, and `--remove true` takes exactly those trims out again.
  The command waits for analysis, then stages the suggested trims into the proposal lane by
  default — nothing is written; review with `staged`, then `accept` or `reject`.
  `--accept "<reason>"` plans and applies directly in one step and records the reason;
  `--remove true` is a direct guarded apply. The receipt uses `--request_id` when given. The
  September 17 mic-only measurement predates this stricter
  September 18 safety contract and is not evidence for its runtime behavior.
- `cutpoint --project_id ID --clip CLIP --time S --edge out|in [--pad_before 0.1 --pad_after 0.15
--sentence_gap 0.8 --accept "REASON"]`: where a sentence really ends or starts near a time, for an
  editorial cut. A bare `--time` number stays source seconds (compatibility); `103e`/`1:43`
  (edited) and `125.3r` (raw) convert, and the reply carries all three bases. The stored transcript picks the nearest sentence boundary (a word ending in
  `. ! ?` or a gap of `--sentence_gap` seconds without punctuation); the microphone level then
  finds the last sound of that sentence (`--edge out`) or the first sound of the next one
  (`--edge in`), because speech-to-text word ends drift into the silence (one "cool." was stored
  as 4.6 s long). For an out-point, the quiet interval must span the selected word end or start
  after it before the next word. Renewed energy before the word end disqualifies an early pocket;
  the 0.2 s minimum duration alone proves nothing. Continuous silence across a smeared word end
  remains eligible. Disagreement falls back conservatively to `method: "transcript"`; incomplete
  detector envelopes are not audio evidence. Review estimates against the isolated microphone.
  `cut_sec` adds the padding; `before` / `after` show the words on each side, and
  two `alternatives` list the next-nearest boundaries. A chosen cut stages the footage it
  removes into the proposal lane by default — nothing is written; review with `staged`, then
  `accept` or `reject`. `--accept "<reason>"` applies the trim directly through guarded
  plan/apply and records the reason. Speech detection is the fallback without a microphone track, the
  transcript timing the last resort (`method` says which). Repeat the command until `status` is
  `ready`; the first call may load the microphone envelope of a long recording.
- `transport --project_id ID --script FILE`: drives the open editor the way a user does and
  reports what it did. The file is a JSON array of steps: `{"op":"play"}`, `{"op":"pause"}`,
  `{"op":"seek","sec":S}` (raw timeline seconds, through the same path as a timeline click),
  `{"op":"click","testId":"timeline-ruler","fraction":F}` (real pointer down/up on that
  `data-testid` element, x at fraction F of the timeline canvas, so the click goes through
  the timeline's own scrub handler), `{"op":"wheel","testId":"timeline-tracks","fraction":F,"deltaY":-100,"ctrl":true}` (a real
  wheel event; Ctrl zooms, Shift or deltaX pans), `{"op":"wait","ms":N}`,
  `{"op":"sample","label":"…","frame":true}` (`frame` adds a 192 px JPEG data URL of the
  composited preview; the reply is capped at 64 KiB, so ask for a few frames per run) (records the playhead, the store's
  playing flag and every live `<video>` element's time and paused state) and
  `{"op":"probe","ms":N}` (runs the UI frame probe: rAF interval percentiles per state, late
  frame share, long tasks, live video count, preview frames painted and preview fps). At most 50
  steps and 60 s of waiting; the run continues in the editor and the command polls until ready.
  Use it to reproduce a playback report with numbers before touching preview code.
- A camera region edge within 0.6 s of a cut is drawn on the cut, already at full strength
  (`projectRegionsToSource(..., snapToCutSec)` in `timelineMap.ts`, used by
  `sceneDescription.ts` for preview and export). A region that starts a few frames after
  a cut otherwise shows the other layout first and then eases, which reads as a flash.
- Full-frame and emphasis camera regions that a trim or clip boundary splits keep the whole
  region's clock on every piece (`envelopeStartSec` / `envelopeEndSec` in the scene); the
  native side also gates on the envelope, because the export walk can render a fragment's
  last frame a hair past the piece's end. Before
  this, each piece restarted its ease-in and drift at the cut, and the first frame after a cut
  rendered the small camera for one frame followed by a motion-blur ghost of it.
- `addCameraFullscreen` / `setCameraFullscreen` accept `cameraScale` (1–2, emphasis growth;
  the inspector offers the same range as "Camera size"), `driftScaleTo` (1–1.6) and
  `driftReleaseSec` (0.1–3, default 0.4): a slow ease-in-out push-in of the camera to that scale
  over the region, then a fast return to normal in the last `driftReleaseSec` before the cut.
  Works in `fullscreen` and `emphasis` mode; preview and export share the formula.
- `removeTrims {trimRangeIds}`: deletes exactly the listed trims in one operation. `removeTrim`
  follows the editor's pill rule (a tail trim and the touching lead trim of the next clip are one
  pill and go together, so a second id in the same batch can already be gone); `removeTrims`
  removes by id only, which is what a reversible batch such as `edges --remove` needs.
- `splitClip {clipId, sourceTimeSec}`: splits one clip at a source second. The left half keeps the
  clip ID, the right half gets a new ID, and anchored trims and effects follow their content.

## Supplied media

`media --directory PATH --depth 0 --limit 25` catalogs image, audio, and video candidates without
importing or decoding them. It does not follow symlinks.

`import-plan` prepares an explicit local image, audio or video import for the same plan/apply workflow.
Use its installed schema for the input file format. Image placement uses percentage top-left and
size coordinates. PNG/JPEG and decoder-supported WebP are bounded to 512 KiB, 16 megapixels, and
8192 pixels per side. The native decoder validates the image. The CLI response omits embedded image
bytes. Audio is probed for a real finite duration; clips specify edited-output start/end, source
offset, gain, and fades. Imports reference audio files and do not delete or move originals.

Music and sound effects use schema version 10. Their positions are on edited output time; changing
video cuts does not implicitly ripple audio. Preview uses the native cached float PCM stem. Export
mixes the same clip timing and fades before final mastering, so final loudness can differ from the
unmastered preview. Missing media fails visibly. Old readers must reject schema 10 rather than drop audio.

### Video B-roll overlays (schema 11)

A video import becomes an `assets` entry (kind video, duration probed by the bundled FFmpeg header
probe, never copied or moved) plus one **video overlay**: `{kind:"video", path, placement:{startSec,
endSec, sourceOffsetSec?, fit?, position?, size?, opacity?}}`. The overlay is drawn above the screen
layer and its zooms, and below the cursor, camera and annotations. It never carries audio; the
narration under it keeps playing. `startSec`/`endSec` are raw timeline seconds like zooms and
annotations, so the overlay is anchored to the clip it lands on and follows that clip through
reorders and trims. `sourceOffsetSec` is the overlay's own source time at `startSec`. Omit
`position` and `size` to fill the whole screen layer; supply both, in percent of the screen layer,
for a picture-in-picture box. `fit` is `cover` (crop to fill) or `contain` (letterbox).
`removeVideoOverlay` removes exactly the given fragment id; it never widens to a touching
overlay the way the editor's pill delete does.
`addVideoOverlay`, `setVideoOverlay` and `removeVideoOverlay` edit overlays whose asset already
exists. Old readers must reject schema 11 rather than drop overlays. Preview stills and export use
the same native layer.

## Current boundaries

Image entrance animation, zoom motion, camera emphasis/fullscreen regions, base aspect ratio,
camera position/size/crop, screen framing, trims, splits, pause shortening, transcription,
annotations, audio clips, and video B-roll overlays are supported. General animated layout
keyframes and complete GUI command coverage are not implemented; the timeline does not yet show
overlay pills, so review overlays through `preview` stills and export. A timed camera fullscreen region demonstrates a layout change; it does not mean
aspect ratio can change during one export. Legacy chat writes fail closed after a project adopts
transactions; use the CLI or ordinary editor controls for that project.

See [implementation plan](../docs/agent-cli-implementation-plan-2026-09-07.md) and
[verification log](../docs/agent-cli-implementation-log-2026-09-07.md) for evidence and remaining gates.

Camera styling in `set-layout` accepts `webcamMaskShape: "squircle"` and
`webcamCornerRadius: 0..50` (percent of the shorter camera side). Squircle keeps source camera proportions by default. Set `webcamAspectRatio` to `source`,
`1:1`, `4:3`, `16:9`, or `9:16` independently of the corner style. The rounding setting affects non-circle PiP shapes; block layouts
keep their shared frame rounding. Omit the setting to preserve an existing project's default.
The native geometry response reports the resolved shape and radius in output pixels.

### Still renderer implementation sources (September 8)

The existing native contract in `electron/native/compositor-view/addon.d.ts` supplies offscreen
views and generation-tagged frame readback. `crates/compositor/src/timeline_walk.rs` owns decoder
advancement; `regions.rs::push_speed_segment` owns export frame quantization. The still renderer
keeps the full scene and uses those time rules. Its opt-in native time override leaves normal
live playback unchanged. PNG encoding follows the browser's required
[Canvas PNG contract](https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-todataurl).
Main verifies the original hash and resolution-only derived document before media approval,
checks both documents again before PNG publication, and creates output exclusively without overwrite.

## Effective state and edit checks (Task A, September 18)

```sh
klippt agent state --project_id ID --at 1:43 --json
klippt agent state --project_id ID --at 1:43 --range 1:40 2:05
klippt agent check --project_id ID --all --page 1 --page_size 50 --json
klippt agent check --project_id ID --all --deep --json
klippt agent check --explain cut.mid-sentence
klippt agent check --project_id ID --range 1:40 2:05 --rule camera.nested
klippt agent guide --command state --json
klippt agent guide --command check --json
klippt agent contracts --json
```

`state` and `check` require the already-open project's editor bridge. They never seek, play,
open another project, or apply an edit. `state` requires `--at`; `--range` adds a span list.
Times accept nonnegative decimal seconds or `m:ss.s` on the trim-compressed transport clock,
plus the phase-3 suffixes: `r` names raw and `s` names source. The reply carries all three
bases.
A cut belongs to the following fragment. Speed-adjusted export seconds are a different clock.
Ranges must lie within the edit, with the end after the start. `--all` and `--range` are exclusive;
omitting both checks the whole edit. `--rule` selects one installed rule.

These two commands print compact human output unless `--json` is supplied. JSON uses the normal
versioned envelope. State is in `data.state`, with `data.spans` for the requested range. Checks
return `data.status`, `data.audio: {ready, pending}`, `data.timings`, and `data.result`.
The result starts with `counts` (`error`, `warning`, `info`, and `byRule`), `total`, `page`,
and `pages`, followed by `page_size`, `offset`, findings, notes and rule descriptions.
Counts cover all findings available so far, not just the current page.
`--page N --page_size 50` selects a one-based page, with 50 findings by default and at most 50.
UTF-8 byte budgets may shorten a page; `pages` and `offset` reflect those boundaries.
Pages are bounded before crossing the editor bridge; normal envelopes stay below 48 KiB.
Oversized individual detail is marked and its fix is omitted, never truncated into an unsafe operation.
Evidence notes have a separate byte budget and report `notesOmitted`.
Human output starts with rule counts and groups findings by severity. `--limit` defaults to 30;
human page size is the smaller of `--limit` and `--page_size`, so paging skips no findings.
The final continuation line is `N more, use --page`. `--explain RULE` prints its description,
severity and emitted fix without a project or editor connection.
Every check invocation exits zero, including failures: callers must inspect
`status` and counts. `contracts` lists all installed input schemas; `guide --command NAME` selects one.

Both responses include the editor transaction `revision` and `documentHash` (SHA-256 of the
in-memory document JSON). This hash includes unsaved changes; it is not the saved-file `snapshot`
hash used by `inspect`. Checks cache by document contents, revision, request, and file evidence.
The CLI returns each snapshot immediately; repeat the same command to poll.
Structural rules run first. Audio rules run per distinct kept timeline asset in a background queue
with two workers shared across check runs. Pending replies have `status: "analyzing"`, partial
findings and audio counts. Completion has `status: "ready"` and `audio.pending: 0`.
Changing page or page size reuses the run; document/revision, rule/range, deep mode or file evidence
changes invalidate it. File evidence order does not affect the cache key.
Microphone analysis reuses the existing audio-peaks disk cache. Speech activity uses the existing
Silero cache only with `--deep`; the default sentence check uses peaks and transcripts.
`timings.elapsedMs` is wall time, while `peaksMs` and `speechMs` sum per-asset load times
and can exceed wall time with concurrent workers. `audio.ready` includes completed attempts;
unavailable evidence is reported in notes. Page boundaries can change while audio is pending;
wait for `ready` before collecting every page from one document revision.
File existence is checked in the broker, with a document guard before the editor runs the rules.

State uses `buildSceneDescription`, `resolveVisibleClips`, `projectRegionsToSource`,
`resolveNativePosition`, and the existing caption cue projection. It reports edited/raw/source
time, clip identity, distances to cuts, project layout, active camera/zoom/annotation/video/caption
pieces, source spans, remaining edited duration, provenance, and audio routes. Layered values
carry `layer: "project"` or `layer: "clip:<id>"` when a clip overrides that value. Region IDs stay anchored to their
authored region across trim splits. Camera pieces use the scene's snapped edges. Source time and
active regions follow the renderer's end-of-fragment seek clamp, including at EOF.

`layout.geometryScope` explicitly identifies the scene's **base** layout. `cameraMode` and the
active regions identify full-camera/emphasis and their compositor parameters; `cameraBaseRect`
is not an evaluated animated frame rectangle. Native easing, drift, zoom, and cursor transforms
remain compositor-owned. This command does not claim final-pixel geometry. Webcam geometry uses
the scene builder's default source dimensions when runtime dimensions have not been supplied.
The audio route includes the available Clean Voice route, microphone/system levels and mutes,
active independent audio overlays, and delivery settings.

| Rule                     | Severity | Detection and available fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `camera.nested`          | error    | A kept emphasis piece lies entirely inside a full-camera piece. `removeModifier` for the emphasis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `camera.overlap`         | error    | Two distinct camera pieces overlap in kept footage. No automatic fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `text.over-camera`       | error    | Text intersects the scene camera base box. No automatic fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `text.over-broll`        | warning  | Intersecting B-roll draws above text. Native text draws above B-roll, so normal text-on-B-roll produces no finding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `broll.over-caption`     | warning  | Intersecting B-roll draws above captions, or captions are disabled for the B-roll span. Enabled captions draw in the later annotation pass. Clip caption overrides take precedence over the global setting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `overlay.orphaned`       | warning  | Missing word anchor, span beyond the edit, or no kept legacy footage. Ignores legacy fragments shorter than 1/60 s. `removeAnnotation` / `removeVideoOverlay` removes the named overlay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `region.near-cut`        | info     | An authored edge in kept footage is more than 1 ms and at most 0.6 s from an internal cut. Auto captions (`kind:caption`, `origin:auto`) are excluded; other captions are also skipped. Already-aligned and trim-created edges, authored spans and projected pieces shorter than one 60 Hz frame (1/60 s), are omitted. Notes camera snapping since September 18.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `region.off-cut`         | info     | A non-caption region has no kept piece. Auto captions (`kind:caption`, `origin:auto`) and other captions are excluded. Ignores raw spans shorter than 1/60 s. Reports its edited seam and original raw span.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `caption.orphaned`       | info     | An auto caption has no kept piece, but its source word IDs survive in its owning clip. Removed words, duplicate footage in another clip, and captions without word provenance are skipped. No fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `gap.silence`            | warning  | A microphone quiet span longer than 1 s survives inside a kept fragment. Notes each skipped asset when microphone peaks are unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cut.mid-sentence`       | error    | The cut lands inside speech: a transcript sentence spans the cut, or the adjacent-word candidate says audio continues on the removed side; when microphone peaks exist, the removed side must reach within 10 dB of the kept words (breaths, room noise and early Whisper onsets do not count). Then `planCutPoint` disagrees by **at least 0.5 s** for transcript evidence, or **more than 0.25 s** for microphone/speech evidence. Kept air after a sentence is never a finding. A removal of at most 1 s is exempt only within the same clip, between trusted local words, with a complete detector envelope showing silence across the removal. Missing words alone cannot exempt it. Microphone quiet spans under 0.2 s never count as gaps; longer spans must also reach the selected word end without renewed activity. One finding per edited cut, including across asset workers: microphone > speech > transcript, then larger disagreement. A matching trim gets `setTrim`; qualifying edge corrections share the trim endpoints. Missing transcripts and audio fallback are explicit notes. |
| `cut.loose-tail`         | warning  | Microphone air of **0.35 s or more** sits between the last word and an out-point, or between an in-point and the first word (mic-level evidence only, adjacent word only). Message names the air and the planner's padded cut; a matching trim gets `setTrim`. `gap.silence` still owns dead air of more than 1 s inside kept footage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `layout.unused-override` | info     | A clip layout override has no kept footage. `setClipLayout` with `layout:null` clears it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `asset.missing`          | error    | Missing source, camera sidecar, imported audio, image annotation file, or video-overlay asset. File access failures are unavailable evidence, not missing-file claims.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Every finding is `{rule, severity, at, span, clip, message, fix}`. `at` and `span` are edited
seconds; `clip` is the raw clip ID or null. `fix` is a ready-to-plan operation array, or null.
`cut.mid-sentence` also includes `cutEvidence:{method,disagreementSec}` for counting and ranking evidence. Findings do not mutate the document. Submit selected fixes through the existing plan/apply flow.

To add a rule, add one file under `src/lib/ai-edition/checks/` exporting a `CheckRule` object
with `{id, severity, describe, run(context)}`, then list it in that directory's `index.ts`.
Add small fixtures to `rules.test.ts` or a neighboring test file. Add `fix` description text when
the rule emits an operation; `--explain` uses it. No CLI change is needed.
The context is built once and includes caption word provenance, kept fragments with edited/raw/source spans, projected
regions per fragment, authored regions, transcript words, loaded microphone quiet spans,
assets, and file evidence. Keep rules pure and return findings plus optional evidence notes.

Tasks C and D below add overlay anchoring, source replacement, persistent history, and apply verification to this state/check foundation.

Implementation contracts checked: the repository's timeline projection and scene serializer,
[Zod schema API](https://zod.dev/api) (installed 4.4.3), and
[Node 22 file status API](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesstatpath-options).

## Per-clip camera layout (Task B, September 18)

```sh
klippt agent layout set --project_id ID --scope project --camera-anchor bottom-right --camera-size M
klippt agent layout set --project_id ID --scope clip:CLIP_ID --camera-anchor bottom-right --camera-size L --camera-shape squircle --captions off --json
klippt agent guide --command layout --json
```

`layout set` validates the selected clip, prepares a plan, applies that plan through the existing
write guard, and returns state at the clip's first kept edited second. Project scope returns state
at edited zero. It never seeks or starts playback. Fully trimmed clips have no kept second, so the
convenience command rejects them before writing; the plan operation can still store their overrides.
Use `--request_id ID` for a known receipt identity. On an uncertain apply, inspect that receipt
before retrying. If the final state read fails after apply, the response retains the successful
receipt and reports that the write committed.

| Camera size | Percent of compositor reference dimension |
| ----------- | ----------------------------------------- |
| `XS`        | 14                                        |
| `S`         | 20                                        |
| `M`         | 26                                        |
| `L`         | 34                                        |
| `XL`        | 44                                        |

The compositor reference dimension is the output's shorter side. Source camera aspect and shape
also affect the resulting box. Sizes accept any numeric percent from 10 through 80. Anchors are
`top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`.
Named anchors inset the camera's outer bounds by `legacyEditor.safeMarginPercent`, default 4% of
the output's shorter side, and use the camera box's actual half-size to find its center. Centered
axes stay centered. The setting accepts 0–50%; oversized insets center the box. Existing numeric
positions keep their original meaning and do not receive an extra inset.

Numeric CLI forms: `--camera-size 31` and `--camera-anchor '{"cx":0.8,"cy":0.7}'`.
`set-layout.settings` accepts `cameraAnchor`, `cameraSize`, `safeMarginPercent`, and `captions`
alongside its existing numeric `webcamPosition` and `webcamSizePreset` fields. Do not supply both
aliases for the same value in one operation. Named project anchors follow later camera size and
output changes; an explicit numeric position, including an editor drag, replaces that anchor.

`setClipLayout` has this operation shape:

```json
{
	"type": "setClipLayout",
	"clipId": "CLIP_ID",
	"layout": {
		"cameraAnchor": "bottom-right",
		"cameraSize": "L",
		"cameraShape": "squircle",
		"captions": false
	}
}
```

The document stores sparse values in `clipLayouts[clipId]`. Missing keys inherit the project.
A layout object patches only its supplied keys; `"layout":null` clears the entire clip override.
Clip IDs must exist. Split and duplicate preserve the sparse override on the new clip. Camera
shape accepts rectangle, circle, square, rounded, and squircle. Captions can be enabled for one
clip while the project is off, or disabled while the project is on. Existing documents without
`clipLayouts` retain their layout and do not acquire an empty override map during normalization.

**Native contract limit:** the schema also accepts `cameraLayoutPreset` and `screenFraming`
(`{scale:1..4,focalPoint:{cx:0..1,cy:0..1}}`), but either field in a clip override
fails with `CLIP_LAYOUT_UNSUPPORTED`. The current native per-clip contract copies rectangles, shape,
radii, and cover mode; it does not copy preset, reactive-camera behavior, or framing. Baking framing
into source crops changes automatic zoom targets and manual zoom easing. These two override keys
need a separate native extension before differing values can render correctly. Project-level
preset and framing edits remain supported. Plan validation checks the complete candidate. Even values equal to the current project
are rejected, so a later project change cannot leave an unrenderable clip override.

State includes named `cameraAnchor` and `cameraSize`, numeric camera center and size percent/fraction,
and a `layer` on every layout value: `project` or `clip:<id>`. Geometry remains the scene's base
geometry. The new `layout.unused-override` info rule reports an override whose clip is fully trimmed
away, with a ready `setClipLayout` clear operation. Other check rules are unchanged.

Implementation sources: [Zod schema API](https://zod.dev/api), checked against installed Zod 4.4.3;
`src/lib/compositeLayout.ts` for size/center geometry; and the existing native `for_clip_window`
contract in `crates/compositor/src/scene.rs`. No Rust source was changed for Task B.

Task B verification: both TypeScript checks pass; targeted tests pass 13 files / 345 tests;
full suite passes 306 files / 3,151 tests with one skipped. Lint passes 979 files with one existing
oversized Cargo evidence warning. i18n passes 12 locales / seven namespaces. No build, Electron
control, real-project write, rendered frame, or export verification ran in this task.

Task B files added:

- `src/lib/ai-edition/layout/schema.ts`, `vocabulary.ts`, `vocabulary.test.ts`
- `src/lib/ai-edition/checks/layout.unused-override.ts`, `layout.unused-override.test.ts`
- `electron/cli/agentLayout.ts`, `agentLayout.test.ts`

Task B files changed:

- `src/lib/ai-edition/schema/index.ts`
- `src/lib/ai-edition/store/editorSettings.ts`, `editorSettings.test.ts`
- `src/lib/ai-edition/document/timeline.ts`, `timeline.test.ts`
- `src/lib/ai-edition/captions/cues.ts`
- `src/lib/ai-edition/agent/effectiveState.ts`, `effectiveState.test.ts`
- `src/lib/ai-edition/checks/index.ts`, `rules.test.ts`
- `src/native/contracts.ts`, `sceneDescription.ts`, `sceneDescription.test.ts`
- `electron/ai-edition/agentEditPlan.ts`, `agentEditPlan.test.ts`, `document-service.test.ts`
- `electron/cli/agentContracts.ts`, `agentMain.ts`, `agentMain.test.ts`, `agentEditState.ts`, `agentEditState.test.ts`
- `technical-documentation/agent-cli.md`, `product-behavior.md`, `HANDOFF.md`

`DocumentService` already uses the shared document schema for load/save, so its implementation
needed no duplicate field handling. Its new test verifies persistence through that existing path.

## B-roll swap (Task G, September 18)

```sh
klippt agent broll swap --project_id ID --overlay VIDEO_OVERLAY_ID --file /absolute/gameplay.mp4 --json
klippt agent broll swap --project_id ID --overlay VIDEO_OVERLAY_ID --file /absolute/card.mp4 --offset 2 --fit contain --time hold --request_id swap-card-1 --json
```

Use `swap` to replace media in an existing video overlay. Use remove + add when a
new slot, placement, motion, or timeline location is needed. Swap keeps the overlay ID,
start, clip, placement rectangle, opacity and motion. Existing paths reuse their asset ID;
new videos use the same asset preparation as B-roll import. Swap accepts videos, not still images.
`--request_id` sets the apply receipt identity; `--force` bypasses introduced check findings,
not input validation, revision checks, or transaction guards. The command uses plan → checks →
apply and returns `receipt`, `verify`, and `swap` beside the retained plan.

- `--fit auto` is the default. Slot aspect is placement width/height in output pixels,
  or the complete canvas when placement is null. Within 8% relative to the slot aspect,
  choose `cover`; otherwise choose `contain`. `--fit cover|contain` forces the choice.
  `swap.fit` returns `chosen`, `slotAspect`, `mediaAspect`, and `reason`.
- `--offset SEC` is nonnegative source time and defaults to zero. Available media is
  probed duration minus offset. At most 0.5 seconds remaining fails `MEDIA_TOO_SHORT`
  before a plan is stored. Missing dimensions/duration fail `MEDIA_UNAVAILABLE`.
- `--time trim` is the default. If the source is shorter than the slot, shorten the end
  and report `shortenedBySec`. A longer source keeps the slot and reports `unusedTailSec`.
  No media is stretched or speed-changed. `swap.time.spanSec` is the original stored span;
  `availableSec` is the source duration after the requested offset.
- `--time hold` keeps the span. The shared compositor decoder holds its final valid frame
  after EOF; `swap.notes` reports the hold duration. Missing overlay IDs fail
  `UNKNOWN_VIDEO_OVERLAY` before media preparation.

`swap` also contains `overlayId`, `previousAssetId`, and `assetId`. Clip-owned legacy
source endpoints follow a shortened end so preview and export agree. Shortening an
edited/word-anchored overlay is pending the timing-policy decision; current builds reject
that case rather than save an end that playback ignores. Hold and non-shortening swaps
preserve those anchors. Evidence and current limits:
the Task G report (`artifacts/broll-swap-2026-09-18/`, kept locally, not in git).

## Text, B-roll, speech commands and frames (Task C, September 18)

```sh
klippt agent text add --project_id ID --from 1:43 --to 1:48 --text "Kimi K2 swarm" --anchor top --size M --style card
klippt agent text add --project_id ID --words "exact transcript phrase" --text "A label" --style label --motion rise
klippt agent broll add --project_id ID --file /absolute/demo.mp4 --from 1:43 --to 1:48 --fit cover --anchor center --motion fade
klippt agent broll add --project_id ID --file /absolute/image.png --words "exact transcript phrase" --fit contain --anchor right --size L
klippt agent zoom add --project_id ID --at 1:43 --speed quick --size L --anchor center
klippt agent camera set --project_id ID --from 1:43 --to 1:48 emphasis --size M
klippt agent assets --project_id ID --json
klippt agent frame --project_id ID --at 1:43 --out /absolute/frame.png
klippt agent frames --project_id ID --at 1:43,2:10,4:48 --out /absolute/frames
```

All seven commands appear in `guide` and `contracts`. Placement commands use `plan` and
`apply` through the same editor activation, candidate, revision, and receipt guards as `layout set`.
They print a `planned` JSON envelope containing findings before dispatching apply. The final envelope
retains the plan and receipt, including when a state read fails after a committed write. Preserve
`operation_request_id` on an uncertain result and query `receipt` before retrying. `--request_id`
sets that identity. Error findings that the plan INTRODUCES block apply (the plan reply lists them
under `introduced`; findings that already exist in the edit never block a write, 2026-09-18).
A finding is identified by rule, clip, message and fix, not by its edited-time span, so trims that
shift later findings do not make them "introduced". Plan and apply checks load cached microphone
peaks for the assets in the touched span, so cut rules use mic-level evidence at plan time; apply
compares the candidate against the plan-time baseline, so a file that goes missing after `plan`
still blocks. Explicit `--force` bypasses the check gate, while
revision and transaction guards remain mandatory. Generic `apply` also accepts `--force`.
Candidate checks run over the affected span with structural/transcript evidence. Audio evidence
is unavailable during this plan check and is reported in notes; use normal `check` for audio analysis.

Times use the same edited, trim-compressed clock as `state`, accepting seconds or `m:ss.s`.
Raw operation endpoints use the existing `playbackTimeToRawTime` inverse with after/before seam
affinity. `--words` requires one exact, case-sensitive phrase with whitespace normalized. Optional
`--from/--to` restricts phrase selection when words repeat. Missing, removed, or ambiguous words
fail before applying. A word span must follow contiguous source footage, including a split within
one asset. It does not join unrelated recording assets. Word anchors retain clip ID, asset ID for recovery after a split-owner removal, text, source
start/end, and the minimum duration; later resolution prefers original source coordinates across
same-asset split clips before a unique shifted match. Removed owners become orphan findings.

New text and B-roll store one `anchor: {kind:"edited",fromSec,toSec}` or
`{kind:"words",clipId,assetId,text,sourceStartSec,sourceEndSec,minimumDurationSec}`. Edited anchors hold
position when clips change. Word anchors re-find the phrase. Neither stores one overlay per clip.
The scene projects visible pieces and preserves animation/media elapsed time across boundaries.
Legacy overlays without this anchor retain the earlier raw/clip behavior. `startMs/endMs` on new
overlays are initial raw caches; the anchor controls rendering. Read current spans through `state`.

Text supports XS/S/M/L/XL. `style.preset` registers `card`, `lower-third`, and `label` alongside
existing style fields. Lower thirds use a bottom-left bar layout and left alignment; labels use a
smaller box. All three still use the existing native card shape: distinct bar/pill corner shapes
remain for renderer work. `motion` stores fade/rise/cut/instant and maps to existing text animation
(fade/rise/none/none). Safe-margin boxes use the shared anchor vocabulary. Text has a 1.5-second
minimum for the complete overlay, independent of how many renderer fragments it crosses.

| Text size | Card text / frame height | Card `fontSizeRel` | Label `fontSizeRel` | Lower-third `fontSizeRel` |
| --------- | -----------------------: | -----------------: | ------------------: | ------------------------: |
| XS        |                       3% |              0.030 |               0.020 |                     0.045 |
| S         |                     4.5% |              0.045 |               0.030 |                     0.060 |
| M         |                       6% |              0.060 |               0.045 |                     0.080 |
| L         |                       8% |              0.080 |               0.060 |                     0.110 |
| XL        |                      11% |              0.110 |               0.080 |                     0.150 |

The table gives native `fontSizeRel` when the screen rectangle fills frame height, as it does
at edited 13 s in the reviewer project. Labels use one smaller step; lower thirds use one larger
step, extending the scale to 2% and 15% at the endpoints. Box height is 2.2 times text height.
Native text units are relative to the screen rectangle. Placement divides the table value by
the starting clip's `screenRect.height` and scales the box to preserve the requested output-frame
height. For example, an M card on a half-height screen emits `fontSizeRel:0.12`.
A span crossing clips with different screen heights returns a note: the single stored annotation
retains its starting screen-relative size. Later layout changes can also change its frame fraction.
If the card cannot fit the screen rectangle, placement returns `TEXT_LAYOUT_UNAVAILABLE` with
a smaller-size/taller-layout suggestion. Existing text is unchanged. Rendered typography and long-text wrapping still need visual review.

Video B-roll accepts S/M/L/XL for contain placement, and cover uses null placement. These mean
20/26/34/44 percent frame height in a 16:9 box; contain preserves the asset's aspect inside that
box. `--offset` selects the asset source second. Existing imported paths are reused. A video fade
uses 0.3 seconds of 60 Hz opacity intervals in the scene; the native decoder remains shared by
asset path. This needs no new Rust fields. A PNG becomes a persistent silent H.264 derivative under
user data `agent-media`, using the macOS VideoToolbox encoder. Its original PNG is retained.
The derivative is keyed by path, mtime, file size, and rounded duration and reused where possible.
PNG alpha is flattened by the video conversion. The imported asset references the derivative.
B-roll's plan returns overlay IDs in `summary.results` and first/middle paths in `thumbnails`.

| Speech vocabulary    | Existing field mapping                               |
| -------------------- | ---------------------------------------------------- |
| zoom quick           | `motionStyle:snappy`, `motionSpeed:1.5`              |
| zoom normal          | `motionStyle:smooth`, `motionSpeed:1`                |
| zoom slow            | `motionStyle:smooth`, `motionSpeed:0.5`              |
| zoom S/M/L/XL        | `customScale:1.25/1.5/2/2.5`                         |
| camera S/M/L/XL      | `cameraScale:1.15/1.35/1.65/2`                       |
| camera full/emphasis | `mode:fullscreen/emphasis`, smooth motion at speed 1 |

Zoom and camera accept `--at`, `--from/--to`, or `--words`. `--at` starts a 0.8-second span.
An explicit shorter `--to` is extended and reported. Edges within 0.6 seconds of a cut snap to
that cut; minimum duration is restored after snapping. Each kept zoom/camera piece must fit at
least 0.8 seconds. Impossible short fragments fail explicitly. Text and B-roll stay independent
of clip lengths. Camera size has its existing emphasis-growth meaning; it does not crop a full
camera view. These wrappers do not add clip preset or screen-framing overrides.

New rules: `text.over-camera` (error, scene camera base box), `text.over-broll` (warning only when B-roll draws above text),
`broll.over-caption` (warning only for higher B-roll or disabled captions), and `overlay.orphaned` (warning, missing
words, beyond-edit span, or no kept legacy footage). Orphan fixes use exact `removeAnnotation`
or `removeVideoOverlay` operations. Overlap geometry follows scene screen/camera rectangles and
clip caption overrides. Animated camera enlargement remains outside the base-geometry check.

`assets`, `frame`, and `frames` read the canonical saved project by ID; they do not include unsaved
editor changes. Missing assets return explicit per-asset errors. Thumbnails are first/middle
320-pixel JPEGs, cached under user data `cache/agent-media` by absolute path, mtime, and size.
Audio-only assets use waveform pictures and have no source video dimensions. Incomplete caches
regenerate. Frame outputs use hash-bound `preview` machinery. Its internal clock is speed-adjusted
export time, so edited frame requests convert through raw/source position and export frame counts.
`frames` accepts 1–24 times and returns individual PNGs plus an FFmpeg-tiled JPEG contact sheet.
`--out` is an absolute PNG filename for `frame`, or a directory for `frames`; existing frame files
are not overwritten. Without `--out`, outputs use the user-data cache. Every frame reports
`elapsedMs`, edited `at`, and `exportTimeSec`. The current machinery launches an offscreen render
per frame; warm subsecond performance is not implemented. Task A.2 confirmed the blocking contract:
`agentPreview.ts` invokes one `export --agent-preview-time` process, ignores stdin, and waits for
process close. `cliMain.ts` calls `app.exit` 50 ms after completion. A 60-second snapshot-keyed
session needs a persistent request/reply route and lifecycle changes in Electron. Retaining the
launch handle cannot keep this process available for a second frame.

The reviewer measured approximately 6 s per frame. Task A.2 did not repeat cold/warm rendering:
the saved-project harness does not launch Electron, and this task explicitly forbids doing so.
No warm timing or subsecond success is claimed. A.2 evidence is in `artifacts/check-a2/` (kept locally, not in git).

Implementation contracts: existing timeline, scene, native text elapsed-time and path-keyed overlay
decoder contracts; installed Zod 4.4.3 with its [schema API](https://zod.dev/api); and FFmpeg 8.1.2
[scale, tile, and showwavespic filters](https://ffmpeg.org/ffmpeg-filters.html). No Rust changes.

## Reversible writes and verification (Task D, September 18)

```sh
klippt agent history --project_id ID --json
klippt agent undo --project_id ID --steps 2 --request_id undo-001 --json
klippt agent undo --project_id ID --to APPLY_ID --json
klippt agent redo --project_id ID --steps 2 --request_id redo-001 --json
klippt agent clip replace --project_id ID --clip CLIP_ID --file /absolute/new.mp4 --json
```

Every successful agent `apply`, including placement and replacement commands, saves a history
entry beside the managed project in `<project>.klippt.history/index.json`. Entries include
`applyId` (the receipt's `operationId`), `requestId`, ISO `at`, `planSummary`, before/after
revisions, and relative `snapshotPath`. Full before and after documents are gzip snapshots;
original media files stay in place. The last 50 writes, including undo/redo, are retained.
Older snapshots are pruned. A durable pending journal is reconciled against the project receipt
on the next write or history/restore request. A failed history preparation prevents the project
write. The existing single-level editor `undoRecovery` remains in the project unchanged.

`history` lists newest first. `undo` defaults to one active edit. `--steps N` restores the oldest
selected before-document in one guarded apply; `--to APPLY_ID` includes that active entry and
all active edits after it. `redo` restores the selected after-documents in their original order.
Both commands use the same renderer apply route, so the running editor receives the document
and a normal Undo step. Their audit summaries are `undo <applyId...>` and `redo <applyId...>`.
They survive editor restarts. A new agent edit clears the redo branch.

`--to` also accepts retained entries outside the active undo branch, including undo/redo audit
entries. This restores the chosen before-document and starts a new restore branch; `redo` then
restores the exact document from before this checkpoint restore. Earlier snapshots remain accessible with `--to` while retained.
If the live revision or saved-file hash differs from the last history write, restore refuses with
`HISTORY_CONFLICT`. Multi-step restores also refuse to cross intervening non-agent edits.
Explicit `--force` permits that replacement, but the normal project write guard still rejects
changes made after restore preparation. Restore deliberately permits old check findings: undo
must remain available to recover an edit. Save the current editor work before requesting restore.
Use distinct `--request_id` values; repeat only the identical request. If a write times out,
query `receipt` with that ID before issuing another write.

Generic `plan` now uses the same candidate check gate as placement commands. It stores checks
for the union of touched edited spans: trim edges plus three seconds, overlay/region spans,
clip layouts over their clip, and global settings over the project. Both old and new positions
contribute when an operation moves or removes content. File existence, structure, and transcript
checks run while planning; the candidate file checks run again before apply. Audio evidence is
still unavailable in candidate checks. Error-level findings block apply with `CHECK_ERRORS`;
the reply includes findings and their fixes (null when the rule supplies no automatic fix).
Warnings and info never block. `--force` bypasses this check gate, not transaction guards.
`layout set` also accepts `--force` and prints its planned envelope before applying.

Successful writes return `data.verify`:

```json
{
	"range": { "startSec": 100, "endSec": 110 },
	"state": { "projectId": "ID", "durationSec": 420, "state": {}, "spans": [] },
	"checks": {
		"status": "analyzing",
		"before": { "error": 0, "warning": 1, "info": 0, "byRule": {} },
		"after": { "error": 0, "warning": 0, "info": 0, "byRule": {} },
		"new": [],
		"resolved": [],
		"deltasComplete": false,
		"audio": { "ready": 0, "pending": 1 }
	},
	"next_actions": [
		"check --range 1:40.0 1:50.0; poll until ready and read all pages"
	]
}
```

State uses the same range resolver as `state`, over the committed document; `stateSource` and
`revision` identify that evidence. Runtime Clean Voice routes are not loaded into this saved-state
readback. Checks reuse the editor's existing paged background audio analysis. While either check
is incomplete or paged, deltas use complete structural/transcript checks and explicitly exclude
unavailable audio/file comparisons in `deltaScope`. Poll normal `check --range` until `ready` and
read its pages. `next_actions` are plain strings, de-duplicated before a six-entry cap. New error findings come first, then warnings and info, ordered by edited time within each severity; polling/export suggestions follow if space remains. Verify is evidence of document consistency;
it is not a rendered-frame or export claim. `apply --deep` adds the phase-6 decoded content
pass over the touched span to this block (`cut.clipped-word`, `frame.black`,
`frame.identical`); a span that cannot be decoded contributes an error-level
`content.unavailable` finding, so an incomplete verification never reads as a pass. If verification fails after a save, the reply retains
the committed receipt and reports the verification error. Never retry that write as a new edit.

Complete envelopes stay below 48 KiB. If necessary, arrays retain the first 20 items, with their
original counts in `truncation.counts`; exceptionally large items reduce that limit further.
`truncated:true` and `truncation.firstItems` make omissions explicit. Check severity counts and
receipts remain available. Use `state`/`check` to retrieve omitted detail. Placement commands keep
the verify block even when their follow-up state read fails.

`clip replace` approves/imports the new absolute file path, probes its duration, and prepares
one `replaceClipSource` operation (`args:{clipId,assetId}`). Generic plans can use an already
imported asset ID. The clip keeps its ID, crop, and layout. Its previous source in/out points
remain when they fit; the end is capped at the new duration. A source start beyond the new
file resets to zero and is reported; an unprobed empty range uses the known new duration.
Later clips are resequenced. Whole trims that fit survive; incompatible trims are dropped and
listed with IDs and ranges. Shared legacy trims on sibling clips remain intact.

Surviving source-anchored regions retain their content and update raw timing; shortened or lost
regions are reported. Edited-time text and B-roll keep their anchors. Word overlays re-find a
unique phrase in the new asset's existing transcript and update their source coordinates.
Replacement does not invent or copy a transcript. Missing or ambiguous words remain in the
project and produce `overlay.orphaned`; fully lost legacy overlays also remain for that check.
Original assets and files are preserved. Apply, history, and verify cover replacement as one edit.

Implementation contracts: repository transaction/scene/timeline contracts, pinned Node 22.22.1
[filesystem synchronization and rename](https://nodejs.org/docs/latest-v22.x/api/fs.html),
[gzip and bounded decompression](https://nodejs.org/download/release/v22.22.1/docs/api/zlib.html).
No Rust, Electron launch/control, build, or real-project write ran for Task D.

## Global settings, presets, automatic edits, and all transcripts (Task E, September 18)

```sh
klippt agent settings --project_id ID --json
klippt agent settings set --project_id ID motionBlurAmount=0.3
klippt agent settings set --project_id ID cameraAnchor=bottom-right cameraSize=M cursor.size=2
klippt agent settings set --project_id ID captions.enabled=true captions.fontSize=52
klippt agent settings set --project_id ID audioDeliveryPreset=custom audioTargetLufs=-16
klippt agent preset save night --project_id ID
klippt agent preset list
klippt agent preset apply night --project_id ID
klippt agent preset delete night
klippt agent auto run --project_id ID
klippt agent auto regenerate --project_id ID --settings '{"policy":{"maximumScreenScale":2.5}}'
klippt agent auto remove --project_id ID
klippt agent transcript --project_id ID --all --json
klippt agent transcript --project_id ID --all --page 2 --snapshot HASH --json
klippt agent transcript --project_id ID --clip CLIP --json
```

`settings` reads the open editor and prints groups by default; `--json` returns `data.groups`.
Each row has `key`, `current`, `default`, `allowed` (JSON Schema), `unit`, and `meaning`.
Cursor and caption objects include the same metadata for each child in `fields`.
The installed schema is `agentEditorSettingsSchema`; `agentLayoutSettingsSchema` is its alias.
`operations --type set-layout` exposes the full write schema. Unknown settings, duplicate
assignments, conflicting camera aliases, and out-of-range values fail before apply.
Booleans and numbers are parsed as JSON; unquoted names remain strings. Use quoted JSON for
object values. Cursor and caption children accept dotted keys. Caption word limits are also
checked against the current project's untouched limit.

| Group    | Keys                                                                   | Allowed values and units                                                                          |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Frame    | `wallpaper`                                                            | Bundled path, hex color, linear/radial gradient, or PNG/JPEG data URL within the 1 MiB plan limit |
| Frame    | `aspectRatio`, `outputResolution`                                      | Positive explicit W:H; null or even pixel dimensions 256–7680                                     |
| Frame    | `shadowIntensity`, `motionBlurAmount`, `showBlur`                      | 0–1 fractions; boolean for background blur                                                        |
| Frame    | `borderRadius`, `padding`, `safeMarginPercent`                         | 0–64 px; 0–100%; 0–50%                                                                            |
| Frame    | `cropRegion`                                                           | Normalized x/y/width/height; positive size fitting inside the source                              |
| Frame    | `screenFraming`, `screenFramingByVariant`                              | Scale 1–4 and normalized focal point; at most 32 named variants                                   |
| Camera   | `cameraAnchor`, `cameraSize`                                           | Nine vocabulary anchors or normalized center; XS/S/M/L/XL or 10–80%                               |
| Camera   | `webcamLayoutPreset`                                                   | picture-in-picture, vertical-stack, dual-frame, no-webcam                                         |
| Camera   | `webcamBlockOrder`, `webcamBlockCameraShare`                           | screen-first or camera-first; 20–80%                                                              |
| Camera   | `webcamMaskShape`, `webcamCornerRadius`                                | rectangle, circle, square, rounded, squircle; 0–50%                                               |
| Camera   | `webcamAspectRatio`                                                    | source, 1:1, 4:3, 16:9, 9:16                                                                      |
| Camera   | `webcamMirrored`, `webcamReactiveZoom`                                 | Booleans                                                                                          |
| Camera   | `webcamSizePreset`, `webcamZoom`                                       | 10–80%; 1–3×                                                                                      |
| Camera   | `webcamPosition`, `webcamFocalPoint`                                   | Normalized cx/cy; position also accepts null                                                      |
| Cursor   | `cursor.size`, `cursor.smoothing`, `cursor.motionBlur`                 | 0.5–10×; 0–1; 0–1                                                                                 |
| Cursor   | `cursor.clickBounce`, `cursor.clipToBounds`                            | 0–5 (UI displays ×20%); boolean                                                                   |
| Cursor   | `cursorShow`, `cursorTheme`, `autoFocusAll`                            | Booleans; installed theme ID (currently default)                                                  |
| Audio    | `microphoneVolume`, `systemAudioVolume`                                | 0–1 gain                                                                                          |
| Audio    | `microphoneMuted`, `systemAudioMuted`, `evenVolume`, `normalizeVolume` | Booleans                                                                                          |
| Audio    | `audioDeliveryPreset`, `audioTargetLufs`, `audioPeakCeilingDbtp`       | youtube/custom; −30 to −9 LUFS; −6 to −1 dBTP                                                     |
| Captions | `captions.enabled`, `captions.language`                                | Boolean; language code or null                                                                    |
| Captions | `captions.fontFamily`, `captions.fontSize`, `captions.fontWeight`      | Font name; 12–200 px at 1080-high output; normal/bold                                             |
| Captions | `captions.color`, `captions.backgroundColor`                           | Three- or six-digit hex color                                                                     |
| Captions | `captions.backgroundEnabled`, `captions.backgroundOpacity`             | Boolean; 0–1                                                                                      |
| Captions | `captions.verticalPosition`, `captions.textAlign`                      | top/middle/bottom; left/center/right                                                              |
| Captions | `captions.offsetY`, `captions.width`                                   | −45 to 45% frame height; 20–100% frame width                                                      |
| Captions | `captions.minWordsPerLine`, `captions.maxWordsPerLine`                 | Integers 1–12, minimum ≤ maximum                                                                  |

The YouTube delivery preset fixes output targets at −14.5 LUFS and −2 dBTP. Select `custom`
when changing those targets. Optional inherited settings are reported as null when absent.
`cameraSize` and `screenFraming` are write aliases with resolved numeric current/default values.
The runtime rows and validation share one schema; the table is a compact reference.

`settings set`, `preset apply`, and all `auto` actions prepare and apply an ordinary guarded
plan. They return the existing `data.verify`, receipt, and operation request ID and enter durable
history. `undo` and `redo` work normally. All three accept `--request_id` and `--force` with the
existing meanings. A lost apply reply reports `recovery_required`; recover the receipt before
retrying. An error check still blocks apply unless explicitly forced.

Agent presets live in `<app userData>/agent-presets.json`, version 1, with at most 20 entries.
Names are case-insensitive and cannot overwrite an existing preset; delete it explicitly first.
Writes serialize in the app owner and replace the file atomically. Invalid storage fails visibly.
The schema extends the UI visual preset schema with camera layout, aspect ratio, screen framing,
motion/background blur, and automatic-direction policy. It retains the UI frame and caption look.
It excludes source crop, output pixel dimensions, audio, cursor settings, media, caption language
and visibility, clip overrides, and timeline regions. Saving a reusable preset with an uploaded
image background is rejected by the existing UI preset schema.

`preset list` includes built-in and saved UI presets through the editor broker, marked
`source: ui`; agent presets use `source: agent`. If no editor answers, the agent list still works
and `ui_library` explains the gap. Apply selects the agent preset first on a name collision;
`--source ui|agent` selects explicitly. The UI library remains read-only through these commands.
Preset save/delete change the user library, not a project, and do not enter project undo history.
Applying automatic-direction settings from a preset does not regenerate regions implicitly.

Plan operations `autoDirectionRun {settings?}`, `autoDirectionRemove`, and
`autoDirectionRegenerate {settings?}` wrap the editor's pure direction functions. Settings use
`{policy: <nested overrides>, presetId?: string|null}`; omitted fields retain the saved policy.
`setAutomaticDirectionSettings {settings}` changes policy without generating regions.
Run/regenerate use the editor's cached cursor, typing, and microphone observations, with two
analysis workers. The CLI polls pending analysis for up to 120 seconds. If analysis is still
pending, repeat the command; no plan was applied. Read errors, absent activity, or existing
automatic regions whose assets lack activity fail before removal. Manually authored regions and
generated groups promoted to manual ownership survive removal/regeneration. Dismissed effects
remain excluded. `data.operations` and `data.verify.automatic_direction` report added/removed
region counts by zoom, camera emphasis, and camera fullscreen.

`transcript --all` reads the saved project without an editor connection. Every clip appears with
its ID, display name, status, source-time words, and sentences. Sentences use punctuation or a
0.8-second word gap, with stored speech segments as fallback where word timing is absent.
It does not transcribe or alter media. Each page carries `missing` clips, a global
`missing_count`, and the exact `transcribe --project_id ID` command. Save after transcription
before reading the saved words.

Pages have a 42 KiB data budget, leaving room for the envelope below 48 KiB. Follow `next_page`
and reuse the returned snapshot hash. A long clip can span pages; concatenate its `words` and
`sentences` in page order using their offsets. Very long text items use one-based `part`/`parts`
without dropping text. Display names over 512 characters carry `name_truncated: true`. Unsupported
oversized identity metadata fails explicitly. The existing one-clip `--offset`/`--limit` read
remains available. Both read forms accept either `--project PATH` or `--project_id ID`.

Implementation contracts checked: installed Zod 4 source and [strict object/schema APIs](https://zod.dev/api),
[Electron userData path](https://www.electronjs.org/docs/latest/api/app#appgetpathname), the pinned
editor settings controls, `visualPresets.ts`, `regenerateAutomaticDirection.ts`, and
`automatic-direction-ownership.ts`. The editor's shared pure functions remain the behavior source.
Real-project execution, Electron restart, and visual verification remain with the reviewer.

## Proposed cuts review lane (Task F, September 18)

```sh
klippt agent plan --project_id ID --input cuts.json --stage --json
klippt agent staged --project_id ID --json
klippt agent staged --project_id ID --offset 25 --json
klippt agent accept --project_id ID --json
klippt agent accept --project_id ID --ids CUT_ID,CUT_ID --json
klippt agent reject --project_id ID --ids CUT_ID,CUT_ID --json
```

`plan --stage` accepts only `addTrim` and `setTrim`. A mixed plan fails with
`INVALID_INPUT` before staging or writing anything. Staging relays to the open editor,
without activating project transactions, generating a candidate file, or saving the
project. It returns `staged` IDs, `lane_count`, and `rejected_earlier`. Repeating a plan
keeps existing pills and their adjusted edges. Only one pending replacement of a given
trim can occupy the lane. A staged `setTrim` previews and accepts the replacement;
it does not add another cut beside the existing trim. If the original trim changes
before acceptance, that stale replacement is ignored.

`staged` returns 25 cuts per page with stable IDs, kind, origin, selected state, source
start/end and edited start/end. Follow `next_offset` with `--offset`; `lane_count` is
the entire lane. Times use the timeline's trim-adjusted edited clock. Listing and
rejection never save a document. Discovery and command completion use the installed
command registry, including these three commands.

All proposals appear in one temporary **Proposed cuts** lane over the waveform. Drag
an edge or focus its handle and use the arrow keys (40 ms). Edges stay inside the clip,
keep at least 40 ms, and cannot cross another staged cut. Click the body to select it;
press Delete/Backspace or click × to reject it. The Audio pane's Pacing section shows
the kind totals and origin labels, **Accept all (N)**, and **Clear**.

Without IDs, `accept` applies selected cuts and clears the lane. With IDs, it accepts
those exact cuts, even if deselected, and leaves the others staged. Both GUI and CLI
acceptance use `applyPauseSuggestions` through one document patch: one GUI Undo step
and one durable entry in `agent history`. The receipt uses the CLI response's request
ID. If a reply is lost, recover with `receipt --project_id ID --request_id RESPONSE_ID`
before another write. Accepted-ID replay is not a restaging mechanism. Save failures
retain proposals. Acceptance requires a saved, synchronized project for history.

Rejections persist locally under `klippt:proposed-cuts:rejected:<projectId>`, keyed by
clip and millisecond-rounded source bounds. A later proposal with at least half its
own duration overlapping a rejected range is silently omitted; the pane reports
“3 rejected earlier”. **Clear** forgets the current lane without recording rejections.
The lane itself is temporary and clears when switching projects or restarting.
Pause analysis still invalidates its own candidates when the document changes;
valid agent/fix proposals remain and update their timeline placement.

`addTrim` operations may carry `reason: "Shortened pause"` or
`reason: "check cut.loose-tail"` for pause/fix labels. Other CLI trims carry kind `agent`
and origin `agent plan <planId>`; trims applied with `--accept "<reason>"` record that reason
on the operation. Existing pause analysis supplies pause/blip kinds.
Pause-pass operations and trim fixes can be copied into a trims-only JSON plan and
staged with the same flag. Overlay, zoom, camera, layout and ordinary direct `apply`
behavior stays unchanged — those commands still plan and apply directly. Since the
foundation waves, `pauses`, `edges`, and `cutpoint` stage by default; explicit
`plan --stage` remains for trims-only files.

## Observation, batch runs, and content verification (Foundation phases 4–6, September 18)

```sh
klippt agent shot --project_id ID --at 3:50 --json
klippt agent shot --project_id ID --words "exact transcript phrase" --live --json
klippt agent batch --input steps.json --stop-on error --verbosity summary --json
klippt agent undo --project_id ID --to BATCH_ID --json
klippt agent verify --project_id ID --range 1:40 1:50 --out /absolute/verify-out --json
```

`shot` answers "what is on screen at this instant" in one reply. `--at` (any suffix form) or
`--words` (must match exactly one stored transcript phrase) resolves the instant on all three
time bases through the phase-3 resolver. The reply carries the project ID, revision, dirty
flag, visible layers with sizes and anchors, the transcript ±5 s (source seconds, from the
saved document), the nearest cuts, staged proposals within ±5 s, and one image: the saved
render by default, or with `--live` a transport seek plus a live canvas frame grab.
`image.source` (`saved_render`/`live_preview`) and the `evidence` map say which; a saved
render excludes unsaved editor changes, and a dirty flag is reported beside it.

`batch --input steps.json [--stop-on error|warning] [--verbosity summary|full]` runs a JSON
array of agent command argument arrays (or `{label, args}` objects) in order against the live
editor, at most 100 steps and 1 MiB of input. Every step is parsed and validated before any
write runs, so a composition error fails the whole input instead of stranding a half-executed
batch. Nested `batch` steps are rejected. Steps without their own `--request_id` get
`<batchId>:<index>` for commands whose contract permits document commits and request IDs,
including `pauses --accept`, `cutpoint --accept`, and `accept`. `accept --request_id ID`
also supports explicit receipt recovery. Batch step summaries use the operation or receipt
ID rather than an unrelated envelope ID. This joins commits into one history group: `undo --to BATCH_ID` reverts
the whole batch in one step. One summary envelope lands on stdout with
per-step status, exit codes, introduced findings, before/after document hashes, and the first
failure's full reply; step progress/`planned` envelopes pass through to stderr as NDJSON,
matching the phase-2 output contract. Frames at every touched edited instant are rendered
from the final saved document into `klippt-batch-<id>-frames` (at most 24 instants); an
unavailable renderer never fails committed edits. The batch exit code is the failing step's
contract exit code.

`verify --project_id ID --range a b [--out DIR]` is read-only: it decodes the real media with
ffmpeg at every cut edge (both sides) and every visible video-overlay edge inside the
edited-time range, at most 100 edges per run (narrow `--range` to cover the rest). Findings:
`cut.clipped-word` (error — the level 0–120 ms after an out point stays within 15 dB of the
word tail), `frame.black` and `frame.identical` (warnings, from sampled frames), and
`content.unavailable` (error — the required audio track could not be decoded, so nothing was
verified at that edge and the range must not read as a pass). The summary reports per-edge
tail/post levels in dBFS, and frames plus a filmstrip with waveforms land in `--out` or the
agent cache. RMS is supporting evidence, not proof: listen or read the filmstrip before
re-cutting. These findings never join the plan/apply check gate.

## Foundation proof and readiness contracts

The registry requires explicit effects, dependency capabilities and verification
requirements for every command. `guide --command NAME` and `contracts` expose them;
the summary guide stays small. Existing input defaults and schemas are checked against
an immutable API 1 baseline, separately from the editable discovery snapshot.

`doctor --command NAME [--live]` performs passive capability discovery. It reports
available/unavailable/unknown, session identities, build IDs, and next actions. It
uses no cross-invocation cache. Saved reads need no editor. The renderer must report
fresh-frame support and have painted generation evidence before live-frame readiness
is available. A legacy or unrecognized native component stays unknown; doctor does
not infer decoding, export, or compositor compatibility from a filename or version.

Editing envelopes now expose commit and verification states separately. Pending
visual/audio review cannot undo an acknowledged commit or erase its receipt. Structural
check failures and unavailable deep decoding remain explicit. Low-level writes use
conservative combined evidence requirements because they can change visuals and speech.
No command completion claims a person or agent inspected an image or listened.

`--compact` is an additive output option. Complete replies are saved in the caller's
`klippt-agent-artifacts` directory; stdout retains recovery and proof metadata with the
full artifact path. An artifact-write failure returns the full reply, preserving the
receipt. Default full output and batch summary remain compatible.

Live frame proof binds the requested source position, native view, scene identity and
painted transport generation. A changed scene must be submitted before its new anchor.
The old settled frame cannot acknowledge a new seek while React effects are pending.
The native implementation applies scene changes before composing under the new anchor;
this ordering was checked in `crates/compositor/src/live.rs`.

Boundary comparison tooling lives in `scripts/agent-eval/boundary-proof.mjs`. It reads
captured evidence only. It writes labeled before/after contact sheets and grades actual
pixels against supplied reference frames, timestamps, clock, revision/hash, cadence and
live freshness. Sparse sampling and saved/export evidence cannot pass live coverage.
The caller still must inspect the sheet; creation leaves visual review pending.

Live transport frame samples expose `nativeFrame` when the renderer supports it.
Live `shot` retains the same value under `image.captured.native_frame`. It identifies
the last painted native packet by view, clip, transport generation and source-clock
compositor time. This is not the HTML video time or the decoded source frame PTS.
An absent or null native frame does not establish timestamp evidence.

Receipt hash scopes are advertised by `output_contract.receipt_hash_scopes`.
`contentHashes.sha256_before` covers the exact previous saved file bytes, including
transaction metadata. `sha256_after` covers `JSON.stringify(document)` with
`_klipptTransactions` removed. It is a resulting-content hash, not a saved-file hash.
Imported-media hashes cover media file bytes. An exact resulting-file hash must be
recorded outside the file; embedding it in the receipt would be self-referential.
Undo restores document content while retaining new transaction and recovery metadata.
