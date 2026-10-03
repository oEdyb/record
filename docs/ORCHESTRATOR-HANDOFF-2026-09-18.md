# Orchestrator handoff, 2026-09-18

Written by Claude (Fable 5.1) for the Codex session that takes over as orchestrator. Olle has
about 20 % of his weekly Claude budget left with four days to go, so from here Codex runs the
show: it plans, briefs workers, reviews diffs, drives the editor, and talks to Olle. This file
holds everything that was in my head: what Olle wants, what he said, what landed, what is
in flight, what is queued, the hard rules, and the lessons that cost a debugging loop each.

Read this file first, then `HANDOFF.md` (dated bullets at the top), then the
`development` skill (`/Users/olle/dev/skills/skills/development/SKILL.md`) and the
`klippt-edit` skill (`/Users/olle/dev/skills/skills/klippt-edit/SKILL.md`). Do not skip the
skills: Olle's rule is that every coding request follows the development skill (plain words
before and after, docs before code, evidence before done).

---

## 1. Who Olle is and how to work with him

- Olle (they/them in text, "he" is what he uses about himself) is a vibe coder. He reads
  Python, understands agent tooling, has not read this codebase. Every change gets explained
  in plain words before it is built and after, ≤ 8 bullets, 12 words per bullet, no headers.
- He talks in voice notes. Transcripts are messy ("kinda", "and so", "blah blah"). Read for
  intent, answer the intent, do not quote the mess back at him.
- He hates sycophancy more than anything. Before agreeing, state the strongest counter-case,
  then one recommendation. Judge his idea as if a stranger said it. Push on follow-through.
- He runs one YouTube channel about AI agents and this app, Klippt, is his product. Both matter
  this week: the Kimi swarm video must ship, and the editor must get better while editing it.
- He expects the tool to be right before he is asked to look. When he catches something the tool
  should have caught (a clipped word, a leftover silence) he asks "why did the tool leave this",
  and the correct answer is a general fix, not a one-off patch. "It can't be too hard-coded."
- He is happy to let a worker run for an hour unattended, but he wants an honest estimate. He
  said the proposed-cuts lane would take "more like 1 hour", not two days, and he was right.
- When he says he is tired or not enjoying it: stop generating options, finish the one thing.

## 2. The dream (what he is building toward)

Klippt is a Mac screen recorder and editor with an agent CLI so an agent can do the whole edit
from a spec while he records the next video. His stated end state, in his words spread over the
last two days:

1. **The CLI is the editor.** `state` tells the agent what is on screen, `check` what is wrong,
   `frames` proves it, `undo` takes it back. "Taste stays with Olle; the tool guarantees legality."
2. **Edits are proposals first.** Anything that removes footage shows on the timeline as a pill he
   can drag, delete, or accept all at once. He said this after the tool clipped "experiment":
   "it should show a visual on the timeline where it intends to cut and we can move the ends
   further or shorter or remove it and so and then accept all once we happy."
3. **Detection generalizes.** Silence and pause removal must work across projects, "a list of
   harsher and harsher filters": dead air → wordless blips (coughs, clicks) → fillers next.
   Coughs and blips with no transcription must not block a pause.
4. **Never clip a word.** "0:28.2 is not a correct removal, it cuts me off mid word." Measure
   audio before tightening any cut. This is now a rule in both skills.
5. **Media swaps are one command.** "I want the CLI to easily be able to switch out stuff for
   different media and the media will automatically be cropped or cut in a way that fits it,
   size wise and time length wise." (Task G, queued, see §7.)
6. **Visuals follow a shot map.** He wants every bare stretch of desktop replaced by B-roll,
   full camera, real screen evidence, or one line of text, chosen per beat. He starts every edit
   with a B-roll and visual research pass and will replace camera footage later, so camera clips
   must stay easy to swap.
7. **B-roll capture stays simple.** He asked today whether B-roll should be recorded OBS-style
   during the main recording. My answer (§9) is no: capture separately, import, let the swap
   command fit it.

## 3. Hard rules (do not break these)

- **Nothing committed unless Olle asks.** No `git commit`, `stash`, `checkout`, `reset`. The
  worktree has ~400 modified files across many days; that is expected.
- **Never quit Klippt while `screencapturekit-helper` records.** Check `pgrep -fl
  screencapturekit-helper` before any restart. Kill only the dev editor, never an
  `Electron . export` process.
- **Restart the dev editor only with** `python3 artifacts/preview-broll-2026-09-18/restart.py`
  after `npx vite build`. It refuses while a capture helper runs and reopens the Kimi project.
- **Never write the Kimi project file directly.** Only guarded `plan`/`apply` through the CLI.
  Workers may only stage proposed cuts, never Accept, on the Kimi project. For live tests that
  must write, `clone` the project first.
- **Do not install over `/Applications/Klippt.app`** without the signed-build gate (Developer ID
  Application: Dyberg & Co AB) and `afterSign` guard. The installed app is an old build that
  cannot read schema 11; if Olle opens the Kimi project in it the edit looks empty. Back up the
  file, kill the old app, start the dev editor.
- **One Codex worker at a time** on this 24 GB Mac. Two concurrent vitest/cargo runs hit 12 GB
  of swap.
- **Builds need** `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.
- **Measure every tightened cut** with ffmpeg RMS before applying, and tell Olle which cuts were
  measured and which were not (§10 has the command).
- **Spec rules for the Kimi video:** never caption a claim footage contradicts; nothing from
  Yicheng's confidential answer; never write the disclosure sentence (placeholder stays until
  approved); keep developer counts off screen; do not edit canonical vault graphics.
- **Vault:** before writing in `/Users/olle/Documents/Notes`, read its `AGENTS.md` and
  `Agent/Vault Routing.md`; run `vault.py check` after. Eight unrelated routing errors exist.
- **Repo rules** in `AGENTS.md` (npm only, strict TypeScript, no `any`, no TestSprite, tests in
  the same package, full suite once before handoff).

## 4. How I ran workers (copy this)

The `codex:codex-rescue` plugin sandbox SIGABRTs Electron, so every task that must drive the
editor ran through the direct CLI under nohup with a done-file:

```
S=/private/tmp/claude-501/-Users-olle-dev-screenrec/c77427c3-0f68-4377-8407-c7c2ef8efcd6/scratchpad/codex
# run.sh NAME PROMPTFILE  (PROMPTFILE must be ABSOLUTE; a relative path fails with exit=1 and no log)
nohup zsh $S/run.sh taskX $S/taskX-prompt.md >/dev/null 2>&1 &
# poll: cat $S/taskX.done   → "exit=0"; report in $S/taskX.last.md; full log $S/taskX.log
```

`run.sh` is `codex exec --sandbox danger-full-access --color never -o NAME.last.md - < PROMPT`.
That scratchpad dies with my session. Copies of `run.sh`, `chain-G.sh`, the F, F2 and G
briefs, the 7 gameplay ops and the shot-map page live in `artifacts/orchestrator-handoff-2026-09-18/`.

Every brief had the same shape, and it worked: goal in Olle's words → "what exists" with
file:line pointers → required behavior numbered → boundaries → acceptance checks that are
runnable commands → report format (plain words, ≤ 8 bullets). Always include: load the
development skill, restart via restart.py, never Accept on Kimi, screenshot and LOOK at it.

After each worker: read `.last.md`, read the evidence README, spot-check the live claim
yourself (project hash unchanged, `staged` count, a screenshot), then tell Olle in plain words.
Do not trust "screenshots inspected" without opening one: Task F said that and the pills were
still invisible at default zoom, which is what Olle noticed ("why do I still see the old UI").

## 5. What landed (state of the code)

All uncommitted on branch `checkpoint/klippt-beta-hardening-2026-09-01`. Evidence folders
under `artifacts/*-2026-09-18/`. Test suite at last full run: 3,338 passed, 1 skipped.

### Agent CLI (the editor for agents)

Wrapper I used: `ag` = `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . agent "$@"
--json 2>&1 | grep '^{' | tail -1`. Flags are separate tokens (`--ignore_non_speech true`);
zsh does not word-split a variable holding several flags.

Commands (full contract: `ag contracts`, guide: `ag guide --command X`, docs:
`technical-documentation/agent-cli.md`): `state --at` (edited seconds), `check --all|--range`
(poll until `data.status ready` and `audio.pending 0`), `plan --input FILE` (top-level JSON
array of ops) → `apply --plan_id --request_id [--force]` → `receipt --request_id`, `history`,
`undo`, `redo`, `frames --at a,b,c --out DIR`, `frame`, `assets`, `media`, `inspect`,
`timeline`, `transcript --all`, `layout set --scope clip:ID`, `text add`, `broll add`,
`zoom add`, `camera set`, `clip replace`, `settings`, `preset`, `auto`, `pauses [--clips a,b]`,
`edges`, `cutpoint --edge out|in`, `transport --script` (RAW seconds), `preview`, `geometry`
(both want `--snapshot` sha256 of the .klippt), `clone`, and since Task F: `plan --stage`,
`staged`, `accept [--ids]`, `reject --ids`.

Plan op shapes: `addTrim {clipId,startSec,endSec}`, `setTrim {trimRangeId,startSec,endSec}`,
`removeTrim`, `setClipRange`, `moveClip`, `removeClip`, `splitClip`, `addVideoOverlay`,
`setVideoOverlay {videoOverlayId,...}`, `removeVideoOverlay`, `addAnnotation`, `setAnnotation`,
`removeAnnotation`, `addZoom`, `setZoom`, `addCameraFullscreen`, `setCameraFullscreen`,
`removeModifier {args:{id}}`, `setClipLayout {clipId, layout}`, `replaceClipSource`,
`addAudioClip`/`setAudioClip`/`removeAudioClip`, `set-layout`, auto-direction ops. Read
`contracts --json` before hand-writing a plan; shapes differ.

### Checks (14 rules, `src/lib/ai-edition/checks/`)

camera.nested, text.over-camera, text.over-broll, broll.over-caption, overlay.orphaned,
camera.overlap, region.near-cut, region.off-cut, caption.orphaned, gap.silence (> 1 s),
cut.mid-sentence, cut.loose-tail (new today: mic-level air ≥ 0.35 s next to a cut, warning,
setTrim fix), asset.missing, layout.unused-override. Rules that need audio declare
`audio: true` (the analyzer used to hard-code the list; that hid the new rule).

Delta gate: a plan reports only findings it introduces. `findingKey = [rule, clip, message,
fix]` (no edited span, otherwise every shifted finding looked new). Plan time loads cached mic
peaks for the touched span ±3 s (`audioEvidence` in `electron/cli/editorAgentBroker.ts`); apply
compares the candidate against the plan-time baseline.

### Cut planner (`src/lib/ai-edition/timeline/cut-point.ts`)

`planCutPoint` ignores quiet spans < 0.2 s (`MIN_GAP_SEC`, stop closures inside words are
40–120 ms). `cutInsideSentence` decides direction; `removedSideHasSpeech` needs the removed side
within 10 dB of the kept words (1.5 s windows). `removesOnlyWordlessSound` (≤ 1 s, no word) lets
a blip removal through cut.mid-sentence.

### Pause pass (`src/lib/ai-edition/timeline/pause-analysis.ts`)

A pause is "no words and no speech". Wordless blips (≤ 0.5 s, no transcript word, every
detector max < 0.8, no ±80 ms probability pad) join the pause. Blips ≥ 0.15 s inside a sentence
come back as `kind: "blip"` proposals (joined within 0.1 s, not overlapping a pause span, not in
`environment` blockers, 20 ms margins, 40 ms word clearance). `widenToMicrophoneEdges`,
`includeNonSpeechEvents` default true, `nonSpeechMaximumProbability` removed. Adaptive threshold
clamp −52…−26 dB. Presets: natural 1.2/0.45, balanced 0.8/0.3, tight 0.55/0.18. Gameplay clips
need protections off (`--ignore_system_audio true --ignore_screen_activity true`) and a 1.5 s
minimum or nothing is ever cut there. Sources used: Auphonic automatic video cutting (VAD plus
separate cough/filler detectors), Silero VAD parameter semantics.

### Proposed-cuts lane (Task F, `artifacts/staged-cuts-2026-09-18/README.md`)

Store `src/components/ai-edition/pauses/pauseAnalysisStore.ts`: `stageCuts`, `moveCutEdge`
(clamped to clip, neighbours, ≥ 40 ms), `removeCut`, `acceptAll` (one undo and one history
step), `rejectCut` with per-project rejection memory (≥ 50 % overlap suppressed). Pill:
`src/components/ai-edition/v4/ProposedCutPill.tsx` (handles, × reject, Delete, arrow keys).
Audio pane shows "N proposed cuts", kind breakdown, Clear, Preview, Accept all (N). Renderer
action "stage". Kinds: pause, blip, agent, fix. **Known problem:** the pills are still drawn with
the old `.pauseCandidatePill` look inside the clip strip (tiny dashed boxes at 48 % opacity);
Task F2 fixes that (§7).

### Preview performance (overnight)

Async VideoToolbox decode + 60 Hz canvas, native look-ahead decoder pair, double-buffered
`<video>` clocks, B-roll prepared off the render thread. Cuts hold ≤ 27 ms, the 49–55 s span
0 ms repeated, 55–60 fps. Olle still felt "slight lag after a silence removal": that is the
normal ~200 ms play-start hold plus the cut hold; measure with `transport --script` sample runs
before changing anything.

### Other agent-first tooling from the six overnight tasks (A–E)

`state`, paged `check`, `layout set` (anchors and sizes: XS 14 %, S 20 %, M 26 %, L 34 %,
XL 44 %; safe margin 4 %), `text add`, `broll add`, `zoom add`, `camera set`, `frame(s)`,
`assets`, `history`/`undo`/`redo` with a verify block on `apply`, `clip replace`, `settings`,
`preset`, `auto`, `transcript`. Camera region edges within 0.6 s of a cut snap onto the cut at
render time (this removed the "double tap" Olle disliked). Task B left per-clip
`cameraLayoutPreset`/`screenFraming` failing explicitly (needs Rust).

## 6. The Kimi swarm video edit (the real job)

- Project `proj_77f9202f-6dfd-4bff-891a-df2177b88760`, file
  `/Users/olle/Library/Application Support/openscreen/projects/proj_77f9202f-6dfd-4bff-891a-df2177b88760.klippt`,
  backup `…klippt.backup-20260918-0130.bak`. Edited length 677.1 s after today's tail cuts
  (was 690.4). 95 trims, 75 camera regions, 11 zooms, 39 overlays at the overnight count.
- Spec: `/Users/olle/dev/kimi-swarm-arena/_staging/edit-2026-09-17/EDIT-HANDOFF-2026-09-17.md`.
  Script note (recording card, the "PLUG: Kimi sponsored the run; K3 in both seats. One line,
  then back to the game" card, evidence list: cmux time-lapse, kimi vis, sprite sheet, round-2
  prompt): `/Users/olle/Documents/Notes/Agent/02 - Content/YouTube/Videos/2026-09-06 One AI vs
  an AI Swarm Same Game/… — Script.md`.
- Assets: `_staging/edit-2026-09-17/{broll,graphics,cards}` (all B-roll cards are 40 s loops;
  padded stills must be 1920×1242 to match his 3420×2214 screen layer or cover-fit crops the
  sides), gameplay `_staging/play-2026-09-11/clips/*.mp4` (7–70 s, mixed aspect).
- Applied today for Olle (request ids in HANDOFF): tails at 2:02, 2:28–2:30, 2:53, four studio
  loose tails, the 5.3 s scoring silence at 4:57, clip 4 and clip 5 tails; three tightened tails
  restored after "experiment"/"yourselves"/"possible" were clipped. The 5:47.6 silence he named
  sits in a gameplay clip and is in the staged set below.
- **Staged, not accepted:** 6 gameplay cuts (`artifacts/orchestrator-handoff-2026-09-18/gameplay-v6-ops.json`, 7 minus
  one Codex rejected during its test). Olle accepts them in the GUI or says "accept" and the
  orchestrator runs `ag accept --project_id …`. Do not accept without his word.
- Open audio work: the remaining `gap.silence` warnings all sit in the four gameplay clips.
  Next filter layer he asked for: fillers ("um", "uh", "like" when isolated), after blips.
- 27 `gap.silence` warnings were never acted on overnight; the skill loop should list them.

### The shot map (published at https://claude.ai/artifact/9xwXraz6yB58ZAC8G7Fn5k, nothing applied)

Thirty bare stretches ≥ 2 s where the narration shows his desktop with the Obsidian recording
card: 260 s, 39 % of the edit. Seven sliver overlays (3 ms each, edge-snapping leftovers) to
delete. Two beats need captures he does not have. Three looks: B-roll full frame for evidence;
camera full frame (size L) for opinion and set-up; real desktop only when the screen is the
evidence (cmux or kimi vis, never the recording card); one lower-third line when no picture
exists for an argument.

Global fixes first: delete the 7 slivers; 0:57.0 restore the Warden death clip
(`r2swarm-03-warden-death1`, clip 25 kept only a sliver); 1:01–1:13 sponsor line gets
`r1swarm-03-boss-ring` under it and the disclosure marker moved bottom-left at 30 % width off
his camera; extend six late-starting overlays to the first word of their beat.

| At | Len | Beat | Proposed |
|---|---|---|---|
| 0:04.6 | 3.9 s | solo vs swarm line | split: r1solo-01-first-30s left, r1swarm-01-first-30s right |
| 0:08.5 | 4.0 s | round one started | extend slot-kimi-vis to the first word |
| 0:19.7 | 9.1 s | many separate parts | r1swarm-05-dead-close-in 0–9 s |
| 0:28.8 | 17.2 s | the two fears | camera full 0–7 s, evo-swarm2-1s-per-10min 7–17 s |
| 0:46.1 | 5.7 s | can an agent make a fun game | camera full, size L |
| 0:57.0 | 2.9 s | not sure I do | continue r2swarm-03-warden-death1 |
| 1:01.3 | 12.0 s | sponsor line | r1swarm-03-boss-ring under, marker bottom-left 30 % |
| 1:13.4 | 5.9 s | the rules | camera full 0–3 s, prompts-side-by-side extended |
| 1:37.2 | 25.0 s | orchestrator built a skeleton | evo-swarm-1s-per-10min 0–23 s, hold 2 s |
| 2:02.3 | 18.7 s | 54 agents own tasks | NEEDS CAPTURE kimi vis tree; fallback slot-kimi-vis |
| 2:27.5 | 16.9 s | merged, nothing overlapped | own-swarm-arena owned-files png 0–10 s, evo-swarm last 7 s |
| 2:44.4 | 3.1 s | something still broke | camera full, size XL |
| 2:53.3 | 3.6 s | base agent found the issue | extend qa-six-reviewers to the first word |
| 3:04.5 | 2.1 s | fixed, cool | camera full |
| 3:06.6 | 5.9 s | 54 agents in total | evo-swarm 12–18 s at 2× |
| 3:12.5 | 4.7 s | thought it would cost a fortune | camera full |
| 3:17.2 | 11.2 s | round one cost less | stat-pair-r1 0–11 s (drop its later use at 4:03) |
| 3:34.6 | 8.3 s | the reason is context | camera full + lower third "Solo: rereads everything, every round" |
| 3:42.9 | 12.0 s | swarm small contexts | lower third "Swarm: 54 small contexts" |
| 3:54.9 | 5.1 s | base agent carries less | camera full, text stays |
| 4:00.0 | 3.0 s | a typical worker | NEEDS CAPTURE one cmux worker pane; fallback camera full |
| 5:57.8 | 23.8 s | what I came to think | camera full 0–8 s, prompts-side-by-side 8–24 s |
| 6:21.6 | 14.0 s | follows a list verdict | camera full + lower third "Round 1: follows a list. Round 2: what does it choose?" |
| 6:35.6 | 4.0 s | round two set-up | extend prompts-side-by-side to "round two" |
| 9:31.1 | 5.1 s | final scores | scoreboard 0–5 s then the four grids |
| 9:59.3 | 4.9 s | not everything perfect | extend r1swarm-07-max-swarm to the first word |
| 10:14.8 | 8.7 s | 2D autoshooter not impressive | camera full, size L |
| 10:23.5 | 7.5 s | real understanding of fun | r2swarm-05-chain-lightning 0–7.5 s |
| 10:31.0 | 12.9 s | wish I picked Megabonk | camera full 0–7 s, missing-megabonk extended |
| 10:45.9 | 8.4 s | ask to camera | camera full (do not tease the cut Astra bonus) |
| 11:11.8 | 2.0 s | credit where due | camera full |

Rules of taste used: no B-roll shorter than 2.5 s; B-roll starts on the first word and ends on
a cut; an asset appears full-frame at most once; opinion to camera, evidence to B-roll, desktop
only when the screen is the proof; text on camera one line only when no picture exists.

Olle's calls still open: capture kimi vis for round 1 (session 53d0ecea) and one cmux worker
pane, or accept the fallbacks; camera full frame on eleven beats, too much face or right; keep
or drop the three lower-third lines.

## 7. In flight and queued

### Task F2 (running when I wrote this): make the proposed-cuts lane visible

Brief: `artifacts/orchestrator-handoff-2026-09-18/taskF2-prompt.md`. Summary of the contract: render a dedicated
`.tlLane` row for proposed cuts above the clip strip (below the zoom lane); remove the in-clip
overlay but keep a non-interactive kind-coloured wash over the removed waveform span; pills reuse
`.lanePill` metrics (28 px, 7 px radius, 1.5 px border, token colours per kind: pause
`--editor-accent`, blip `--annotation`, agent `--accent`, fix `--warn`); label is the saved
seconds ("−3.9 s") with a scissors icon, icon only when narrow, 3 px marker under 14 px;
visible 2 px edge handles with hover/focus; × only when ≥ 56 px wide, Delete still rejects;
tooltip with origin and range; no store/CLI/pane changes. Gates: both typechecks, focused and
full vitest, lint, i18n, docs; live: build, restart, 6 staged cuts visible in a full-window
screenshot at default zoom (if the worker cannot see six coloured pills, it is not done),
second screenshot zoomed on 3:30–3:50; evidence in `artifacts/staged-cuts-2026-09-18/lane-v2/`.

Check: `cat $S/taskF2.done`, read `taskF2.last.md`, open the lane-v2 screenshots yourself.

### Task G (queued behind F2 via `chain-G.sh`): `broll swap` with auto-fit

Brief: `artifacts/orchestrator-handoff-2026-09-18/taskG-prompt.md`. Contract: `broll swap --project_id P --overlay ID
--file /abs.mp4 [--offset] [--fit auto|cover|contain] [--time trim|hold]`. Keeps span, clip,
anchor, motion, opacity, placement; changes asset, sourceOffsetSec, fit, and endMs when the
media is shorter. Size fit: slot aspect (placement rect in output pixels or full canvas) vs media
aspect; within 8 % → cover, otherwise contain unless forced. Time fit: `available = duration −
offset`; longer span → trim end (default) or hold only if the compositor holds the last frame
(worker must find out in `crates/compositor/src/compositor_macos.rs` `frame_at` and record
file:line); shorter → keep span, report `unusedTailSec`; `available ≤ 0.5 s` → MEDIA_TOO_SHORT.
Reuse an existing asset by resolved path, else import via the same `prepareVideoAsset` path as
`broll add`. Reply mirrors `broll add` plus a `swap` block. Live test on a `clone` of the Kimi
project, never the original; `frames --at` across the swapped span, looked at. Evidence
`artifacts/broll-swap-2026-09-18/`. Key files: `electron/cli/agentPlacement.ts` (`brollInput`,
`buildPlacement`), `electron/cli/editorAgentBroker.ts` ~510–570 (import and clip-replace
branches), `electron/ai-edition/agentEditPlan.ts` (`setVideoOverlay`),
`electron/ai-edition/agentClipReplacement.ts` (reporting style to mirror), asset schema
`src/lib/ai-edition/schema/index.ts` ~304 (`video.width/height` may be unfilled: extend the
ffprobe in `electron/stt/sourceAudio.ts`, no second wrapper).

If the chain died with my session, launch G by hand after F2's done-file appears.

### Where things stood when Olle left (13:25)

Task G was running (`codex/taskG.log`, done-file `taskG.done`). It works on a clone of the Kimi
project and writes its own evidence README plus a HANDOFF bullet, so it was left to finish. When
you start: `cat taskG.done`; if it says `exit=0`, read `taskG.last.md` and review the diff; if
the file is missing, `pgrep -fl 'codex exec'` tells you whether it is still alive. Do not start a
second worker while it runs.

### Queue after that, in the order I would run it

1. F2 is done and verified (lane visible, `artifacts/staged-cuts-2026-09-18/lane-v2/`). **Do
   not accept the six staged cuts yet.** At 13:20 Olle reported: "the 425.7 cut cuts me
   mid-sentence again" (edited time 4:25.7). Not investigated: the CLI gave an empty reply while
   Task G held the editor. First job: `state --at 4:25.7 --range 423 429` and the transcript
   around it; find out whether it is one of the six pills (4:19.2 is 3.7 s, 4:30.0 is 0.6 s;
   accepting 4:19.2 would move 4:30.0 to about 4:26.3, so it is probably that one after an
   Accept), an applied trim from today, or a pill he dragged. If applied, restore it. Then check
   every remaining staged cut against the transcript before he presses Accept.
2. Olle answers the three shot-map calls. Then stage the shot map: delete the 7 slivers,
   restore clip 25, sponsor gameplay + marker, extend the six late overlays, then the 30 rows
   via `broll add --words`/`--from --to`, `camera set`, `text add`. One `apply` per beat,
   `frames` after each group, `check --all` clean before telling him.
3. Captures: kimi vis round 1 and a cmux worker pane. See §9 for the fastest path.
4. **Transcript-first cut planning (Olle, 13:20: "you have to look at the transcript when it
   makes sense to cut, like the majority part").** Today audio finds the gap and the transcript
   only vetoes. Invert it: the transcript decides whether a cut is allowed at all (between a
   sentence end and the next sentence start, or a transcript gap ≥ the pause minimum), and audio
   only sets the exact edges inside that window. A proposal with no transcript on both sides
   inside the clip still needs speech-probability silence, never mic level alone. Gameplay clips
   have sparse transcript, which is exactly where the last three mid-sentence cuts came from.
   Add a test with a real Kimi transcript slice. This ranks above the fillers layer.
5. Fillers layer of the pause pass (his "harsher and harsher" list): transcript words
   `um/uh/erm` and isolated `like` as `kind: "filler"` proposals, off by default, same lane.
6. **Applied-cut seam polish (Olle, 2026-09-18 13:10: "the UI of them is hella bad").** Applied
   trims collapse to a 2 px seam with a rotated scissors button (`V4Timeline.tsx` ~1780
   `styles.tlCut` / `.tlCutRestore`, CSS ~1814). Two problems: it looks unfinished, and on
   hover/highlight he sees a raw translation key beginning `timeline.trim…` instead of a label.
   Find the raw key first (the `timeline` namespace has `labels.trim`, `labels.trimItem`; the
   restore tooltip uses `inspector.restoreDeleteTrim` from `editor.json`; check the inspector and
   any `t()` call whose scope does not match the key) and fix it at the source. Then redesign the
   seam as a proper token-styled mark: removed length beside the scissors, kind colour matching
   the proposal that produced it (pause, blip, agent, fix), a clear hover state, and a tooltip
   in words ("Restore 3.9 s"). Screenshot gate like F2. Run this right after F2 and G.
7. GUI gap: there is no video-overlay lane in `V4Timeline.tsx` (zero references to
   `videoOverlays`), so B-roll cannot be trimmed in time with the mouse. After swap lands,
   give overlays the same lane treatment as proposed cuts.
8. Full export of the Kimi edit, watch every changed moment, transcript diff of the export.
9. Only then: the Windows/Linux and billing work in `PRODUCT_PLAN.md`. Not this week.

## 8. Lessons that each cost a loop (keep them)

- Whisper word ends run 0.3–1 s late; mic onsets fire on breaths; a stop closure inside a word
  is a 40–120 ms dip. Never cut on Whisper word ends; measure.
- `transport` replies bypass the 47 KiB bounder since today; before that every probe frame was
  cut to 512 chars and `run_probes.py` reported false "no holds". A 524-char frame means
  truncation. It reports no holds when all frames are identical: check frame bytes first.
- `pauses` is cached per revision and policy: run it after all structural edits; first call
  returns `analyzing`, poll every ~12 s.
- `preview`/`geometry` need `--snapshot` = sha256 of the .klippt file.
- Shell-mangled plan ids give `PLAN_UNAVAILABLE`; re-plan with a new request id.
- `--ignore_non_speech true` "requires a value" was zsh not word-splitting `$flags`.
- `src/lib/ai-edition/schema.ts` does not exist; the overlay schema is in `schema/index.ts`.
- Bulk regex edits on `VirtualPreview.tsx` once deleted 100 lines silently. Exact-string
  replacements with asserts only; restore from `git show HEAD:path`.
- Electron persists per-origin zoom; never call `setZoomFactor` in the renderer.
- Full-screen B-roll must match the screen layer aspect (3420×2214) or cover-fit crops.
- His recording key press is a mic event that protects most clip lead-ins; transcript edge trims
  (first word − 0.12, last word + 0.18) close them. He rejected `pauses` inside his own takes
  once for cutting mid-take; use `edges` for clip edges and `cutpoint` inside a sentence.
- Camera regions that start right after a cut read as a "double tap"; snap edges to cuts.
- The five auto emphasis regions he disliked were exactly those.
- Task F's own screenshots "inspected" still missed that the pills were invisible. Open the PNG.

## 9. His B-roll question today (answer, and the decision I recommend)

He asked how to get me the kimi vis B-roll fastest, whether B-roll should be recorded OBS-style
during the main recording, and whether he can crop B-roll in time in the editor.

What exists: B-roll enters only as a file. GUI: the Import media button in the top bar or a drag
onto the timeline (`ASSET_MIME` drop in `V4Timeline.tsx`, handled in `NewEditorShell.tsx`). CLI:
`broll add --file /abs.mp4 --words "…"|--from --to [--offset]`. Time cropping is `--from/--to`
plus `--offset` (source start); after Task G the swap command fits length automatically. There is
no overlay lane in the timeline, so mouse trimming of B-roll in time does not exist yet (queue
item 5). The recorder captures one screen or window per recording; there is no second source.

Recommendation: do not build in-recording B-roll. Record the kimi vis window as its own Klippt
recording (or any screen recording; QuickTime is fine), then `ag assets --project_id
<that project>` prints the clip's file path and the agent places it with `broll add` or swaps it
in with `broll swap` once G lands. The evidence he needs (kimi vis tree round 1, session
53d0ecea; one cmux worker pane) can be recorded any time; length does not matter, the fit rules
trim it. Counter-case for OBS-style capture: it would add a second encoder to the recording
path, the part of the product with the strictest reliability gates, to save one file import.

## 10. Verification recipes

```
# ffmpeg RMS per 20 ms around a proposed cut (word tail −25…−40 dB, silence < −50 dB)
ffmpeg -v error -ss START -t 0.9 -i SRC.mp4 -map 0:a:0 -ac 1 -ar 16000 -f s16le - \
 | python3 -c 'import sys,struct,math; d=sys.stdin.buffer.read(); n=320
for i in range(0,len(d)-n*2,n*2):
  s=struct.unpack("<%dh"%n,d[i:i+n*2]); r=math.sqrt(sum(x*x for x in s)/n)+1e-9
  print(f"{i/32000:.2f}s {20*math.log10(r/32768):6.1f} dB")'

# frames at edited seconds, contact sheet
ag frames --project_id $P --at 57,60,63 --out /tmp/frames

# is anything recording?  (never restart while this lists a helper)
pgrep -fl screencapturekit-helper

# dev editor restart after a renderer change
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx vite build && python3 artifacts/preview-broll-2026-09-18/restart.py

# gates before any "done"
npx tsc --noEmit && npx tsc -p tsconfig.test.json --noEmit && npm run test && npm run lint && npm run i18n:check && npm run docs:check
```

Known noise: one existing lint warning (oversized file), eight unrelated vault routing errors.

## 11. Memory and skills to keep updated

- Claude memory (Codex reads it too): `/Users/olle/.claude/projects/-Users-olle-dev-screenrec/memory/klippt-agent-cli-edit-workflow.md` and `MEMORY.md` index.
- Skill `klippt-edit` (`SKILL.md`, `references/commands.md`): grow "Rules of taste" from his
  corrections; "Before tightening any cut" is the measurement rule.
- Skill `development`: the route table and the plain-words rule. Run `python3 scripts/check.py`
  after editing it.
- Vault project card under `Agent/04 - Business/Project Cards/` for durable Klippt decisions;
  link from `Agent/Log.md`.

## 12. Questions only Olle can answer (ask when he is back)

1. Accept the 6 staged gameplay cuts?
2. Shot map: the two captures, eleven camera-full beats, three lower-third lines.
3. Task G defaults: is "trim the overlay to the media length" the right default, or should a
   too-short clip be refused so he notices?
4. Fillers layer: on by default in the pause pass, or a separate proposal kind he turns on?
