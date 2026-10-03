import { describe, expect, it } from "vitest";
import { gradeBoundarySequence } from "./boundary-proof.mjs";

const baseline = Buffer.alloc(90, 80);
const flash = Buffer.alloc(90, 240);
const frames = Array.from({ length: 5 }, (_, i) => ({
	requested_time: 59.904 + (i - 2) / 60,
	observed_time: 59.904 + (i - 2) / 60,
	freshness: "settled",
}));
const sequence = {
	project_id: "clone",
	revision: "r",
	sha256: "h",
	time_base: "edited_seconds",
	source: "live",
	mode: "playback",
	fps: 60,
	frames,
};
const references = frames.map(() => baseline);
describe("boundary evidence", () => {
	it("catches a one-frame flash and passes the corrected pixel control", () => {
		expect(
			gradeBoundarySequence(sequence, [baseline, baseline, flash, baseline, baseline], references),
		).toMatchObject({ status: "failed", failures: [{ frame: 2 }] });
		expect(gradeBoundarySequence(sequence, references, references).status).toBe("passed");
	});
	it.each([
		{ source: "export" },
		{ revision: null },
		{ frames: frames.map((f, i) => ({ ...f, observed_time: f.observed_time + i * 0.1 })) },
		{ frames: frames.map((f) => ({ ...f, freshness: "possibly_stale" })) },
	])("does not let clean pixels hide missing live proof: %j", (change) => {
		expect(gradeBoundarySequence({ ...sequence, ...change }, references, references).status).toBe(
			"unavailable",
		);
	});
	it("grades pixels and timestamps independently of claims in labels", () => {
		expect(
			gradeBoundarySequence(
				{ ...sequence, label: "success, watched, no flash" },
				[baseline, flash, baseline, baseline, baseline],
				references,
			).status,
		).toBe("failed");
	});
});
