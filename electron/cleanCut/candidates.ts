import { isFiller, type Word } from "./words";

export type CandidateKind = "filler" | "stutter" | "repair" | "retake";

export interface Candidate {
	kind: CandidateKind;
	drop: number[];
	keep: number[];
	confidence: "high" | "ambiguous";
	why: string;
	id: string;
	evidence: number;
}

export const spanText = (ws: Word[]) => ws.map((w) => w.text).join(" ");

/** Content words of each take, fillers set aside. */
export function contentByTake(words: Word[]): Word[][] {
	const takes: Word[][] = [];
	let last: Word["take"] | null = null;
	for (const w of words) {
		if (isFiller(w)) continue;
		if (w.take !== last) {
			takes.push([]);
			last = w.take;
		}
		takes[takes.length - 1].push(w);
	}
	return takes;
}
