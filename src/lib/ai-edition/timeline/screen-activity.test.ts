import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "@/native/contracts";
import { buildScreenActivitySpans } from "./screen-activity";

const empty: CursorRecordingData = { version: 1, provider: "native", samples: [], assets: [] };

describe("screen activity protection", () => {
	it("protects clicks, mouse releases, and keyboard timing", () => {
		const spans = buildScreenActivitySpans(
			{
				...empty,
				samples: [
					{ timeMs: 1_000, cx: 0.2, cy: 0.2, interactionType: "click" },
					{ timeMs: 1_150, cx: 0.5, cy: 0.2, interactionType: "mouseup" },
				],
				keyboardActivity: [{ timeMs: 2_000, cx: 0.5, cy: 0.5, count: 2 }],
			},
			4,
		);
		expect(spans.some((span) => span.startSec < 1 && span.endSec > 1.15)).toBe(true);
		expect(spans.some((span) => span.startSec < 2 && span.endSec > 2)).toBe(true);
	});

	it("protects meaningful pointer travel but ignores jitter", () => {
		const moving = buildScreenActivitySpans(
			{
				...empty,
				samples: [
					{ timeMs: 1_000, cx: 0.2, cy: 0.2, interactionType: "move" },
					{ timeMs: 1_100, cx: 0.25, cy: 0.2, interactionType: "move" },
				],
			},
			3,
		);
		const jitter = buildScreenActivitySpans(
			{
				...empty,
				samples: [
					{ timeMs: 1_000, cx: 0.2, cy: 0.2, interactionType: "move" },
					{ timeMs: 1_100, cx: 0.201, cy: 0.2, interactionType: "move" },
				],
			},
			3,
		);
		expect(moving).not.toHaveLength(0);
		expect(jitter).toHaveLength(0);
	});
});
