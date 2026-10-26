import { describe, expect, it } from "vitest";
import { LinuxClipCaptureMetadata } from "./linuxClipCaptureMetadata";

describe("Linux clip capture metadata", () => {
	it("keeps the portal source unknown until reported and records the selected encoder", () => {
		const metadata = new LinuxClipCaptureMetadata(10, 1_000);
		expect(metadata.sourceKind).toBeUndefined();
		metadata.observe({ event: "source-selected", sourceKind: "window" });
		metadata.observe({ event: "encoder-selection", video: "nvenc", rejected: [] });
		expect(metadata.sourceKind).toBe("window");
		expect(metadata.videoEncoder).toBe("nvenc");
	});

	it("normalizes and bounds cursor samples from the same helper without another portal", () => {
		const metadata = new LinuxClipCaptureMetadata(2, 1_000);
		const sample = {
			event: "cursor-sample",
			timestampMs: 1_100,
			x: 50,
			y: 20,
			width: 100,
			height: 80,
			visible: true,
		};
		metadata.observe(sample);
		metadata.observe({ ...sample, timestampMs: 1_200 });
		metadata.observe({ ...sample, timestampMs: 1_300 });
		metadata.observe({ ...sample, timestampMs: Number.NaN });
		metadata.observe({ ...sample, width: 0 });
		expect(metadata.cursor.toRecordingData().samples).toEqual([
			{ timeMs: 200, cx: 0.5, cy: 0.25, visible: true, interactionType: "move" },
			{ timeMs: 300, cx: 0.5, cy: 0.25, visible: true, interactionType: "move" },
		]);
	});
});
