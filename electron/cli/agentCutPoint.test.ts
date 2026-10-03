// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cutPointCommandInput, cutPointRemovalOperation } from "./agentCutPoint";

describe("agent cutpoint phase-4 input", () => {
	it("takes --accept as a mandatory reason string", () => {
		const base = { project_id: "p", clip: "c", time: 20, edge: "out" as const };
		expect(
			cutPointCommandInput.parse({ ...base, accept: "mid-sentence tail", request_id: "r" }),
		).toMatchObject({ accept: "mid-sentence tail", request_id: "r" });
		expect(cutPointCommandInput.parse(base).accept).toBeUndefined();
		expect(() => cutPointCommandInput.parse({ ...base, accept: " " })).toThrow();
	});
});

describe("cutPointRemovalOperation", () => {
	const clip = { sourceStartSec: 0, sourceEndSec: 20 };
	it("removes the tail after an out cut", () => {
		expect(cutPointRemovalOperation({ clipId: "c", edge: "out", cutSec: 8 }, clip)).toEqual({
			type: "addTrim",
			args: { clipId: "c", startSec: 8, endSec: 20, reason: "Cut point out at 8s" },
		});
	});
	it("removes the head before an in cut", () => {
		expect(cutPointRemovalOperation({ clipId: "c", edge: "in", cutSec: 3 }, clip)).toEqual({
			type: "addTrim",
			args: { clipId: "c", startSec: 0, endSec: 3, reason: "Cut point in at 3s" },
		});
	});
	it("stages nothing when the cut leaves less than the lane minimum", () => {
		expect(cutPointRemovalOperation({ clipId: "c", edge: "out", cutSec: 19.99 }, clip)).toBeNull();
		expect(cutPointRemovalOperation({ clipId: "c", edge: "in", cutSec: 0.01 }, clip)).toBeNull();
	});
});
