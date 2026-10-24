# Clean cut timeline — build plan (2026-10-20)

Status: plan, not started. Prototype: `~/dev/retake-cutter` (Python, not shippable as is).

## What the user gets

- After Stop, review opens as today. Next to Save sits an opt-in toggle: **Clean cut timeline**.
- Switched on, it works in the background. The review screen never waits on it. When done: "Clean cut ready".
- A right-hand panel opens on the **unsure cuts first** (about 14 of 51 on the 24-min OBS test), with
  "Show full transcript" one click away. Cut words are struck through.
- Click a struck line: playback runs across the cut. Click Restore: the words come back and the runtime updates.
- One strength control: Gentle (sure cuts only) / Clean (mistakes only, default).
- Save writes the Resolve timeline with the cuts applied, the removed parts on a muted track, and one
  marker per reason. Nothing is lost.

Out of v1: Tight (trim to length), "change anything" chat, menu-bar folder watcher, OBS file import.

## Conflicts to settle first (Olle)

1. `AGENTS.md` says "Do not build new editor features" (Oct 3). The panel only accepts or restores
   suggestions, which matches `PRODUCT_PLAN.md` item 9 ("detect repeated phrases and false starts as review
   suggestions"). The rule needs one line that allows this panel. Never call the suggestions "takes" (item 9).
2. Who decides the cuts. The prototype uses 4 `claude -p` calls per video. Klippt has no cloud AI today; its only
   outbound call is licensing. Options, measured in phase 4:
   - Apple's on-device model (Foundation Models, macOS 26+): free and local, but a 4,096-token window, so
     it must work in chunks. Quality unknown.
   - A hosted Claude call through Klippt: best known quality, but costs per video and needs a small server.
     The video stays on the Mac; only transcript text leaves.
   - Word rules only: precision .98 but finds about 2% of what the creator removes (Warcraft test). Not enough.

## Phases

| # | Work | Done when | Agent time |
|---|---|---|---|
| 1 | Surface word times: the Swift helper already has `word/startSec/endSec/confidence` (`main.swift:21`); the TS side reads only `text` (`parakeetProcess.ts:24`). | Word times reach the renderer for a recorded take; unit test on the protocol. | 30–60 min |
| 2 | Aligner spike. Candidates: FluidAudio's Parakeet 110M CTC encoder (already a dependency, 40 ms frames), wav2vec2-base-960h as Core ML or GGUF, raw Parakeet times. | Pick one on the OBS session by join damage after re-transcription (prototype: 8/119 neighbourhoods, 2 real). | 2–3 h |
| 3 | Port the engine to TypeScript (Electron main, child-process pattern like `cleanVoiceWorker.ts`): repeat/stutter/false-start rules, cut placement at the quietest 5 ms, frame snap, edge trim. | Golden tests: TS kept-word lists match the Python `kept.json` on both eval sessions (Warcraft, OBS). | 3–4 h |
| 4 | Decision model. Run Apple's on-device model on both gold sets and compare with the cached Sonnet results (precision .893 / retake recall .459 on Warcraft). **Needs Olle's OK before any paid model run.** | Olle picks local or hosted from the numbers. | 2 h |
| 5 | Export. `buildSourceTimeline` (`sourceTimeline.ts:90`) already writes kept spans with gaps. Add the muted "Removed" track and reason markers. | Imports in Resolve 21.1 with every clip linked, removed track muted, markers present (`scripts/verify-source-handoff-resolve.py`). | 2 h |
| 6 | UI. Toggle beside Save (`RecordingReviewToolbar.tsx:160`), background status via the transcript snapshot pattern (`liveTranscript.ts:110`), right panel with unsure-first list, struck transcript, play across cut, restore, strength. | Screenshots of the real app at both window sizes; full click-through on a fresh recording. | 4–6 h |
| 7 | Gates and review. | Repo suite, typecheck, lint pass; two held-out reviews; Olle tests on one real recording. | 1–2 h |

Rough total: about two working days of agent time, plus Olle's answers on the two conflicts.

## Rules carried over from the prototype

- Decisions use Parakeet-timed words; cut placement uses aligned times (keeps model prompts stable).
- Restart rule keeps the second copy ("This… this took" keeps "this took").
- Edge trim keeps 0.10 s lead and 0.16 s tail; a clip end never runs past the next word's onset.
- It cuts more than a light-editing creator does (OBS test: about half its cuts were lines he kept), so the
  review panel and strength control are required, not polish.

## Notes

- The repo has uncommitted dependency-approval work from another session (2026-10-20). Build on a branch or worktree.
- Final Cut: Klippt exports OTIO only. FCP needs FCPXML, so FCP is out of v1.
- Mockups that led here: six takes plus a combined version, in the 2026-10-20 session scratchpad (not in the repo).
