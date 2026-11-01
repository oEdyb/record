import type { PlannedItem } from "../export/sourceTimeline";

export const CLEAN_AUDIO_RATE = 48_000;
export const SAMPLES_PER_FRAME = 800;

function sourceSample(item: Extract<PlannedItem, { type: "clip" }>) {
	return item.screenStartSec === undefined
		? item.start * SAMPLES_PER_FRAME
		: Math.round((item.screenStartSec - item.offsetSec) * CLEAN_AUDIO_RATE);
}

export type CleanAudioPiece =
	| { type: "gap"; outSample: number; samples: number }
	| { type: "source"; outSample: number; samples: number; file: string; sourceSample: number };

export interface CleanAudioSeam {
	outSample: number;
	fadeSamples: number;
	mode: "blend" | "hard-edge";
	left: number;
	right: number;
}

export interface CleanAudioPlan {
	sampleRate: number;
	totalSamples: number;
	pieces: CleanAudioPiece[];
	seams: CleanAudioSeam[];
}

/** Retained items describe project edits before the clean cut, so handles cannot undo them. */
export function planCleanAudio(
	items: PlannedItem[],
	retained: PlannedItem[],
	neighborGaps?: (outSample: number) => readonly [number, number] | undefined,
): CleanAudioPlan {
	let totalSamples = 0;
	const pieces: CleanAudioPiece[] = items.map((item) => {
		const outSample = totalSamples;
		const samples = item.duration * SAMPLES_PER_FRAME;
		totalSamples += samples;
		return item.type === "gap"
			? { type: "gap", outSample, samples }
			: {
					type: "source",
					outSample,
					samples,
					file: item.file,
					sourceSample: sourceSample(item),
				};
	});
	const allowed = new Map<string, Array<{ start: number; end: number }>>();
	for (const item of retained) {
		if (item.type === "gap") continue;
		const ranges = allowed.get(item.file) ?? [];
		ranges.push({
			start: sourceSample(item),
			end: sourceSample(item) + item.duration * SAMPLES_PER_FRAME,
		});
		allowed.set(item.file, ranges);
	}
	for (const [file, ranges] of allowed) {
		const merged: typeof ranges = [];
		for (const range of ranges.sort((a, b) => a.start - b.start)) {
			const previous = merged.at(-1);
			if (previous && previous.end >= range.start) previous.end = Math.max(previous.end, range.end);
			else merged.push({ ...range });
		}
		allowed.set(file, merged);
	}
	const contains = (piece: CleanAudioPiece, from: number, to: number) =>
		piece.type === "source" &&
		(allowed.get(piece.file) ?? []).some((range) => from >= range.start && to <= range.end);
	const seams: CleanAudioSeam[] = [];
	for (let right = 1; right < pieces.length; right++) {
		const a = pieces[right - 1];
		const b = pieces[right];
		if (a.type === "gap" && b.type === "gap") continue;
		if (
			a.type === "source" &&
			b.type === "source" &&
			a.file === b.file &&
			a.sourceSample + a.samples === b.sourceSample
		)
			continue;
		const gaps = neighborGaps?.(b.outSample);
		const desiredFade = gaps
			? Math.max(144, Math.min(1440, Math.floor(Math.min(...gaps) / 2)))
			: 960;
		const fadeSamples = Math.min(desiredFade, Math.floor(a.samples / 3), Math.floor(b.samples / 3));
		const before = Math.floor(fadeSamples / 2);
		const after = fadeSamples - before;
		const aOut = a.type === "source" ? a.sourceSample + a.samples : 0;
		const blend =
			a.type === "source" &&
			b.type === "source" &&
			contains(a, aOut - before, aOut + after) &&
			contains(b, b.sourceSample - before, b.sourceSample + after);
		seams.push({
			outSample: b.outSample,
			fadeSamples: blend ? fadeSamples : Math.min(144, fadeSamples),
			mode: blend ? "blend" : "hard-edge",
			left: right - 1,
			right,
		});
	}
	return { sampleRate: CLEAN_AUDIO_RATE, totalSamples, pieces, seams };
}
