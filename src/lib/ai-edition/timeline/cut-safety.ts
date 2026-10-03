import type { AxcutClip, AxcutTranscript, AxcutWord } from "../schema";

export function speechEnvelopeCoversDuration(
	probabilities: Float32Array | null | undefined,
	frameSec: number | undefined,
	durationSec: number,
): boolean {
	return Boolean(
		probabilities &&
			probabilities.length > 0 &&
			frameSec &&
			Number.isFinite(frameSec) &&
			frameSec > 0 &&
			Number.isFinite(durationSec) &&
			durationSec > 0 &&
			probabilities.length * frameSec + 0.000_001 >= durationSec &&
			probabilities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
	);
}

export function trustedTranscriptWords(
	transcript: AxcutTranscript | null | undefined,
	clip: AxcutClip,
	durationSec: number,
): AxcutWord[] {
	if (!transcript || transcript.assetId !== clip.assetId) return [];
	return transcript.words
		.filter(
			(word) =>
				word.sourceRole === "you" &&
				Number.isFinite(word.startSec) &&
				Number.isFinite(word.endSec) &&
				word.endSec > word.startSec &&
				word.endSec > clip.sourceStartSec &&
				word.startSec < (clip.sourceEndSec ?? durationSec),
		)
		.sort((left, right) => left.startSec - right.startSec);
}

export interface TranscriptCutWindow {
	startSec: number;
	endSec: number;
	bounded: boolean;
	pauseAllowed: boolean;
}

export function transcriptCutWindows(
	words: AxcutWord[],
	clip: AxcutClip,
	durationSec: number,
	minimumPauseSec: number,
): TranscriptCutWindow[] {
	const endSec = clip.sourceEndSec ?? durationSec;
	const windows: TranscriptCutWindow[] = [];
	let previous: AxcutWord | undefined;
	for (const word of words) {
		const startSec = Math.max(clip.sourceStartSec, previous?.endSec ?? clip.sourceStartSec);
		if (word.startSec > startSec) {
			windows.push({
				startSec,
				endSec: word.startSec,
				bounded: Boolean(previous),
				pauseAllowed:
					!previous ||
					/[.!?…]["')\]]*$/.test(previous.text.trim()) ||
					word.startSec - previous.endSec >= minimumPauseSec,
			});
		}
		if (!previous || word.endSec > previous.endSec) previous = word;
	}
	const startSec = Math.max(clip.sourceStartSec, previous?.endSec ?? clip.sourceStartSec);
	if (endSec > startSec) windows.push({ startSec, endSec, bounded: false, pauseAllowed: true });
	return windows;
}
