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
});
