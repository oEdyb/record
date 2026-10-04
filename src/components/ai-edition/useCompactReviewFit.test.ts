// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { useCompactReviewFit } from "./useCompactReviewFit";

vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({ settings: { aspectRatio: "native", outputResolution: null } }),
}));

function recording(width: number, height: number): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_1",
			title: "Recording",
			createdAt: "2026-10-04T10:00:00Z",
			updatedAt: "2026-10-04T10:00:00Z",
			primaryAssetId: "screen",
		},
		assets: [
			{
				kind: "video",
				id: "screen",
				label: "screen",
				originalPath: "/tmp/screen.mp4",
				cameraTrack: null,
				video: { codec: "h264", width, height, fps: 60 },
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip",
					assetId: "screen",
					sourceStartSec: 0,
					sourceEndSec: 5,
					timelineStartSec: 0,
					timelineEndSec: 5,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
}

describe("useCompactReviewFit", () => {
	const fitReviewWindow = vi.fn(async () => true);

	beforeEach(() => {
		vi.useFakeTimers();
		window.electronAPI = { ...window.electronAPI, fitReviewWindow };
	});
	afterEach(() => {
		vi.useRealTimers();
		fitReviewWindow.mockClear();
	});

	it("waits for the recording's real size instead of fitting a 16:9 guess", () => {
		const { rerender } = renderHook(({ doc }) => useCompactReviewFit(true, doc), {
			initialProps: { doc: recording(0, 0) },
		});
		vi.advanceTimersByTime(50);
		expect(fitReviewWindow).not.toHaveBeenCalled();

		rerender({ doc: recording(3420, 2214) });
		vi.advanceTimersByTime(50);
		expect(fitReviewWindow).toHaveBeenCalledTimes(1);
		expect(fitReviewWindow).toHaveBeenCalledWith(
			expect.objectContaining({ aspectRatio: 3420 / 2214 }),
		);
	});
});
