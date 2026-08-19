import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";
import type { RecordingSessionClip } from "../../src/lib/recordingSession";
import {
	type NativeMacCaptureHelper,
	NativeMacRecordingService,
	type NativeMacRecordingServiceDependencies,
} from "./nativeMacRecordingService";

class FakeHelper implements NativeMacCaptureHelper {
	captureBounds = null;
	output = "";
	running = true;
	pauseResult: Promise<RecordingSessionClip | undefined> = Promise.resolve(undefined);
	stopClips: RecordingSessionClip[] = [];
	waitForStart = vi.fn().mockResolvedValue(undefined);
	pause = vi.fn(() => this.pauseResult);
	reconfigure = vi.fn().mockResolvedValue(undefined);
	resume = vi.fn().mockResolvedValue(1);
	stop = vi.fn(async () => ({
		screenPath: this.stopClips[0]?.screenVideoPath ?? "",
		clips: this.stopClips,
	}));
	isRunning = vi.fn(() => this.running);
	kill = vi.fn(async () => {
		this.running = false;
	});
}

const baseRequest: NativeMacRecordingRequest = {
	schemaVersion: 1,
	recordingId: 100,
	source: { type: "display", sourceId: "screen:1:0", displayId: 1 },
	video: { fps: 60, width: 3840, height: 2160, hideSystemCursor: true },
	audio: {
		system: { enabled: false },
		microphone: { enabled: false, gain: 1 },
	},
	webcam: { enabled: false, width: 1920, height: 1080, fps: 60 },
	cursor: { mode: "editable-overlay" },
	outputs: { screenPath: "" },
};

describe("NativeMacRecordingService", () => {
	let recordingsDir: string;
	let helper: FakeHelper;
	let deps: NativeMacRecordingServiceDependencies;

	beforeEach(async () => {
		recordingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "screenrec-native-mac-"));
		helper = new FakeHelper();
		deps = {
			recordingsDir,
			now: vi.fn(() => 100),
			findHelperPath: vi.fn().mockResolvedValue("/tmp/helper"),
			createHelper: vi.fn(() => helper),
			resolveCapture: (request, recordingId, outputPath) => ({
				config: {
					...request,
					recordingId,
					outputs: { screenPath: outputPath },
				},
				cursorCaptureMode: request.cursor.mode,
			}),
			prepareCapturePermissions: vi.fn().mockResolvedValue(undefined),
			startCursor: vi.fn().mockResolvedValue(true),
			stopCursor: vi.fn().mockResolvedValue(undefined),
			clearCursor: vi.fn(),
			finalizeCursor: vi.fn().mockResolvedValue(undefined),
			registerMediaLinks: vi.fn().mockResolvedValue(undefined),
			onSessionStored: vi.fn(),
			onRecordingStateChange: vi.fn(),
			onFatalError: vi.fn(),
		};
	});

	afterEach(async () => {
		await fs.rm(recordingsDir, { recursive: true, force: true });
	});

	it("applies changed paused settings before it continues with the next clip", async () => {
		const clip = { index: 0, screenVideoPath: "/tmp/clip-1.mp4", durationMs: 1000 };
		helper.pauseResult = Promise.resolve(clip);
		const service = new NativeMacRecordingService(deps);
		await expect(service.start(baseRequest)).resolves.toMatchObject({ success: true });
		await expect(service.pause()).resolves.toMatchObject({ success: true, clip });

		const changedRequest: NativeMacRecordingRequest = {
			...baseRequest,
			source: { type: "display", sourceId: "screen:2:0", displayId: 2 },
			audio: {
				system: { enabled: true },
				microphone: { enabled: true, deviceName: "Studio Mic", gain: 1.5 },
			},
			cursor: { mode: "system" },
		};
		await expect(service.resume(changedRequest)).resolves.toEqual({ success: true, clipIndex: 1 });

		expect(helper.reconfigure).toHaveBeenCalledOnce();
		expect(helper.reconfigure).toHaveBeenCalledWith(
			expect.objectContaining({
				source: expect.objectContaining({ displayId: 2 }),
				audio: expect.objectContaining({
					system: { enabled: true },
					microphone: expect.objectContaining({ deviceName: "Studio Mic" }),
				}),
				cursor: { mode: "system" },
			}),
		);
		expect(helper.resume).toHaveBeenCalledOnce();
	});

	it("serializes Continue behind an in-flight Pause", async () => {
		let finishPause: ((clip: RecordingSessionClip) => void) | undefined;
		helper.pauseResult = new Promise((resolve) => {
			finishPause = resolve;
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		const pause = service.pause();
		const resume = service.resume(baseRequest);

		await Promise.resolve();
		expect(helper.resume).not.toHaveBeenCalled();
		finishPause?.({ index: 0, screenVideoPath: "/tmp/clip-1.mp4", durationMs: 500 });
		await pause;
		await resume;
		expect(helper.resume).toHaveBeenCalledOnce();
	});

	it("does not reconfigure an unchanged paused setup", async () => {
		helper.pauseResult = Promise.resolve({
			index: 0,
			screenVideoPath: "/tmp/clip-1.mp4",
			durationMs: 500,
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();

		await expect(service.resume(baseRequest)).resolves.toEqual({ success: true, clipIndex: 1 });
		expect(helper.reconfigure).not.toHaveBeenCalled();
	});

	it("serializes Stop behind an in-flight Pause", async () => {
		let finishPause: ((clip: RecordingSessionClip) => void) | undefined;
		const clip = { index: 0, screenVideoPath: "/tmp/clip-1.mp4", durationMs: 500 };
		helper.pauseResult = new Promise((resolve) => {
			finishPause = resolve;
		});
		helper.stopClips = [clip];
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		const pause = service.pause();
		const stop = service.stop();

		await Promise.resolve();
		expect(helper.stop).not.toHaveBeenCalled();
		finishPause?.(clip);
		await pause;
		await expect(stop).resolves.toMatchObject({ success: true });
		expect(helper.stop).toHaveBeenCalledOnce();
	});

	it("serializes overlapping Start calls and creates only one helper", async () => {
		let finishStart: (() => void) | undefined;
		helper.waitForStart = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishStart = resolve;
				}),
		);
		const service = new NativeMacRecordingService(deps);
		const first = service.start(baseRequest);
		const second = service.start(baseRequest);

		await vi.waitFor(() => expect(deps.createHelper).toHaveBeenCalledOnce());
		finishStart?.();
		await expect(first).resolves.toMatchObject({ success: true });
		await expect(second).resolves.toEqual({
			success: false,
			error: "Native macOS capture is already running.",
		});
		expect(deps.createHelper).toHaveBeenCalledOnce();
	});

	it("discards every output and kills the helper when graceful Stop fails", async () => {
		const service = new NativeMacRecordingService(deps);
		const started = await service.start(baseRequest);
		const outputPath = started.path as string;
		const manifestPath = path.join(recordingsDir, "recording-100.session.json");
		await fs.writeFile(outputPath, "partial");
		await fs.writeFile(`${outputPath}.cursor.json`, "cursor");
		await fs.writeFile(manifestPath, "{}");
		helper.stop.mockRejectedValueOnce(new Error("stop timeout"));

		await expect(service.stop(true)).resolves.toEqual({ success: true, discarded: true });
		expect(helper.kill).toHaveBeenCalled();
		await expect(fs.access(outputPath)).rejects.toThrow();
		await expect(fs.access(`${outputPath}.cursor.json`)).rejects.toThrow();
		await expect(fs.access(manifestPath)).rejects.toThrow();
	});

	it("discovers and removes the active later clip when discard Stop fails", async () => {
		const service = new NativeMacRecordingService(deps);
		const started = await service.start(baseRequest);
		const firstPath = started.path as string;
		const secondPath = path.join(recordingsDir, "recording-100-clip-0002.mp4");
		helper.pauseResult = Promise.resolve({
			index: 0,
			screenVideoPath: firstPath,
			durationMs: 500,
		});
		await service.pause();
		await service.resume(baseRequest);
		await fs.writeFile(secondPath, "active partial clip");
		await fs.writeFile(`${secondPath}.cursor.json`, "cursor");
		helper.stop.mockRejectedValueOnce(new Error("stop timeout"));

		await expect(service.stop(true)).resolves.toEqual({ success: true, discarded: true });
		await expect(fs.access(secondPath)).rejects.toThrow();
		await expect(fs.access(`${secondPath}.cursor.json`)).rejects.toThrow();
	});

	it("keeps the system cursor when editable cursor telemetry cannot start", async () => {
		vi.mocked(deps.startCursor).mockResolvedValueOnce(false);
		const service = new NativeMacRecordingService(deps);

		await expect(service.start(baseRequest)).resolves.toMatchObject({ success: true });
		expect(deps.createHelper).toHaveBeenCalledWith(
			"/tmp/helper",
			expect.objectContaining({
				video: expect.objectContaining({ hideSystemCursor: false }),
				cursor: { mode: "system" },
			}),
			expect.any(Function),
		);
		await service.stop(true);
	});

	it("falls back to the system cursor before reconfiguring a resumed clip", async () => {
		const systemRequest: NativeMacRecordingRequest = {
			...baseRequest,
			video: { ...baseRequest.video, hideSystemCursor: false },
			cursor: { mode: "system" },
		};
		helper.pauseResult = Promise.resolve({
			index: 0,
			screenVideoPath: "/tmp/clip-1.mp4",
			durationMs: 500,
		});
		vi.mocked(deps.startCursor).mockResolvedValueOnce(false);
		const service = new NativeMacRecordingService(deps);
		await service.start(systemRequest);
		await service.pause();

		const changedRequest: NativeMacRecordingRequest = {
			...baseRequest,
			source: { type: "display", sourceId: "screen:2:0", displayId: 2 },
		};
		await expect(service.resume(changedRequest)).resolves.toEqual({
			success: true,
			clipIndex: 1,
		});
		expect(helper.reconfigure).toHaveBeenCalledWith(
			expect.objectContaining({
				video: expect.objectContaining({ hideSystemCursor: false }),
				cursor: { mode: "system" },
			}),
		);
		await service.stop(true);
	});

	it("keeps a valid session when optional cursor finalization fails", async () => {
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "clip-1.mp4"),
			durationMs: 500,
		};
		helper.pauseResult = Promise.resolve(clip);
		helper.stopClips = [clip];
		vi.mocked(deps.finalizeCursor).mockRejectedValueOnce(new Error("disk full"));
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();

		await expect(service.stop()).resolves.toMatchObject({
			success: true,
			warning: "Cursor data could not be saved: disk full",
		});
		expect(deps.onSessionStored).toHaveBeenCalledOnce();
		expect(deps.clearCursor).toHaveBeenCalled();
	});

	it("ignores a fatal callback from an earlier helper generation", async () => {
		const firstHelper = helper;
		const secondHelper = new FakeHelper();
		const fatalCallbacks: Array<(failure: { code: string; message: string }) => void> = [];
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, onFatalError) => {
			fatalCallbacks.push(onFatalError);
			return fatalCallbacks.length === 1 ? firstHelper : secondHelper;
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.stop(true);
		await service.start(baseRequest);

		fatalCallbacks[0]?.({ code: "old-writer", message: "old helper failed" });
		expect(deps.onFatalError).not.toHaveBeenCalled();
		await service.stop(true);
	});

	it("uses the helper's clip index after a failed Continue retry", async () => {
		const firstClip = { index: 0, screenVideoPath: "/tmp/clip-1.mp4", durationMs: 500 };
		const retriedClip = { index: 2, screenVideoPath: "/tmp/clip-3.mp4", durationMs: 400 };
		helper.pauseResult = Promise.resolve(firstClip);
		helper.resume.mockRejectedValueOnce(new Error("writer setup failed"));
		helper.resume.mockResolvedValueOnce(2);
		helper.stopClips = [firstClip, retriedClip];
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();

		await expect(service.resume(baseRequest)).resolves.toMatchObject({ success: false });
		await expect(service.resume(baseRequest)).resolves.toEqual({ success: true, clipIndex: 2 });
		await expect(service.stop()).resolves.toMatchObject({
			success: true,
			session: {
				clips: [
					{ ...firstClip, cursorCaptureMode: "editable-overlay" },
					{ ...retriedClip, cursorCaptureMode: "editable-overlay" },
				],
			},
		});
	});

	it("keeps an earlier clip when the newest clip was removed before Stop", async () => {
		const clips = [
			{ index: 0, screenVideoPath: path.join(recordingsDir, "clip-1.mp4"), durationMs: 1000 },
			{ index: 1, screenVideoPath: path.join(recordingsDir, "clip-2.mp4"), durationMs: 800 },
		];
		helper.pauseResult = Promise.resolve(clips[0]);
		helper.stopClips = clips;
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		await service.resume(baseRequest);
		helper.pauseResult = Promise.resolve(clips[1]);
		await service.pause();
		await service.removePreviousClip();

		const stopped = await service.stop();
		expect(stopped).toMatchObject({ success: true, path: clips[0].screenVideoPath });
		expect(stopped.session?.clips).toEqual([
			{ ...clips[0], cursorCaptureMode: "editable-overlay" },
			{ ...clips[1], cursorCaptureMode: "editable-overlay", removed: true },
		]);
	});
});
