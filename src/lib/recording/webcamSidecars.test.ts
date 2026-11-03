import { fixWebmDuration } from "@fix-webm-duration/fix";
import { describe, expect, it, vi } from "vitest";
import type { RecorderHandle } from "@/hooks/recorderHandle";
import { finalizeWebcamAsset, NativeMacWebcamClipLedger } from "./webcamSidecars";

vi.mock("@fix-webm-duration/fix", () => ({ fixWebmDuration: vi.fn() }));

function streamedRecorder(fileName = "recording-9-clip-0001-webcam.webm"): RecorderHandle {
	return {
		fileName,
		recorder: { state: "inactive" } as MediaRecorder,
		recordedBlobPromise: Promise.resolve(new Blob()),
		isStreaming: () => true,
		discard: vi.fn().mockResolvedValue(undefined),
		release: vi.fn().mockResolvedValue(undefined),
	};
}

describe("native macOS webcam clip ledger", () => {
	it("keeps buffered MP4 bytes unchanged without applying a WebM duration patch", async () => {
		const recorder = streamedRecorder("camera.mp4");
		recorder.isStreaming = () => false;
		recorder.recordedBlobPromise = Promise.resolve(new Blob(["mp4 fragments"]));
		const result = await finalizeWebcamAsset(recorder, "camera.mp4", 1000, "Linux");
		expect(new TextDecoder().decode(result.asset?.videoData)).toBe("mp4 fragments");
		expect(fixWebmDuration).not.toHaveBeenCalled();
	});

	it.each([
		"webm",
		"mp4",
	])("keeps attached %s cameras and discards every other recorder", async (container) => {
		const kept = streamedRecorder(`recording-9-clip-0001-webcam.${container}`);
		const removed = streamedRecorder("recording-9-clip-0002-webcam.webm");
		const unfinished = streamedRecorder();
		const ledger = new NativeMacWebcamClipLedger();

		ledger.queue({
			clip: { index: 0, screenVideoPath: "/tmp/clip-1.mp4", durationMs: 1000 },
			recorder: kept,
			webcamOffsetMs: -20,
		});
		ledger.queue({
			clip: { index: 1, screenVideoPath: "/tmp/clip-2.mp4", durationMs: 500, removed: true },
			recorder: removed,
			webcamOffsetMs: 0,
		});

		const collected = await ledger.collectKept(new Set([0]));
		expect(collected.webcams[0]?.webcam.fileName).toBe(kept.fileName);
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
