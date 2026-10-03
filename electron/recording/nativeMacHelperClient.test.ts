import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";
import { NativeMacHelperClient, NativeMacPauseError } from "./nativeMacHelperClient";

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
				lowPowerMode: false,
				thermalState: "nominal",
				systemAudioDriftMs: summary,
				screenTimestampDriftMs: summary,
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
				thermalState: "nominal",
				systemAudioDriftMs: summary,
				screenTimestampDriftMs: summary,
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
