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
	it("rejects clearing an unclaimed camera and protects an attached camera passed again as an extra", async () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const recorder = streamedRecorder();
		const ledger = new NativeMacWebcamClipLedger();
		ledger.queue({
			clip: { index: 0, screenVideoPath: "/private/clip.mp4", durationMs: 1000 },
			recorder,
			webcamOffsetMs: 0,
		});
		expect(ledger.clear()).toBe(false);
		const collected = await ledger.collectKept(new Set([0]));
		ledger.markSaved(collected.webcams);
		await ledger.discardUnclaimed([recorder]);
		expect(recorder.discard).not.toHaveBeenCalled();
		expect(recorder.release).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith("[camera-ledger] Illegal transition", { event: "clear" });
		expect(log).toHaveBeenCalledWith("[camera-ledger] Illegal transition", { event: "cleanup" });
		expect(ledger.clear()).toBe(true);
		log.mockRestore();
	});
	it("shares cleanup ownership and waits for finalization before allowing Clear", async () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let finish: () => void = () => undefined;
		const closing = new Promise<void>((resolve) => {
			finish = () => resolve();
		});
		const recorder = streamedRecorder();
		vi.mocked(recorder.release).mockReturnValueOnce(closing);
		const ledger = new NativeMacWebcamClipLedger();
		ledger.queue({
			clip: { index: 0, screenVideoPath: "/private/clip.mp4", durationMs: 1000 },
			recorder,
			webcamOffsetMs: 0,
		});
		const first = ledger.releaseUnclaimed();
		const second = ledger.releaseUnclaimed();
		await vi.waitFor(() => expect(recorder.release).toHaveBeenCalledOnce());
		expect(ledger.clear()).toBe(false);
		finish();
		await Promise.all([first, second]);
		expect(recorder.release).toHaveBeenCalledOnce();
		expect(recorder.discard).not.toHaveBeenCalled();
		expect(ledger.clear()).toBe(true);
		expect(log).toHaveBeenCalledTimes(1);
		log.mockRestore();
	});
});

it("retains a failed old close across the next take and never discards that earlier take", async () => {
	const ledger = new NativeMacWebcamClipLedger();
	const old = streamedRecorder("old-camera.mp4");
	const fresh = streamedRecorder("new-camera.mp4");
	ledger.queue({
		clip: { index: 0, screenVideoPath: "/private/old.mp4", durationMs: 500 },
		recorder: old,
		webcamOffsetMs: 0,
	});
	await ledger.collectKept(new Set([0]));
	vi.mocked(old.release).mockRejectedValueOnce(new Error("close failed"));
	await expect(ledger.releaseUnclaimed()).rejects.toThrow("close failed");
	expect(ledger.clear()).toBe(false);
	expect(ledger.beginTake()).toBe(true);
	ledger.queue({
		clip: { index: 0, screenVideoPath: "/private/new.mp4", durationMs: 500 },
		recorder: fresh,
		webcamOffsetMs: 0,
	});
	expect(
		(await ledger.collectKept(new Set([0]))).webcams.map((value) => value.webcam.fileName),
	).toEqual(["new-camera.mp4"]);
	await ledger.discardUnclaimed();
	expect(old.discard).not.toHaveBeenCalled();
	expect(old.release).toHaveBeenCalledTimes(2);
	expect(fresh.discard).toHaveBeenCalledOnce();
	expect(ledger.clear()).toBe(true);
});
