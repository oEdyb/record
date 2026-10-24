import type { CleanCutKeep, CleanCutRegion, CleanCutSnapshot, CleanCutWord } from "./types";

/** The source a viewer's own cut carries; it applies at every strength. */
export const USER_SOURCE = "user";
const EDGE_PAD_SEC = 0.05;
const MIN_STRETCH_SEC = 0.02;

const endsSentence = (word: CleanCutWord) => /[.?!]["')\]]*$/.test(word.text);

/** The kept sentence around word `index`: its first and last word, or null if the word is cut. */
export function sentenceAround(
	words: readonly CleanCutWord[],
	index: number,
): [number, number] | null {
	const word = words[index];
	if (!word || word.regionId !== null) return null;
	const inSentence = (i: number) =>
		words[i]?.assetId === word.assetId && words[i]?.regionId === null;
	let first = index;
	while (inSentence(first - 1) && !endsSentence(words[first - 1])) first -= 1;
	let last = index;
	while (!endsSentence(words[last]) && inSentence(last + 1)) last += 1;
	return [first, last];
}

/** A cut of words `first`..`last`, edged halfway into the pauses on either side. */
export function userCutRegion(
	words: readonly CleanCutWord[],
	keep: readonly CleanCutKeep[],
	first: number,
	last: number,
): CleanCutRegion {
	const start = words[first];
	const end = words[last];
	const previous = words[first - 1]?.assetId === start.assetId ? words[first - 1] : null;
	const next = words[last + 1]?.assetId === end.assetId ? words[last + 1] : null;
	let removedStartSec = previous
		? (previous.endSec + start.startSec) / 2
		: Math.max(0, start.startSec - EDGE_PAD_SEC);
	let removedEndSec = next ? (end.endSec + next.startSec) / 2 : end.endSec + EDGE_PAD_SEC;
	// Restoring the cut fills its range back in, so it must not reach into time the engine cut.
	const stretches = keep.filter(
		(stretch) =>
			stretch.assetId === start.assetId &&
			stretch.endSec > removedStartSec &&
			stretch.startSec < removedEndSec,
	);
	if (stretches.length) {
		removedStartSec = Math.max(removedStartSec, Math.min(...stretches.map((s) => s.startSec)));
		removedEndSec = Math.min(removedEndSec, Math.max(...stretches.map((s) => s.endSec)));
	}
	return {
		id: `user:${start.assetId}:${first}`,
		kind: "manual",
		assetId: start.assetId,
		removedStartSec,
		removedEndSec,
		words: words.slice(first, last + 1).map((word) => word.text),
		reason: "",
		sources: [USER_SOURCE],
		risky: false,
	};
}

function subtract(keep: readonly CleanCutKeep[], cut: CleanCutRegion): CleanCutKeep[] {
	return keep.flatMap((stretch) => {
		if (
			stretch.assetId !== cut.assetId ||
			stretch.endSec <= cut.removedStartSec ||
			stretch.startSec >= cut.removedEndSec
		)
			return [stretch];
		const pieces: CleanCutKeep[] = [];
		if (cut.removedStartSec - stretch.startSec >= MIN_STRETCH_SEC)
			pieces.push({ ...stretch, endSec: cut.removedStartSec });
		if (stretch.endSec - cut.removedEndSec >= MIN_STRETCH_SEC)
			pieces.push({ ...stretch, startSec: cut.removedEndSec });
		return pieces;
	});
}

/** The engine's snapshot with the viewer's own cuts taken out of what plays. */
export function withUserCuts(
	snapshot: CleanCutSnapshot,
	cuts: readonly CleanCutRegion[],
): CleanCutSnapshot {
	if (cuts.length === 0) return snapshot;
	let keep = snapshot.keep;
	for (const cut of cuts) keep = subtract(keep, cut);
	const owner = (word: CleanCutWord) =>
		word.regionId === null
			? cuts.find(
					(cut) =>
						cut.assetId === word.assetId &&
						word.startSec >= cut.removedStartSec &&
						word.endSec <= cut.removedEndSec,
				)
			: undefined;
	return {
		...snapshot,
		keep,
		regions: [...snapshot.regions, ...cuts],
		words: snapshot.words.map((word) => {
			const cut = owner(word);
			return cut ? { ...word, regionId: cut.id } : word;
		}),
	};
}
