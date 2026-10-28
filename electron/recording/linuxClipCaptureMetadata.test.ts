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

	it("tracks only the granted PipeWire node and clears it after source replacement", () => {
		const metadata = new LinuxClipCaptureMetadata(10, 1_000);
		metadata.observe({ event: "source-selected", nodeId: 91 });
		expect(metadata.pipeWireNodeId).toBe(91);
		metadata.observe({ event: "cursor-sample", nodeId: 99 });
		expect(metadata.pipeWireNodeId).toBe(91);
		metadata.observe({ event: "source-reselected" });
		expect(metadata.pipeWireNodeId).toBeUndefined();
		metadata.observe({ event: "source-reselected", nodeId: 92, sourceKind: "monitor" });
		expect(metadata.sourceKind).toBe("monitor");
		expect(metadata.pipeWireNodeId).toBe(92);
		metadata.observe({ event: "stream-started", nodeId: -1 });
		expect(metadata.pipeWireNodeId).toBeUndefined();
	});

	it("clears a stale window exemption when replacement kind is unknown", () => {
		const metadata = new LinuxClipCaptureMetadata(10, 1_000);
		metadata.observe({ event: "source-selected", nodeId: 91, sourceKind: "window" });
		metadata.observe({ event: "source-reselected", nodeId: 92, sourceKind: null });
		expect(metadata.pipeWireNodeId).toBe(92);
		expect(metadata.sourceKind).toBeUndefined();
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
