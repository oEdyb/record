import { describe, expect, it } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { buildCleanCutReview } from "./reviewModel";
import { type CleanCutRegion, EMPTY_CLEAN_CUT_SNAPSHOT } from "./types";

const clip = {
	id: "c",
	assetId: "a",
	sourceStartSec: 0,
	sourceEndSec: 100,
	timelineStartSec: 0,
	timelineEndSec: 100,
	wordRefs: [],
	origin: "system",
	reason: "",
} as AxcutClip;

const region = (id: string, start: number, end: number): CleanCutRegion => ({
	id,
	kind: "pause",
	assetId: "a",
	removedStartSec: start,
	removedEndSec: end,
	words: [],
	reason: "",
	sources: ["rule"],
	risky: false,
});

describe("buildCleanCutReview", () => {
	it("keeps a cut that runs past the end of its clip, counting only what the clip shows", () => {
		const snapshot = {
			...EMPTY_CLEAN_CUT_SNAPSHOT,
			state: "ready" as const,
			keep: [{ assetId: "a", startSec: 0, endSec: 98.5 }],
			regions: [region("end", 98.5, 100.02)],
		};
		const model = buildCleanCutReview(snapshot, [clip], "clean", new Set());
		expect(model.strip).toHaveLength(1);
		expect(model.strip[0].rawEndSec).toBe(100);
		expect(model.strip[0].removedSec).toBeCloseTo(1.5);
	});
});
