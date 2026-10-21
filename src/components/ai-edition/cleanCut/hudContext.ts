import type { CleanCutRegion, CleanCutWord } from "@/lib/cleanCut/types";

export interface ContextWord {
	text: string;
	/** Part of another cut that is active right now. */
	cut: boolean;
}

export interface CutContext {
	before: ContextWord[];
	/** The words this cut removes, shortened in the middle when long. */
	head: string[];
	tail: string[];
	hidden: number;
	/** Every word the cut removes, for when the viewer opens the fold. */
	all: string[];
	after: ContextWord[];
}

const HEAD = 12;
const TAIL = 6;

/** The words around one cut, as the review card reads them. */
export function cutContext(
	words: readonly CleanCutWord[],
	region: CleanCutRegion,
	cutIds: ReadonlySet<string>,
	span = { before: 12, after: 10 },
): CutContext {
	const first = words.findIndex((word) => word.regionId === region.id);
	let last = first;
	if (first !== -1) while (words[last + 1]?.regionId === region.id) last += 1;
	const removed = first === -1 ? region.words : words.slice(first, last + 1).map((w) => w.text);
	const around = (from: number, to: number) =>
		words.slice(Math.max(0, from), Math.max(0, to)).map((word) => ({
			text: word.text,
			cut: word.regionId !== null && cutIds.has(word.regionId),
		}));
	const long = removed.length > HEAD + TAIL + 4;
	return {
		before: first === -1 ? [] : around(first - span.before, first),
		head: long ? removed.slice(0, HEAD) : removed,
		tail: long ? removed.slice(-TAIL) : [],
		hidden: long ? removed.length - HEAD - TAIL : 0,
		all: removed,
		after: first === -1 ? [] : around(last + 1, last + 1 + span.after),
	};
}
