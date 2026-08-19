import { describe, expect, it, vi } from "vitest";
import type { RecorderHandle } from "@/hooks/recorderHandle";
import { NativeMacWebcamClipLedger } from "./webcamSidecars";

function streamedRecorder(): RecorderHandle {
	return {
		recorder: { state: "inactive" } as MediaRecorder,
		recordedBlobPromise: Promise.resolve(new Blob()),
		isStreaming: () => true,
		discard: vi.fn().mockResolvedValue(undefined),
	};
}

describe("native macOS webcam clip ledger", () => {
	it("keeps only attached camera recorders and discards every other recorder", async () => {
		const kept = streamedRecorder();
		const removed = streamedRecorder();
		const unfinished = streamedRecorder();
		const ledger = new NativeMacWebcamClipLedger();

		ledger.queue({
			recordingId: 9,
			clip: { index: 0, screenVideoPath: "/tmp/clip-1.mp4", durationMs: 1000 },
			recorder: kept,
			webcamOffsetMs: -20,
		});
		ledger.queue({
			recordingId: 9,
			clip: { index: 1, screenVideoPath: "/tmp/clip-2.mp4", durationMs: 500, removed: true },
			recorder: removed,
			webcamOffsetMs: 0,
		});

		const collected = await ledger.collectKept(new Set([0]));
		expect(collected.webcams).toMatchObject([
			{ clipIndex: 0, durationMs: 1020, webcamOffsetMs: -20 },
		]);
		ledger.markSaved(collected.webcams);
		await ledger.discardUnclaimed([unfinished]);

		expect(kept.discard).not.toHaveBeenCalled();
		expect(removed.discard).toHaveBeenCalledOnce();
		expect(unfinished.discard).toHaveBeenCalledOnce();
	});
});
