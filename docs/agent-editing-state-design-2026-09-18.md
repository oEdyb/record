# Agent-first editing: state, checks and vocabulary (design note, 2026-09-18)

Olle's brief, in his words: the agent must know the ground state of the whole edit and
of each clip, set baselines globally and override them per clip, place things with
standard positions instead of pixels, see one frame of any B-roll, add text over a span,
and know from the CLI alone, without looking at the screen, whether the edit is
consistent. Final goal: the best edit in the least time, driven by a skill.

## What we have today (checked against the CLI on 2026-09-18)

- Read: `inspect`, `live`, `guide`, `transcript`, `pauses`, `edges`, `cutpoint`,
  `preview --out` (compositor frame), `transport` (drive the editor, sample the clock,
  grab a 192 px preview frame).
- Write: `plan` then `apply` with typed operations (trims, camera regions, zoom, text
  cards through the offscreen renderer, B-roll on the video-overlay lane).
- Model: project-wide layout in `legacyEditor` (`webcamSizePreset`, `webcamPosition`
  as cx/cy, preset, shape); no per-clip layout; regions are anchored to a clip and a
  source span. Positions are numbers, not names.
- Found today with a one-off script: 7 emphasis regions sat entirely inside full-camera
  regions (invisible, but they fought at the edges). Nothing in the CLI would have said so.

## What the field does (sources)

- Agent-first tool APIs (arXiv 2605.10555): every write goes preview → execute → verify
  → recover; responses carry confidence, evidence, typed result references and suggested
  next actions, so the agent never has to look at a UI to know it worked.
- video-agent-runtime: "the runtime owns state; models propose structured changes";
  proposals are schema-checked, applied atomically, versioned; invariants (overlaps) are
  validated before persisting.
- proofcut: verify the finished file by transcribing it and diffing it word by word against
  the timeline. Cheap and brutal for cut mistakes.
- Remotion agent skills: the skill is a markdown file that fires first and forces the agent
  onto a shared kit (motion presets, layout kit) instead of hand-rolling values.

## Proposal

### 1. One effective-state view, resolved by the same code that renders

`state --at 1:43` and `state --range 1:40 2:05` answer: which clip and source time, the
effective layout (camera anchor, size, shape; screen framing), every region and overlay
active there with its remaining time, captions, audio route, and where the next cut is.
Values come from `sceneDescription` (what preview and export actually draw), never from
the raw document. Output is compact JSON lines with names, not ids first.

### 2. Three layers: project defaults, clip overrides, time-boxed regions

- Project defaults: what exists today in `legacyEditor`.
- Clip overrides (new, `clipLayouts[clipId]`): camera anchor, camera size, camera shape,
  screen framing, captions on/off. Missing keys inherit.
- Regions stay as they are (camera full/emphasis, zoom, text, B-roll, speed).
- `layout set --scope project|clip:ID --camera-anchor bottom-right --camera-size M`.
- `state` prints, for each value, which layer it came from.

### 3. A shared vocabulary instead of pixels

- Anchors: `top-left top top-right left center right bottom-left bottom bottom-right`
  for camera, text and B-roll. Insets are a project default (safe margin).
- Sizes: `XS S M L XL` as fractions of frame height for the camera and for text; B-roll
  `fit: cover|contain` plus an anchor.
- Motion: named presets per element type (`cut`, `fade`, `rise`, `smooth`, `instant`).
  Every added element gets the type's default motion unless told otherwise.
- Absolute numbers remain accepted; the names are the default and what `state` prints.

### 4. `check`: the edit linter

Rules, each with an id, severity, the span and the fix as a ready-made operation:

| id | finds | severity |
|---|---|---|
| camera.nested | emphasis inside a full-camera region | error |
| camera.overlap | two camera regions overlapping on the edit | error |
| region.near-cut | a region edge within 0.6 s of a cut (now auto-snapped; report anyway) | info |
| text.over-camera | text box intersecting the camera rect | error |
| text.over-broll | text over B-roll or a card without a safe area | warning |
| broll.over-caption | B-roll hiding the caption line | warning |
| cut.mid-sentence | a cut whose audio side is inside a sentence (`cutpoint` says so) | error |
| gap.silence | dead air longer than 1 s left in the edit | warning |
| camera.long-full | full camera longer than N s while the transcript talks about the screen | info |
| asset.missing | overlay or B-roll file not found | error |
| region.off-cut | region entirely inside removed footage | info |

`check` runs after every `apply` on the affected span and prints deltas; `check --all`
runs the whole edit. The agent's loop ends when `check` is clean, not when a frame looks
right.

### 5. Verify on every write

`apply` returns the effective state of the affected span after the change, the checks
that changed, and `next_actions` (for a new text: "check text.over-camera at 1:43").
This is the preview → execute → verify shape from the agent-first API paper, and it is
mostly wiring on top of `state` and `check`.

### 6. Frames and B-roll thumbnails without ceremony

- `frame --at 1:43 [--out]`: one composited frame in under a second from the live
  compositor (the transport `frame` step does this already; promote it to a command).
- `frames --at 1:43,2:10,4:48`: a contact sheet.
- `assets`: every media file with a two-frame thumbnail (first, middle) generated once at
  import and cached; `broll add` returns the thumbnail path so the agent sees one frame.

### 7. Text and B-roll with anchors

- `text add --from 1:43 --to 1:48 --anchor top --size M --style card|lower-third|label`
  (the squircle card renderer becomes a style).
- `broll add --file X --from --to --fit cover --anchor center --motion fade`.
- Both run `check` on their span inside `plan`, so overlap is known before `apply`.

### 8. The skill

`klippt-edit` (in `~/dev/skills`): inspect → plan B-roll per claim (benchmarks, blog
screenshots, comparisons) → cuts (`edges`, gaps, `cutpoint`) → layout pass per clip →
emphasis and zoom → text and B-roll → `check --all` until clean → export a slice → frame
diffs at cuts → full export → transcript diff of the export against the timeline.

## Build order (recommendation)

1. `state` and `check` with the rules we can compute today (camera.nested, camera.overlap,
   region.near-cut, cut.mid-sentence, gap.silence, region.off-cut). One day.
2. Clip overrides and anchors, with `state` printing the layer. Two days, touches the
   layout math and the compositor scene.
3. `text add` and `broll add` with anchors, thumbnails, motion presets. Two days.
4. Verify blocks and `next_actions` on `apply`. Half a day.
5. The skill, written from the loop above once 1 to 3 exist.

## Not decided

- Camera size defaults: Olle finds the camera small at 0:13 and 0:55. The project preset
  is the only knob today; a per-clip override is item 2.
- Whether `check` rules of taste (camera.long-full) live in the tool or in the skill.

## Addendum (Olle, night of 2026-09-18): swaps, B-roll independence, undo

- B-roll and text never share a clip's length. They are placed on the edited timeline
  (edited seconds) or on transcript anchors (a word span), never on a clip's source span.
  When a clip is trimmed, replaced or re-recorded, overlays keep their edited-time position
  or follow their words; `check` reports overlays that now hang past the end of the edit or
  over a removed span (`overlay.orphaned`).
- Clip swap: `clip replace --clip ID --file NEW` swaps the source media and keeps trims that
  still fit, regions, B-roll and text; `clip rerecord` is the same with a fresh recording.
  Anything that no longer fits shows up in `check` with a fix, not as a silent drop.
- Everything the agent does is reversible: every `apply` stores the document before the
  change; `history` lists applies newest first; `undo [--steps N | --to APPLY_ID]` restores
  the snapshot and is itself an apply that can be undone (`redo`). Snapshots live next to
  the project and survive an editor restart.
- The CLI must be usable in one flow: `state`, `check`, `apply`, `undo`, `frame` all answer
  in seconds and without a screen. Missing commands get added; commands that do not earn
  their keep get removed.

## Addendum 2 (Olle, same night): settings, presets, automatic edits, transcripts

- `settings` shows every global parameter with its current value and range (motion blur,
  shadow, corners, padding, wallpaper, cursor, audio delivery, captions look, camera
  layout). `settings set key=value …` writes through the same plan/apply guard, so it is
  undoable. Names come from the vocabulary where one exists.
- `preset save NAME` / `preset apply NAME` / `preset list` reuse the editor's visual preset
  library (frame + captions) and extend it with the layout keys, stored per user, not per
  project.
- `auto run [--settings …]`, `auto remove`, `auto regenerate` wrap the automatic
  direction functions the editor already has (`applyAutomaticDirection`,
  `removeAutomaticDirection`, `regenerateAutomaticDirection`), as plan operations.
- `transcript --all` returns every clip's transcript with words; `transcribe` stays for
  missing ones.

## Addendum 3 (Olle, same night): the CLI must not be able to make things ugly

- `plan` runs `check` on the touched span. Error findings block `apply` unless `--force`
  is passed; warnings are printed with the fix. Safe margins, minimum durations (0.8 s for
  zoom and camera pieces, 1.5 s for text) and cut snapping apply automatically.
- Speech-shaped commands with names, anchored by time or words: `zoom add --at|--words
  --speed quick|normal|slow --size S..XL`, `camera set --at|--words full|emphasis --size`,
  `text add`, `broll add`. Taste stays with Olle; the tool guarantees legality.
