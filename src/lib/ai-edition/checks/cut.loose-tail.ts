import type { AxcutWord } from "../schema";
import { type CutEdge, type CutPointCandidate, planCutPoint } from "../timeline/cut-point";
import { cutTrimFixes } from "./cutTrimFix";
import { type CheckRule, type Finding, finding } from "./types";

const LOOSE_AIR_SEC = 0.35;

function adjacent(words: AxcutWord[], timeSec: number, edge: CutEdge, chosen: CutPointCandidate) {
	let index = -1;
	for (let i = 0; i < words.length && words[i].startSec < timeSec; i++) index = i;
	const word = edge === "out" ? words[index] : words[index + 1];
	return Boolean(word) && chosen.transcriptSec === (edge === "out" ? word.endSec : word.startSec);
}

export const cutLooseTail: CheckRule = {
	id: "cut.loose-tail",
	severity: "warning",
	audio: true,
	describe:
		"Microphone air of 0.35s or more sits between the last or first word and a cut; the planner's padded cut point removes it.",
	fix: "setTrim tightens the matching trim endpoint to the planner's mic-level cut.",
	run(context) {
		const findings: Finding[] = [];
		const notes = new Set<string>();
		const trimFixes = cutTrimFixes(context.document);
		for (const cut of context.cuts) {
			for (const edge of ["out", "in"] as const) {
				const fragment = edge === "out" ? cut.left : cut.right;
				if (context.audioAssets && !context.audioAssets.has(fragment.assetId)) continue;
				const clip = context.document.timeline.clips.find((item) => item.id === fragment.clip);
				const asset = context.assets.find((item) => item.id === fragment.assetId);
				const words = context.words.get(fragment.assetId) ?? [];
				const audio = context.audio.get(asset?.id ?? "");
				if (!clip || !asset?.durationSec || !words.length || !audio?.microphonePeaks) {
					notes.add(
						`cut.loose-tail skipped: microphone peaks or transcript unavailable for ${fragment.assetId}.`,
					);
					continue;
				}
				const timeSec = edge === "out" ? fragment.source.endSec : fragment.source.startSec;
				const plan = planCutPoint({
					clip,
					durationSec: asset.durationSec,
					timeSec,
					edge,
					words,
					microphonePeaks: audio.microphonePeaks,
				});
				const chosen = plan.chosen;
				if (!chosen || chosen.method !== "mic-level" || !adjacent(words, timeSec, edge, chosen))
					continue;
				const airSec = edge === "out" ? timeSec - chosen.cutSec : chosen.cutSec - timeSec;
				if (airSec < LOOSE_AIR_SEC) continue;
				const text = edge === "out" ? chosen.before : chosen.after;
				findings.push({
					...finding(
						cutLooseTail,
						{ startSec: cut.at, endSec: cut.at },
						clip.id,
						`${edge === "out" ? "Out" : "In"}-point ${timeSec.toFixed(3)}s leaves ${airSec.toFixed(3)}s of air ${edge === "out" ? "after" : "before"} "${text}"; cut at ${chosen.cutSec.toFixed(3)}s (mic-level).`,
						trimFixes.fixFor(clip.id, edge, timeSec, chosen.cutSec),
					),
					cutEvidence: { method: chosen.method, disagreementSec: airSec },
				});
			}
		}
		trimFixes.dropInvalid(findings);
		return { findings, notes: [...notes] };
	},
};
