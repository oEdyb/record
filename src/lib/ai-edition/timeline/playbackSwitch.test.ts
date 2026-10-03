import { describe, expect, it } from "vitest";
import type { AxcutClip } from "../schema";
import { assetSwitchInFlight, playingFragment } from "./playbackSwitch";

const clip = (id: string, assetId: string): AxcutClip => ({
	id,
	assetId,
	sourceStartSec: 0,
	sourceEndSec: 10,
	timelineStartSec: 0,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "user",
	reason: "",
});

describe("assetSwitchInFlight", () => {
	const clips = [clip("c1", "a1"), clip("c2", "a2")];

	it("is true when the hinted clip lives on another asset than the element on screen", () => {
		expect(assetSwitchInFlight(clips, "c2", "a1")).toBe(true);
	});

	it("is false when the hint matches the element, is unknown, or is missing", () => {
		expect(assetSwitchInFlight(clips, "c1", "a1")).toBe(false);
		expect(assetSwitchInFlight(clips, "gone", "a1")).toBe(false);
		expect(assetSwitchInFlight(clips, null, "a1")).toBe(false);
		expect(assetSwitchInFlight(clips, "c2", undefined)).toBe(false);
	});
});

describe("playingFragment", () => {
	const raw = clip("c1", "a1");
	const first = { ...raw, id: "c1_seg0", sourceEndSec: 4 };
	const second = { ...raw, id: "c1_seg1", sourceStartSec: 4.02, sourceEndSec: 6 };
	it("does not claim a future fragment within the scrub tolerance", () => {
		expect(playingFragment([first, second], [raw], 3.98, "a1", "c1")).toBe(first);
		expect(playingFragment([first, second], [raw], 4, "a1", "c1")).toBeUndefined();
		expect(playingFragment([first, second], [raw], 4.01, "a1", "c1")).toBeUndefined();
		expect(playingFragment([first, second], [raw], 4.02, "a1", "c1")).toBe(second);
	});
	it("keeps duplicate recordings scoped to their raw clip", () => {
		const twin = { ...raw, id: "c2" };
		expect(playingFragment([first, second, twin], [raw, twin], 5, "a1", "c1")).toBe(second);
		expect(playingFragment([first, second, twin], [raw, twin], 5, "a1", "c2")).toBe(twin);
		expect(playingFragment([first, second], [raw], 3, "a2", "c1")).toBeUndefined();
	});
});
