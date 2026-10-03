import type { AxcutDocument, AxcutWord } from "../schema";
import { createEmptyDocument } from "../schema";

export function editFixture(
	options: {
		duration?: number;
		trims?: [number, number][];
		cameras?: { id: string; start: number; end: number; mode?: "fullscreen" | "emphasis" }[];
		words?: AxcutWord[];
	} = {},
): AxcutDocument {
	const duration = options.duration ?? 20;
	const document = createEmptyDocument({
		projectId: "project",
		title: "Fixture",
		createdAt: "2026-09-18T00:00:00Z",
	});
	document.assets = [
		{
			id: "asset",
			kind: "video",
			label: "Take one",
			originalPath: "/take.mp4",
			durationSec: duration,
			cameraTrack: { sourcePath: "/camera.mp4", startMs: 0, offsetMs: 0, visible: true },
		},
	];
	document.timeline.clips = [
		{
			id: "clip",
			assetId: "asset",
			sourceStartSec: 0,
			sourceEndSec: duration,
			timelineStartSec: 0,
			timelineEndSec: duration,
			origin: "user",
			reason: "",
			wordRefs: [],
		},
	];
	document.timeline.trimRanges = (options.trims ?? []).map(([startSec, endSec], index) => ({
		id: `trim_${index}`,
		clipId: "clip",
		assetId: "asset",
		startSec,
		endSec,
		origin: "user",
		reason: "editorial",
	}));
	document.legacyEditor = {
		cameraFullscreenRegions: (options.cameras ?? []).map((region) => ({
			id: region.id,
			startMs: region.start * 1000,
			endMs: region.end * 1000,
			mode: region.mode,
			source: "manual",
			clipId: "clip",
			sourceStartSec: region.start,
			sourceEndSec: region.end,
		})),
	};
	if (options.words)
		document.transcripts = [
			{
				assetId: "asset",
				language: "en",
				segments: [],
				words: options.words,
				sources: [],
				evidenceStatus: "legacy-unverified",
			},
		];
	return document;
}
export function word(text: string, startSec: number, endSec: number): AxcutWord {
	return {
		id: `word_${startSec}`,
		segmentId: "sentence",
		startSec,
		endSec,
		text,
		sourceRole: "unknown-mixed",
	};
}
