import type { SttPhraseSegment, SttWordSegment } from "./transcriptionContract";

/** Increment when seam reconciliation changes so old cache entries cannot survive it. */
export const TRANSCRIPT_SEAM_VERSION = 2 as const;

const SEAM_SEARCH_PADDING_SEC = 1.25;
const OCCURRENCE_GAP_SLOP_SEC = 0.08;

export interface TranscriptChunkResult {
	index: number;
	decodeStartSec: number;
	decodeEndSec: number;
	coreStartSec: number;
	coreEndSec: number;
	segments: SttPhraseSegment[];
	wordSegments: SttWordSegment[];
}

interface Candidate<T extends { startSec: number; endSec: number }> {
	item: T;
	chunk: TranscriptChunkResult;
}

function midpoint(item: { startSec: number; endSec: number }): number {
	return (item.startSec + item.endSec) / 2;
}

function normalizeToken(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Every non-empty phrase must be backed by native word timing from the same source. */
export function hasCompletePhraseWordTiming(
	segments: SttPhraseSegment[],
	wordSegments: SttWordSegment[],
): boolean {
	return segments.every((segment) => {
		if (!segment.text.trim()) return true;
		return wordSegments.some(
			(word) =>
				word.word.trim().length > 0 &&
				(segment.sourceRole === undefined ||
					word.sourceRole === undefined ||
					segment.sourceRole === word.sourceRole) &&
				word.startSec <= segment.endSec + 0.001 &&
				word.endSec >= segment.startSec - 0.001,
		);
	});
}

function isSameOccurrence<T extends { startSec: number; endSec: number }>(
	left: Candidate<T>,
	right: Candidate<T>,
	text: (item: T) => string,
): boolean {
	const leftText = normalizeToken(text(left.item));
	const rightText = normalizeToken(text(right.item));
	const leftDuration = Math.max(0.02, left.item.endSec - left.item.startSec);
	const rightDuration = Math.max(0.02, right.item.endSec - right.item.startSec);
	const midpointTolerance = Math.min(
		0.35,
		Math.max(0.16, Math.max(leftDuration, rightDuration) * 0.6),
	);
	const intervalsTouch =
		left.item.startSec <= right.item.endSec + OCCURRENCE_GAP_SLOP_SEC &&
		right.item.startSec <= left.item.endSec + OCCURRENCE_GAP_SLOP_SEC;
	return (
		leftText.length > 0 &&
		leftText === rightText &&
		intervalsTouch &&
		Math.abs(midpoint(left.item) - midpoint(right.item)) <= midpointTolerance
	);
}

/** Ordered LCS, bounded to the small overlap window rather than the full transcript. */
function seamMatches<T extends { startSec: number; endSec: number }>(
	left: Candidate<T>[],
	right: Candidate<T>[],
	text: (item: T) => string,
): Array<[number, number]> {
	const rows = left.length + 1;
	const cols = right.length + 1;
	const scores = new Uint16Array(rows * cols);
	const at = (row: number, col: number) => row * cols + col;
	for (let row = 1; row < rows; row += 1) {
		for (let col = 1; col < cols; col += 1) {
			scores[at(row, col)] = isSameOccurrence(left[row - 1], right[col - 1], text)
				? scores[at(row - 1, col - 1)] + 1
				: Math.max(scores[at(row - 1, col)], scores[at(row, col - 1)]);
		}
	}

	const matches: Array<[number, number]> = [];
	let row = left.length;
	let col = right.length;
	while (row > 0 && col > 0) {
		if (isSameOccurrence(left[row - 1], right[col - 1], text)) {
			matches.push([row - 1, col - 1]);
			row -= 1;
			col -= 1;
		} else if (scores[at(row - 1, col)] >= scores[at(row, col - 1)]) {
			row -= 1;
		} else {
			col -= 1;
		}
	}
	return matches.reverse();
}

function ownershipScore<T extends { startSec: number; endSec: number }>(
	candidate: Candidate<T>,
): number {
	const time = midpoint(candidate.item);
	if (time >= candidate.chunk.coreStartSec && time < candidate.chunk.coreEndSec) return 2;
	const distance =
		time < candidate.chunk.coreStartSec
			? candidate.chunk.coreStartSec - time
			: time - candidate.chunk.coreEndSec;
	return 1 - Math.min(1, distance / SEAM_SEARCH_PADDING_SEC);
}

function preferred<T extends { startSec: number; endSec: number }>(
	left: Candidate<T>,
	right: Candidate<T>,
): Candidate<T> {
	const leftScore = ownershipScore(left);
	const rightScore = ownershipScore(right);
	if (rightScore !== leftScore) return rightScore > leftScore ? right : left;
	const leftConfidence = "confidence" in left.item ? Number(left.item.confidence ?? -1) : -1;
	const rightConfidence = "confidence" in right.item ? Number(right.item.confidence ?? -1) : -1;
	return rightConfidence > leftConfidence ? right : left;
}

function mergeItems<T extends { startSec: number; endSec: number }>(
	chunks: TranscriptChunkResult[],
	select: (chunk: TranscriptChunkResult) => T[],
	text: (item: T) => string,
): T[] {
	const ordered = [...chunks].sort((a, b) => a.index - b.index);
	const merged: Candidate<T>[] = [];
	for (const chunk of ordered) {
		const incoming = select(chunk).map((item) => ({ item, chunk }));
		if (merged.length === 0) {
			merged.push(...incoming);
			continue;
		}

		const seamEndSec = chunk.coreStartSec + Math.max(0, chunk.coreStartSec - chunk.decodeStartSec);
		const leftIndices: number[] = [];
		for (const [index, candidate] of merged.entries()) {
			if (
				candidate.item.endSec >= chunk.decodeStartSec - SEAM_SEARCH_PADDING_SEC &&
				candidate.item.startSec <= seamEndSec + SEAM_SEARCH_PADDING_SEC
			) {
				leftIndices.push(index);
			}
		}
		const rightIndices = incoming
			.map((candidate, index) => ({ candidate, index }))
			.filter(({ candidate }) => candidate.item.startSec <= seamEndSec + SEAM_SEARCH_PADDING_SEC)
			.map(({ index }) => index);
		const matches = seamMatches(
			leftIndices.map((index) => merged[index]),
			rightIndices.map((index) => incoming[index]),
			text,
		);
		const matchedIncoming = new Set<number>();
		for (const [leftMatch, rightMatch] of matches) {
			const mergedIndex = leftIndices[leftMatch];
			const incomingIndex = rightIndices[rightMatch];
			merged[mergedIndex] = preferred(merged[mergedIndex], incoming[incomingIndex]);
			matchedIncoming.add(incomingIndex);
		}
		for (const [index, candidate] of incoming.entries()) {
			if (!matchedIncoming.has(index)) merged.push(candidate);
		}
		merged.sort(
			(a, b) =>
				a.item.startSec - b.item.startSec ||
				a.item.endSec - b.item.endSec ||
				a.chunk.index - b.chunk.index,
		);
	}
	return merged.map((candidate) => candidate.item);
}

/** Merge adjacent overlap windows without dropping a word seen by only one window. */
export function mergeTranscriptChunks(chunks: TranscriptChunkResult[]): {
	segments: SttPhraseSegment[];
	wordSegments: SttWordSegment[];
} {
	return {
		segments: mergeItems(
			chunks,
			(chunk) => chunk.segments,
			(segment) => segment.text,
		),
		wordSegments: mergeItems(
			chunks,
			(chunk) => chunk.wordSegments,
			(word) => word.word,
		),
	};
}
