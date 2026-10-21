import type { Candidate } from "./candidates";
import type { FillerPolicy } from "./types";
import { isFiller, type Word } from "./words";

const FILLER_GAP = 0.4;

/**
 * um/uh the recognizer wrote down. "paused" cuts the ones next to a pause, where the cut lands in
 * silence; a filler glued into flowing speech stays unless a repair rule claims it.
 */
export function fillers(words: Word[], policy: FillerPolicy = "paused"): Candidate[] {
	const out: Candidate[] = [];
	for (const w of words) {
		if (!isFiller(w) || policy === "none") continue;
		if (policy === "paused" && Math.max(w.gapBefore, w.pauseAfter) < FILLER_GAP) continue;
		out.push({
			kind: "filler",
			drop: [w.gi],
			keep: [],
			confidence: "high",
			why: `filler '${w.text.replace(/^[.,?!]+|[.,?!]+$/g, "").toLowerCase()}'`,
			id: "",
			evidence: 0,
		});
	}
	return out;
}
