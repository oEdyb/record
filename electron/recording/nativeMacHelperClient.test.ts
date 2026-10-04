import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";
import {
	NativeMacHelperClient,
	NativeMacPauseError,
	NativeMacResumeRejectedError,
} from "./nativeMacHelperClient";

function fakeProcess(): ChildProcessWithoutNullStreams {
	const process = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		killed: false,
		kill: vi.fn(() => true),
	});
	return process as unknown as ChildProcessWithoutNullStreams;
}

function emit(process: ChildProcessWithoutNullStreams, event: Record<string, unknown>): void {
	(process.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);
}

const request = {
	schemaVersion: 1,
	recordingId: 7,
	source: { type: "display", sourceId: "screen:1:0", displayId: 1 },
	video: { fps: 60, width: 3840, height: 2160, hideSystemCursor: true },
	audio: {
		system: { enabled: false },
		microphone: { enabled: false, gain: 1 },
	},
	webcam: { enabled: false, width: 1920, height: 1080, fps: 60 },
	cursor: { mode: "editable-overlay" },
	outputs: { screenPath: "/tmp/recording-7-clip-0001.mp4" },
} satisfies NativeMacRecordingRequest;

describe("NativeMacHelperClient", () => {
	it("keeps an acknowledged paused Continue rejection retryable", async () => {
		const process = fakeProcess();
		const onFatalError = vi.fn();
		const onOriginalStarted = vi.fn();
		const client = new NativeMacHelperClient(process, { onFatalError, onOriginalStarted });
		const camera = {
			event: "original-started",
			clipIndex: 1,
			key: "webcamVideoPath",
			path: "/tmp/camera.mov",
			offsetMs: 23,
		};
		const rejected = client.resume();
		const assertion = expect(rejected).rejects.toBeInstanceOf(NativeMacResumeRejectedError);
		emit(process, camera);
		emit(process, {
			event: "error",
			code: "clip-resume-rejected",
			clipIndex: 1,
			message: "Selected source disappeared; recording remains paused.",
		});
		await assertion;
		expect(client.isRunning()).toBe(true);
		expect(onFatalError).not.toHaveBeenCalled();
		const resumed = client.resume();
		emit(process, { ...camera, offsetMs: 80.5 });
		emit(process, { event: "recording-resumed", clipIndex: 1 });
		await expect(resumed).resolves.toBe(1);
		expect(onOriginalStarted).toHaveBeenCalledTimes(2);
		expect(onOriginalStarted).toHaveBeenLastCalledWith({
			clipIndex: 1,
			key: "webcamVideoPath",
			path: "/tmp/camera.mov",
			offsetMs: 80.5,
		});
	});

	it.each([
		undefined,
		-1,
		1.5,
	])("rejects uncorrelated paused rejection index %s", async (clipIndex) => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		const resumed = client.resume();
		const assertion = expect(resumed).rejects.not.toBeInstanceOf(NativeMacResumeRejectedError);
		emit(process, {
			event: "error",
			code: "clip-resume-rejected",
			clipIndex,
			message: "Bad rollback index",
		});
		await assertion;
	});

	it("does not classify an unacknowledged clip-start failure as safely paused", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		const resumed = client.resume();
		const assertion = expect(resumed).rejects.not.toBeInstanceOf(NativeMacResumeRejectedError);
		emit(process, { event: "error", code: "clip-start-failed", message: "Writer failed" });
		await assertion;
	});

	it("accepts the paused rejection code only during the Continue operation", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		const changed = client.reconfigure(request);
		const assertion = expect(changed).rejects.not.toBeInstanceOf(NativeMacResumeRejectedError);
		emit(process, { event: "error", code: "clip-resume-rejected", message: "Wrong operation" });
		await assertion;
	});

	it("publishes first-sample original metadata once even when startup replays buffered events", async () => {
		const process = fakeProcess();
		const onOriginalStarted = vi.fn();
		const client = new NativeMacHelperClient(process, { onOriginalStarted });
		const original = {
			event: "original-started",
			clipIndex: 0,
			key: "microphoneAudioPath",
			path: "/tmp/microphone.mov",
			offsetMs: 23.5,
		};
		emit(process, original);
		emit(process, { ...original, key: "systemAudioPath", offsetMs: -1 });
		emit(process, { ...original, clipIndex: 1.5 });
		emit(process, { event: "recording-started" });
		await client.waitForStart();
		expect(onOriginalStarted).toHaveBeenCalledOnce();
		expect(onOriginalStarted).toHaveBeenCalledWith({
			clipIndex: 0,
			key: "microphoneAudioPath",
			path: "/tmp/microphone.mov",
			offsetMs: 23.5,
		});
		process.emit("close", null, "SIGKILL");
	});

	it("reports unexpected helper exit once after a confirmed recording start", async () => {
		const process = fakeProcess();
		const onFatalError = vi.fn();
		const client = new NativeMacHelperClient(process, { onFatalError });
		emit(process, { event: "recording-started" });
		await client.waitForStart();
		process.emit("error", new Error("Capture process failed"));
		process.emit("close", null, "SIGKILL");
		expect(onFatalError).toHaveBeenCalledOnce();
		expect(onFatalError).toHaveBeenCalledWith({
			code: "capture-helper-error",
			message: "Capture process failed",
		});
	});

	it("reports an abrupt helper death that has no error event", async () => {
		const process = fakeProcess();
		const onFatalError = vi.fn();
		const client = new NativeMacHelperClient(process, { onFatalError });
		emit(process, { event: "recording-started" });
		await client.waitForStart();
		process.emit("close", null, "SIGKILL");
		expect(onFatalError).toHaveBeenCalledWith({
			code: "capture-helper-exited",
			message: expect.stringContaining("SIGKILL"),
		});
	});

	it("does not report a completed Stop as an unexpected exit", async () => {
		const process = fakeProcess();
		const onFatalError = vi.fn();
		const client = new NativeMacHelperClient(process, { onFatalError });
		emit(process, { event: "recording-started" });
		await client.waitForStart();
		const stopped = client.stop({ screenPath: "/tmp/clip.mp4", clips: [] });
		emit(process, { event: "recording-stopped", screenPath: "/tmp/clip.mp4", clips: [] });
		await stopped;
		process.emit("close", 0, null);
		expect(onFatalError).not.toHaveBeenCalled();
	});

	it("rejects buffered startup success after the helper has already exited", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		emit(process, { event: "recording-started" });
		process.emit("close", 1, null);
		await expect(client.waitForStart()).rejects.toThrow("exited before start confirmation");
	});

	it("waits for exit and escalates a stuck helper to SIGKILL", async () => {
		vi.useFakeTimers();
		try {
			const process = fakeProcess();
			vi.mocked(process.kill).mockImplementation((signal) => {
				if (signal === "SIGKILL") process.emit("close", null, "SIGKILL");
				return true;
			});
			const client = new NativeMacHelperClient(process);
			const killed = client.kill();

			expect(process.kill).toHaveBeenCalledWith("SIGTERM");
			await vi.advanceTimersByTimeAsync(1_000);
			expect(process.kill).toHaveBeenCalledWith("SIGKILL");
			await expect(killed).resolves.toBeUndefined();
			expect(client.isRunning()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("replays a fast start event and keeps the helper capture bounds", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		emit(process, {
			event: "recording-started",
			captureBounds: { x: 10, y: 20, width: 800, height: 600 },
		});

		await expect(client.waitForStart()).resolves.toBeUndefined();
		expect(client.captureBounds).toEqual({ x: 10, y: 20, width: 800, height: 600 });
	});

	it("registers Pause before writing and returns the finalized clip", async () => {
		const process = fakeProcess();
		const write = vi.spyOn(process.stdin, "write");
		const client = new NativeMacHelperClient(process);
		const paused = client.pause();

		expect(write).toHaveBeenCalledWith("pause\n");
		emit(process, {
			event: "clip-finalized",
			clip: { index: 0, screenVideoPath: "/tmp/clip.mp4", durationMs: 1234 },
		});
		emit(process, { event: "recording-paused" });

		await expect(paused).resolves.toMatchObject({ index: 0, durationMs: 1234 });
	});

	it("reports whether a Pause failure left the helper paused", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		const paused = client.pause();
		emit(process, { event: "error", code: "clip-finalize-failed", message: "writer failed" });

		await expect(paused).rejects.toMatchObject({
			name: "NativeMacPauseError",
			helperPaused: true,
		});
		expect(await paused.catch((error) => error)).toBeInstanceOf(NativeMacPauseError);
	});

	it("keeps a committed clip when its closing frame fails during Pause", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		const clip = { index: 0, screenVideoPath: "/tmp/clip.mp4", durationMs: 1234 };
		const paused = client.pause();
		emit(process, { event: "clip-finalized", clip });
		emit(process, {
			event: "error",
			code: "clip-finalize-failed",
			message: "Closing frame timed out; committed frames kept",
		});
		await expect(paused).rejects.toMatchObject({
			name: "NativeMacPauseError",
			helperPaused: true,
			clip,
			message: "Closing frame timed out; committed frames kept",
		});
	});

	it("returns a closing-frame warning alongside the durable clips at Stop", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		const clip = { index: 0, screenVideoPath: "/tmp/clip.mp4", durationMs: 1234 };
		const warning = {
			code: "final-screen-frame-failed",
			message: "Closing frame timed out; committed frames kept",
		};
		const stopped = client.stop({ screenPath: clip.screenVideoPath, clips: [clip] });
		emit(process, {
			event: "recording-stopped",
			screenPath: clip.screenVideoPath,
			clips: [clip],
			warning,
		});
		await expect(stopped).resolves.toEqual({
			screenPath: clip.screenVideoPath,
			clips: [clip],
			warning,
		});
	});

	it("sends reconfiguration before Continue and waits for both acknowledgements", async () => {
		const process = fakeProcess();
		const writes: string[] = [];
		process.stdin.on("data", (chunk) => writes.push(chunk.toString()));
		const client = new NativeMacHelperClient(process);

		const reconfigured = client.reconfigure(request);
		expect(writes[0]).toContain('"command":"reconfigure"');
		emit(process, { event: "recording-reconfigured" });
		await reconfigured;

		const resumed = client.resume();
		expect(writes[1]).toBe("resume\n");
		emit(process, { event: "recording-resumed", clipIndex: 1 });
		await expect(resumed).resolves.toBe(1);
	});

	it("reports an unexpected stream stop once and replays its completed result to late Stop", async () => {
		const process = fakeProcess();
		const write = vi.spyOn(process.stdin, "write");
		const onFatalError = vi.fn();
		const client = new NativeMacHelperClient(process, { onFatalError });
		const clip = { index: 0, screenVideoPath: "/tmp/clip.mp4", durationMs: 1_234 };

		emit(process, {
			event: "error",
			code: "capture-stopped-with-error",
			message: "Display disconnected",
		});
		emit(process, {
			event: "recording-stopped",
			screenPath: clip.screenVideoPath,
			clips: [clip],
		});
		emit(process, {
			event: "error",
			code: "capture-stopped-with-error",
			message: "duplicate terminal callback",
		});

		expect(onFatalError).toHaveBeenCalledOnce();
		expect(onFatalError).toHaveBeenCalledWith({
			code: "capture-stopped-with-error",
			message: "Display disconnected",
		});
		await expect(client.stop({ screenPath: "/tmp/fallback.mp4", clips: [] })).resolves.toEqual({
			screenPath: clip.screenVideoPath,
			clips: [clip],
		});
		expect(write).not.toHaveBeenCalledWith("stop\n");
	});

	it.each([
		"writerBackpressureEvents",
		"repeatedVideoFrames",
		"completeSourceVideoFps",
		"appendedCameraFrames",
		"originalBackpressureEvents",
		"originalMaxQueueDepth",
		"completeSourceCameraFps",
		"cameraSamples",
		"cameraDroppedFrames",
		"deliveredCameraFps",
	])("rejects invalid optional metric %s", async (field) => {
		for (const invalid of [-1, Number.POSITIVE_INFINITY, "60"]) {
			const process = fakeProcess();
			const client = new NativeMacHelperClient(process);
			const stopped = client.stop({ screenPath: "/tmp/fallback.mp4", clips: [] });
			const required = Object.fromEntries(
				[
					"requestedVideoFps",
					"deliveredVideoFps",
					"screenSamples",
					"completeScreenSamples",
					"idleScreenSamples",
					"blankScreenSamples",
					"suspendedScreenSamples",
					"startedScreenSamples",
					"stoppedScreenSamples",
					"otherScreenSamples",
					"appendedVideoFrames",
					"pendingVideoFrames",
					"appendFailures",
					"droppedVideoFrames",
					"systemAudioSamples",
					"microphoneAudioSamples",
				].map((key) => [key, 0]),
			);
			emit(process, {
				event: "recording-stopped",
				screenPath: "/tmp/clip.mp4",
				clips: [],
				telemetry: { ...required, lowPowerMode: false, thermalState: "nominal", [field]: invalid },
			});
			await expect(stopped).resolves.not.toHaveProperty("telemetry");
		}
	});
	it("parses bounded capture telemetry from the stopped event", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		const stopped = client.stop({ screenPath: "/tmp/fallback.mp4", clips: [] });
		const summary = { count: 3, min: -2, max: 4, mean: 1, p50: 1, p95: 3, p99: 4 };

		emit(process, {
			event: "recording-stopped",
			screenPath: "/tmp/clip.mp4",
			clips: [],
			telemetry: {
				requestedVideoFps: 60,
				deliveredVideoFps: 59.7,
				screenSamples: 600,
				completeScreenSamples: 594,
				idleScreenSamples: 2,
				blankScreenSamples: 1,
				suspendedScreenSamples: 1,
				startedScreenSamples: 1,
				stoppedScreenSamples: 0,
				otherScreenSamples: 1,
				appendedVideoFrames: 593,
				pendingVideoFrames: 3,
				appendFailures: 1,
				droppedVideoFrames: 7,
				systemAudioSamples: 500,
				microphoneAudioSamples: 480,
				audioMaxQueueBytes: 3_840,
				writerMaxQueueDepth: 4,
				writerBackpressureEvents: 2,
				repeatedVideoFrames: 7,
				completeSourceVideoFps: 58.25,
				appendedCameraFrames: 300,
				originalBackpressureEvents: 3,
				originalMaxQueueDepth: 2,
				completeSourceCameraFps: 29.94,
				cameraSamples: 305,
				cameraDroppedFrames: 5,
				deliveredCameraFps: 30,
				lowPowerMode: false,
				thermalState: "nominal",
				systemAudioDriftMs: summary,
				screenTimestampDriftMs: summary,
				screenDeliveryAgeMs: summary,
				completeScreenIntervalMs: summary,
				microphoneDriftMs: summary,
				fragmentFinalizeMs: summary,
				audioBlockMs: summary,
			},
		});

		await expect(stopped).resolves.toMatchObject({
			telemetry: {
				requestedVideoFps: 60,
				deliveredVideoFps: 59.7,
				droppedVideoFrames: 7,
				audioMaxQueueBytes: 3_840,
				writerMaxQueueDepth: 4,
				writerBackpressureEvents: 2,
				repeatedVideoFrames: 7,
				completeSourceVideoFps: 58.25,
				appendedCameraFrames: 300,
				originalBackpressureEvents: 3,
				originalMaxQueueDepth: 2,
				completeSourceCameraFps: 29.94,
				cameraSamples: 305,
				cameraDroppedFrames: 5,
				deliveredCameraFps: 30,
				thermalState: "nominal",
				systemAudioDriftMs: summary,
				screenTimestampDriftMs: summary,
				screenDeliveryAgeMs: summary,
				completeScreenIntervalMs: summary,
			},
		});
	});

	it("ignores malformed capture telemetry instead of trusting partial data", async () => {
		const process = fakeProcess();
		const client = new NativeMacHelperClient(process);
		const stopped = client.stop({ screenPath: "/tmp/fallback.mp4", clips: [] });

		emit(process, {
			event: "recording-stopped",
			screenPath: "/tmp/clip.mp4",
			clips: [],
			telemetry: {
				requestedVideoFps: 60,
				deliveredVideoFps: Number.NaN,
			},
		});

		await expect(stopped).resolves.not.toHaveProperty("telemetry");
	});
});
