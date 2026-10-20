import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	NativeMacOriginalStarted,
	NativeMacRecordingRequest,
} from "../../src/lib/nativeMacRecording";
import type { RecordingSessionClip } from "../../src/lib/recordingSession";
import { inspectHandoffSourceMedia } from "../export/sourceHandoffMedia";
import {
	NativeMacHelperClient,
	NativeMacPauseError,
	NativeMacResumeRejectedError,
} from "./nativeMacHelperClient";
import {
	type NativeMacCaptureHelper,
	NativeMacRecordingService,
	type NativeMacRecordingServiceDependencies,
} from "./nativeMacRecordingService";
import {
	nativeMacRecoveryJournalPath,
	restoreNativeMacRecoverySession,
} from "./nativeMacRecoveryJournal";

vi.mock("../export/sourceHandoffMedia", () => ({ inspectHandoffSourceMedia: vi.fn() }));

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
		vi.mocked(inspectHandoffSourceMedia).mockReset();
		vi.mocked(inspectHandoffSourceMedia).mockResolvedValue({
			hasAudio: false,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 0.5,
			video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
		});
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
			onAppStopped: vi.fn(),
		};
	});

	afterEach(async () => {
		await fs.rm(recordingsDir, { recursive: true, force: true });
	});

	it("reattaches a readable original fragment when finalization returns only the committed screen", async () => {
		let reportOriginal: ((original: NativeMacOriginalStarted) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, _fatal, callback) => {
			reportOriginal = callback;
			return helper;
		});
		const stem = path.join(recordingsDir, "recording-100-clip-0001");
		await fs.writeFile(`${stem}.mp4`, "screen");
		await fs.writeFile(`${stem}-microphone.mov`, "readable fragment");
		vi.mocked(inspectHandoffSourceMedia).mockResolvedValue({
			video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
			hasAudio: true,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 1,
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		reportOriginal?.({
			clipIndex: 0,
			key: "microphoneAudioPath",
			path: `${stem}-microphone.mov`,
			offsetMs: 22.5,
		});
		helper.stopClips = [{ index: 0, screenVideoPath: `${stem}.mp4`, durationMs: 1020 }];
		const result = await service.stop();
		expect(result.session?.clips?.[0]).toMatchObject({
			durationMs: 1020,
			microphoneAudioPath: `${stem}-microphone.mov`,
			microphoneAudioOffsetMs: 22.5,
		});
	});

	it.each([
		"stop",
		"recover",
		"discard",
	] as const)("drains source metadata received during %s before final recovery mutation", async (mode) => {
		let reportOriginal: ((original: NativeMacOriginalStarted) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, _fatal, callback) => {
			reportOriginal = callback;
			return helper;
		});
		const stem = path.join(recordingsDir, "recording-100-clip-0001");
		const clip = {
			index: 0,
			screenVideoPath: `${stem}.mp4`,
			durationMs: 1000,
			microphoneAudioPath: `${stem}-microphone.mov`,
			microphoneAudioOffsetMs: 12.5,
		};
		await fs.writeFile(clip.screenVideoPath, "durable screen");
		await fs.writeFile(clip.microphoneAudioPath, "durable microphone");
		vi.mocked(inspectHandoffSourceMedia).mockResolvedValue({
			video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
			hasAudio: true,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 1,
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		let completeStop:
			| ((result: { screenPath: string; clips: RecordingSessionClip[] }) => void)
			| undefined;
		let failStop: ((error: Error) => void) | undefined;
		helper.stop.mockImplementation(
			() =>
				new Promise((resolve, reject) => {
					completeStop = resolve;
					failStop = reject;
				}),
		);
		const stopped = service.stop(mode === "discard");
		await vi.waitFor(() => expect(helper.stop).toHaveBeenCalledOnce());
		let releaseWrite: (() => void) | undefined;
		const pendingWrite = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const rename = fs.rename;
		let blockedWrite = false;
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith(".recovery.json")) {
				blockedWrite = true;
				await pendingWrite;
			}
			return rename(from, to);
		});
		try {
			reportOriginal?.({
				clipIndex: 0,
				key: "microphoneAudioPath",
				path: clip.microphoneAudioPath,
				offsetMs: 12.5,
			});
			await vi.waitFor(() => expect(blockedWrite).toBe(true));
			if (mode === "recover") failStop?.(new Error("SIGKILL during Stop"));
			else completeStop?.({ screenPath: clip.screenVideoPath, clips: [clip] });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(deps.onSessionStored).not.toHaveBeenCalled();
			releaseWrite?.();
			const result = await stopped;
			expect(result.success).toBe(true);
			if (mode === "discard") {
				await expect(fs.access(nativeMacRecoveryJournalPath(recordingsDir, 100))).rejects.toThrow();
				await expect(fs.access(clip.microphoneAudioPath)).rejects.toThrow();
			} else {
				expect(result.session?.clips?.[0]).toMatchObject({
					microphoneAudioPath: clip.microphoneAudioPath,
					microphoneAudioOffsetMs: 12.5,
				});
				const journal = JSON.parse(
					await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8"),
				);
				expect(journal.session.clips).toEqual(result.session?.clips);
				if (mode === "stop") expect(journal.session.clips[0].durationMs).toBe(1000);
			}
			// A late/replayed event cannot resurrect a discarded journal or replace the final one.
			reportOriginal?.({
				clipIndex: 0,
				key: "systemAudioPath",
				path: `${stem}-system.mov`,
				offsetMs: 3,
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (mode === "discard")
				await expect(fs.access(nativeMacRecoveryJournalPath(recordingsDir, 100))).rejects.toThrow();
		} finally {
			releaseWrite?.();
			renameSpy.mockRestore();
		}
	});

	it("retains source metadata written during failed startup before clearing or resetting", async () => {
		let reportOriginal: ((original: NativeMacOriginalStarted) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, _fatal, callback) => {
			reportOriginal = callback;
			return helper;
		});
		const stem = path.join(recordingsDir, "recording-100-clip-0001");
		await fs.writeFile(`${stem}.mp4`, "screen fragment");
		await fs.writeFile(`${stem}-microphone.mov`, "audio fragment");
		vi.mocked(inspectHandoffSourceMedia).mockResolvedValue({
			video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
			hasAudio: true,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 2,
		});
		let failStart: ((error: Error) => void) | undefined;
		helper.waitForStart.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					failStart = reject;
				}),
		);
		const service = new NativeMacRecordingService(deps);
		const starting = service.start(baseRequest);
		await vi.waitFor(() => expect(helper.waitForStart).toHaveBeenCalledOnce());
		let releaseWrite: (() => void) | undefined;
		const pendingWrite = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const rename = fs.rename;
		let blockedWrite = false;
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith(".recovery.json")) {
				blockedWrite = true;
				await pendingWrite;
			}
			return rename(from, to);
		});
		try {
			reportOriginal?.({
				clipIndex: 0,
				key: "microphoneAudioPath",
				path: `${stem}-microphone.mov`,
				offsetMs: 19,
			});
			await vi.waitFor(() => expect(blockedWrite).toBe(true));
			failStart?.(new Error("helper exited before camera readiness"));
			await vi.waitFor(() => expect(helper.kill).toHaveBeenCalledOnce());
			releaseWrite?.();
			await expect(starting).resolves.toMatchObject({ success: false });
			const recovered = await restoreNativeMacRecoverySession(recordingsDir, 100);
			expect(recovered?.clips?.[0]).toMatchObject({
				microphoneAudioPath: `${stem}-microphone.mov`,
				microphoneAudioOffsetMs: 19,
			});
		} finally {
			releaseWrite?.();
			renameSpy.mockRestore();
		}
	});

	it("journals all original source offsets before readiness and restores them after SIGKILL", async () => {
		const stem = path.join(recordingsDir, "recording-100-clip-0001");
		const originals = {
			webcamVideoPath: `${stem}-webcam.mov`,
			webcamOffsetMs: 0,
			microphoneAudioPath: `${stem}-microphone.mov`,
			microphoneAudioOffsetMs: 24.75,
			systemAudioPath: `${stem}-system.mov`,
			systemAudioOffsetMs: 8.5,
		};
		for (const file of [
			`${stem}.mp4`,
			originals.webcamVideoPath,
			originals.microphoneAudioPath,
			originals.systemAudioPath,
		])
			await fs.writeFile(file, "durable fragments");
		vi.mocked(inspectHandoffSourceMedia).mockImplementation(async (file) => ({
			hasAudio: !file.endsWith("webcam.mov"),
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 5,
			...(file.endsWith("webcam.mov") || file.endsWith(".mp4")
				? { video: { codec: "h264", width: 1920, height: 1080, fps: 30 } }
				: {}),
		}));
		const process = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			exitCode: null,
			killed: false,
			kill: vi.fn(() => true),
		}) as unknown as ChildProcessWithoutNullStreams;
		vi.mocked(deps.createHelper).mockImplementation(
			(_path, _config, onFatalError, onOriginalStarted) => {
				const client = new NativeMacHelperClient(process, { onFatalError, onOriginalStarted });
				for (const [key, offsetMs] of [
					["webcamVideoPath", 0],
					["microphoneAudioPath", 24.75],
					["systemAudioPath", 8.5],
				] as const)
					process.stdout.emit(
						"data",
						`${JSON.stringify({ event: "original-started", clipIndex: 0, key, path: originals[key], offsetMs })}\n`,
					);
				process.stdout.emit("data", `${JSON.stringify({ event: "recording-started" })}\n`);
				return client;
			},
		);
		const service = new NativeMacRecordingService(deps);
		await expect(service.start(baseRequest)).resolves.toMatchObject({ success: true });
		const journal = JSON.parse(
			await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8"),
		);
		expect(journal.session.clips[0]).toMatchObject(originals);
		process.emit("close", null, "SIGKILL");
		const stopped = await service.stop();
		expect(stopped).toMatchObject({
			success: true,
			session: { clips: [expect.objectContaining(originals)] },
		});
		expect(stopped.warning).toContain("recovered");
		expect(deps.onFatalError).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "capture-helper-exited",
				message: expect.stringContaining("SIGKILL"),
			}),
		);
	});

	it("journals a new Continue original before the resumed event supplies its clip index", async () => {
		let reportOriginal: ((original: NativeMacOriginalStarted) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, _onFatal, callback) => {
			reportOriginal = callback;
			return helper;
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		helper.pauseResult = Promise.resolve({
			index: 0,
			screenVideoPath: path.join(recordingsDir, "recording-100-clip-0001.mp4"),
			durationMs: 500,
		});
		await service.pause();
		helper.resume.mockImplementation(async () => {
			reportOriginal?.({
				clipIndex: 1,
				key: "microphoneAudioPath",
				path: path.join(recordingsDir, "recording-100-clip-0002-microphone.mov"),
				offsetMs: 31.25,
			});
			return 1;
		});
		await expect(service.resume()).resolves.toMatchObject({ success: true, clipIndex: 1 });
		const journal = JSON.parse(
			await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8"),
		);
		expect(journal.session.clips[1]).toMatchObject({ index: 1, microphoneAudioOffsetMs: 31.25 });
	});

	it("reports a failed late original journal write loudly and preserves existing completed sources", async () => {
		let reportOriginal: ((original: NativeMacOriginalStarted) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, _onFatal, callback) => {
			reportOriginal = callback;
			return helper;
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		const journalPath = nativeMacRecoveryJournalPath(recordingsDir, 100);
		await fs.unlink(journalPath);
		await fs.mkdir(journalPath);
		reportOriginal?.({
			clipIndex: 0,
			key: "microphoneAudioPath",
			path: path.join(recordingsDir, "recording-100-clip-0001-microphone.mov"),
			offsetMs: 12,
		});
		await vi.waitFor(() =>
			expect(deps.onFatalError).toHaveBeenCalledWith(
				expect.objectContaining({ code: "capture-recovery-failed" }),
			),
		);
		helper.stopClips = [
			{
				index: 0,
				screenVideoPath: path.join(recordingsDir, "recording-100-clip-0001.mp4"),
				durationMs: 1000,
			},
		];
		await fs.writeFile(helper.stopClips[0].screenVideoPath, "durable screen");
		const stopped = await service.stop();
		expect(stopped.success).toBe(true);
		expect(stopped.warning).toContain("recovery metadata could not be saved");
		await expect(fs.readFile(helper.stopClips[0].screenVideoPath, "utf8")).resolves.toBe(
			"durable screen",
		);
	});

	it("rejects late source metadata from a previous helper generation", async () => {
		const callbacks: Array<(original: NativeMacOriginalStarted) => void> = [];
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, _onFatal, callback) => {
			callbacks.push(callback);
			return helper;
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.stop(true);
		helper.running = true;
		await service.start({ ...baseRequest, recordingId: 101 });
		callbacks[0]({
			clipIndex: 0,
			key: "webcamVideoPath",
			path: path.join(recordingsDir, "recording-101-clip-0001-webcam.mov"),
			offsetMs: 0,
		});
		await service.pause();
		const journal = JSON.parse(
			await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 101), "utf8"),
		);
		expect(journal.session.clips.some((clip: RecordingSessionClip) => clip.webcamVideoPath)).toBe(
			false,
		);
	});

	it("rejects startup if the helper dies just after its first-frame acknowledgement", async () => {
		helper.waitForStart.mockImplementation(async () => {
			helper.running = false;
		});
		const service = new NativeMacRecordingService(deps);
		await expect(service.start(baseRequest)).resolves.toMatchObject({ success: false });
		expect(deps.onRecordingStateChange).not.toHaveBeenCalledWith(true);
		expect(deps.stopCursor).toHaveBeenCalledOnce();
	});

	it("keeps ordinary cursor pixels in capture without starting a separate cursor helper", async () => {
		const service = new NativeMacRecordingService(deps);
		await expect(
			service.start({ ...baseRequest, cursor: { mode: "system" } }),
		).resolves.toMatchObject({ success: true });
		expect(deps.startCursor).not.toHaveBeenCalled();
		expect(deps.clearCursor).toHaveBeenCalled();
	});

	it("stops a running take before quit and gives up on a helper that never answers", async () => {
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "clip.mp4"),
			durationMs: 1000,
		};
		const service = new NativeMacRecordingService(deps);
		await service.stopBeforeQuit();
		expect(helper.stop).not.toHaveBeenCalled();

		await service.start(baseRequest);
		helper.stopClips = [clip];
		await service.stopBeforeQuit();
		expect(helper.stop).toHaveBeenCalledOnce();
		expect(deps.onSessionStored).toHaveBeenCalledWith(
			expect.objectContaining({ clips: [expect.objectContaining({ index: 0 })] }),
		);

		helper = new FakeHelper();
		vi.mocked(deps.createHelper).mockReturnValue(helper);
		await service.start({ ...baseRequest, recordingId: 101 });
		helper.stop.mockReturnValueOnce(new Promise(() => undefined));
		await expect(service.stopBeforeQuit(20)).resolves.toBe(true);
	});

	it("hands a take stopped for quit to the HUD's next Stop, once", async () => {
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "clip.mp4"),
			durationMs: 1000,
		};
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		helper.stopClips = [clip];
		await expect(service.stopBeforeQuit()).resolves.toBe(true);
		expect(deps.onAppStopped).toHaveBeenCalledOnce();
		expect(helper.stop).toHaveBeenCalledOnce();

		await expect(service.stop()).resolves.toMatchObject({
			success: true,
			session: expect.objectContaining({ clips: [expect.objectContaining({ index: 0 })] }),
		});
		expect(helper.stop).toHaveBeenCalledOnce();
		await expect(service.stop()).resolves.toMatchObject({ success: false });
	});

	it("does not hand an earlier quit-time take to a new take's Stop", async () => {
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		helper.stopClips = [
			{ index: 0, screenVideoPath: path.join(recordingsDir, "clip.mp4"), durationMs: 1000 },
		];
		await service.stopBeforeQuit();
		helper = new FakeHelper();
		vi.mocked(deps.createHelper).mockReturnValue(helper);
		await service.start({ ...baseRequest, recordingId: 101 });
		await service.stop();
		expect(helper.stop).toHaveBeenCalledOnce();
	});

	it("finishes Stop and allows a new take when the helper outlives its kill window", async () => {
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		helper.kill.mockRejectedValueOnce(new Error("helper did not exit"));
		await service.stop();

		expect(deps.onRecordingStateChange).toHaveBeenLastCalledWith(false);
		helper = new FakeHelper();
		vi.mocked(deps.createHelper).mockReturnValue(helper);
		await expect(service.start({ ...baseRequest, recordingId: 101 })).resolves.toMatchObject({
			success: true,
		});
	});

	it("releases a failed start when the helper outlives its kill window", async () => {
		helper.waitForStart.mockRejectedValueOnce(new Error("Screen capture was denied"));
		helper.kill.mockRejectedValueOnce(new Error("helper did not exit"));
		const service = new NativeMacRecordingService(deps);
		await expect(service.start(baseRequest)).resolves.toEqual({
			success: false,
			error: "Screen capture was denied helper did not exit",
		});
		helper = new FakeHelper();
		vi.mocked(deps.createHelper).mockReturnValue(helper);
		await expect(service.start({ ...baseRequest, recordingId: 101 })).resolves.toMatchObject({
			success: true,
		});
	});

	it("stays paused when the helper paused but saving the session fails", async () => {
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "clip.mp4"),
			durationMs: 2000,
		};
		helper.pause.mockRejectedValueOnce(new NativeMacPauseError("Clip tail failed", true, clip));
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await fs.chmod(recordingsDir, 0o500);
		try {
			await expect(service.pause()).resolves.toMatchObject({
				success: false,
				paused: true,
				clip: expect.objectContaining({ index: 0 }),
				error: "Clip tail failed",
			});
			await expect(service.pause()).resolves.toEqual({ success: true });
			expect(helper.pause).toHaveBeenCalledOnce();
		} finally {
			await fs.chmod(recordingsDir, 0o700);
		}
	});

	it("keeps completed clips and source bytes when a rejected Continue is safely paused", async () => {
		const source = path.join(recordingsDir, "recording-100-clip-0001.mp4");
		await fs.writeFile(source, "untouched committed source");
		const clip = { index: 0, screenVideoPath: source, durationMs: 2000 };
		helper.pauseResult = Promise.resolve(clip);
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		const before = await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8");
		helper.resume.mockRejectedValueOnce(
			new NativeMacResumeRejectedError("Selected source closed", 1),
		);
		await expect(service.resume()).resolves.toEqual({
			success: false,
			paused: true,
			error: "Selected source closed",
		});
		expect(deps.onFatalError).not.toHaveBeenCalled();
		expect(deps.onSessionStored).not.toHaveBeenCalled();
		expect(deps.onRecordingStateChange).not.toHaveBeenCalledWith(false);
		expect(await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8")).toBe(
			before,
		);
		await expect(
			service.resume({
				...baseRequest,
				source: { ...baseRequest.source, sourceId: "screen:2:0", displayId: 2 },
			}),
		).resolves.toEqual({ success: true, clipIndex: 1 });
		expect(helper.reconfigure).toHaveBeenCalledOnce();
		const journal = JSON.parse(
			await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8"),
		);
		expect(journal.session.clips).toEqual([
			expect.objectContaining(clip),
			expect.objectContaining({ index: 1, provisionalDuration: true }),
		]);
		expect(await fs.readFile(source, "utf8")).toBe("untouched committed source");
	});

	it.each([
		false,
		true,
	])("clears rejected camera metadata before retry with webcam %s", async (webcamEnabled) => {
		let publishOriginal: ((original: NativeMacOriginalStarted) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, _fatal, original) => {
			publishOriginal = original;
			return helper;
		});
		const screen = path.join(recordingsDir, "recording-100-clip-0001.mp4");
		const camera = path.join(recordingsDir, "recording-100-clip-0002-webcam.mov");
		await fs.writeFile(screen, "committed screen bytes");
		const clip = { index: 0, screenVideoPath: screen, durationMs: 2000 };
		helper.pauseResult = Promise.resolve(clip);
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		const before = JSON.parse(
			await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8"),
		);
		helper.resume.mockImplementationOnce(async () => {
			await fs.writeFile(camera, "rejected seed");
			publishOriginal?.({ clipIndex: 1, key: "webcamVideoPath", path: camera, offsetMs: 23 });
			await fs.unlink(camera);
			throw new NativeMacResumeRejectedError("Screen append rejected", 1);
		});
		await expect(service.resume()).resolves.toMatchObject({ success: false, paused: true });
		const rejected = JSON.parse(
			await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8"),
		);
		expect(rejected.session).toEqual(before.session);
		await expect(fs.stat(camera)).rejects.toMatchObject({ code: "ENOENT" });
		helper.resume.mockImplementationOnce(async () => {
			if (webcamEnabled) {
				await fs.writeFile(camera, "replacement seed");
				publishOriginal?.({ clipIndex: 1, key: "webcamVideoPath", path: camera, offsetMs: 80.5 });
			}
			return 1;
		});
		await expect(
			service.resume({ ...baseRequest, webcam: { ...baseRequest.webcam, enabled: webcamEnabled } }),
		).resolves.toEqual({ success: true, clipIndex: 1 });
		const resumed = JSON.parse(
			await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf8"),
		);
		expect(resumed.session.clips).toHaveLength(2);
		expect(resumed.session.clips[0]).toEqual(expect.objectContaining(clip));
		const active = resumed.session.clips[1];
		if (webcamEnabled)
			expect(active).toEqual(
				expect.objectContaining({ webcamVideoPath: camera, webcamOffsetMs: 80.5 }),
			);
		else {
			expect(active.webcamVideoPath).toBeUndefined();
			expect(active.webcamOffsetMs).toBeUndefined();
		}
		expect(await fs.readFile(screen, "utf8")).toBe("committed screen bytes");
		expect(deps.onFatalError).not.toHaveBeenCalled();
	});

	it("still reports a dead helper as fatal after a paused Continue rejection", async () => {
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		helper.resume.mockImplementationOnce(async () => {
			helper.running = false;
			throw new NativeMacResumeRejectedError("Helper died after rejection", 1);
		});
		await expect(service.resume()).resolves.toEqual({
			success: false,
			error: "Helper died after rejection",
		});
		expect(deps.onFatalError).toHaveBeenCalledWith({
			code: "capture-resume-failed",
			message: "Helper died after rejection",
		});
	});

	it("does not hide an actual writer failure behind a paused Continue rejection", async () => {
		let reportFatal: ((failure: { code: string; message: string }) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, callback) => {
			reportFatal = callback;
			return helper;
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		helper.resume.mockImplementationOnce(async () => {
			reportFatal?.({ code: "writer-failed-during-capture", message: "Writer failed" });
			throw new NativeMacResumeRejectedError("Paused rollback completed", 1);
		});
		await expect(service.resume()).resolves.toEqual({
			success: false,
			error: "Paused rollback completed",
		});
		expect(deps.onFatalError).toHaveBeenCalledOnce();
		expect(deps.onFatalError).toHaveBeenCalledWith({
			code: "writer-failed-during-capture",
			message: "Writer failed",
		});
	});

	it("reports failed first-frame Continue so the HUD can save completed clips", async () => {
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		helper.resume.mockRejectedValue(new Error("No first frame"));
		await expect(service.resume()).resolves.toMatchObject({
			success: false,
			error: "No first frame",
		});
		expect(deps.onFatalError).toHaveBeenCalledWith({
			code: "capture-resume-failed",
			message: "No first frame",
		});
	});

	it("reports a native Continue writer failure once", async () => {
		let reportFatal: ((failure: { code: string; message: string }) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, callback) => {
			reportFatal = callback;
			return helper;
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		helper.resume.mockImplementation(async () => {
			reportFatal?.({ code: "writer-failed-during-capture", message: "Writer failed" });
			throw new Error("Writer failed");
		});
		await expect(service.resume()).resolves.toMatchObject({ success: false });
		expect(deps.onFatalError).toHaveBeenCalledOnce();
		expect(deps.onFatalError).toHaveBeenCalledWith({
			code: "writer-failed-during-capture",
			message: "Writer failed",
		});
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

	it("journals the active clip and removes the handoff only when the recording is discarded", async () => {
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "recording-100-clip-0001.mp4"),
			durationMs: 500,
		};
		helper.pauseResult = Promise.resolve(clip);
		const service = new NativeMacRecordingService(deps);

		await service.start(baseRequest);
		const journalPath = nativeMacRecoveryJournalPath(recordingsDir, 100);
		let envelope = JSON.parse(await fs.readFile(journalPath, "utf-8"));
		expect(envelope.session.clips).toEqual([
			expect.objectContaining({ index: 0, provisionalDuration: true }),
		]);

		await service.pause();
		envelope = JSON.parse(await fs.readFile(journalPath, "utf-8"));
		expect(envelope.session.clips).toEqual([
			expect.objectContaining({ index: 0, durationMs: 500 }),
		]);
		expect(envelope.session.clips[0]).not.toHaveProperty("provisionalDuration");

		await service.resume(baseRequest);
		envelope = JSON.parse(await fs.readFile(journalPath, "utf-8"));
		expect(envelope.session.clips).toEqual([
			expect.objectContaining({ index: 0, durationMs: 500 }),
			expect.objectContaining({ index: 1, provisionalDuration: true }),
		]);

		await service.stop(true);
		await expect(fs.access(journalPath)).rejects.toThrow();
	});

	it("does not start capture when the initial recovery journal cannot be made durable", async () => {
		const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("ENOSPC: disk full"));
		const service = new NativeMacRecordingService(deps);

		await expect(service.start(baseRequest)).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining("ENOSPC"),
		});
		expect(deps.createHelper).not.toHaveBeenCalled();
		expect(deps.onRecordingStateChange).not.toHaveBeenCalledWith(true);
		open.mockRestore();
	});

	it("rolls back Remove previous clip when its durable state update fails", async () => {
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "recording-100-clip-0001.mp4"),
			durationMs: 500,
		};
		helper.pauseResult = Promise.resolve(clip);
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();

		const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("ENOSPC: disk full"));
		await expect(service.removePreviousClip()).rejects.toThrow("ENOSPC");
		open.mockRestore();
		helper.stopClips = [clip];

		await expect(service.stop()).resolves.toMatchObject({
			success: true,
			session: {
				clips: [{ ...clip, cursorCaptureMode: "editable-overlay" }],
			},
		});
	});

	it("restores a removed clip durably before reporting Undo success", async () => {
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "recording-100-clip-0001.mp4"),
			durationMs: 500,
		};
		helper.pauseResult = Promise.resolve(clip);
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		await service.removePreviousClip();

		await expect(service.restoreRemovedClip(clip.index)).resolves.toMatchObject({
			success: true,
			clip,
		});
		const journal = JSON.parse(
			await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 100), "utf-8"),
		);
		expect(journal.session.clips).toEqual([
			expect.objectContaining({ index: clip.index, durationMs: clip.durationMs }),
		]);
		expect(journal.session.clips[0]).not.toHaveProperty("removed");
	});

	it("keeps the clip removed when durable Undo persistence fails", async () => {
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "recording-100-clip-0001.mp4"),
			durationMs: 500,
		};
		helper.pauseResult = Promise.resolve(clip);
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		await service.removePreviousClip();

		const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("ENOSPC: disk full"));
		await expect(service.restoreRemovedClip(clip.index)).rejects.toThrow("ENOSPC");
		open.mockRestore();

		await expect(service.restoreRemovedClip(clip.index)).resolves.toMatchObject({
			success: true,
			clip,
		});
	});

	it("recovers a later clip even when Continue could not update the journal", async () => {
		const firstClip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "recording-100-clip-0001.mp4"),
			durationMs: 500,
		};
		const secondPath = path.join(recordingsDir, "recording-100-clip-0002.mp4");
		helper.pauseResult = Promise.resolve(firstClip);
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await fs.writeFile(firstClip.screenVideoPath, Buffer.alloc(70 * 1024));
		await service.pause();

		const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("ENOSPC: disk full"));
		await expect(service.resume(baseRequest)).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining("ENOSPC"),
		});
		expect(deps.onFatalError).toHaveBeenCalledWith(
			expect.objectContaining({ code: "capture-resume-failed" }),
		);
		open.mockRestore();
		await fs.writeFile(secondPath, Buffer.alloc(70 * 1024));

		await expect(restoreNativeMacRecoverySession(recordingsDir, 100)).resolves.toMatchObject({
			clips: [
				expect.objectContaining({ index: 0, screenVideoPath: firstClip.screenVideoPath }),
				expect.objectContaining({
					index: 1,
					screenVideoPath: secondPath,
					provisionalDuration: true,
				}),
			],
		});
		await service.stop(true);
	});

	it("prepares a changed paused setup so Continue only resumes", async () => {
		helper.pauseResult = Promise.resolve({
			index: 0,
			screenVideoPath: "/tmp/clip-1.mp4",
			durationMs: 500,
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		const changedRequest: NativeMacRecordingRequest = {
			...baseRequest,
			source: { type: "display", sourceId: "screen:2:0", displayId: 2 },
		};

		await expect(service.prepareResume(changedRequest)).resolves.toEqual({
			success: true,
			prepared: true,
		});
		expect(helper.reconfigure).toHaveBeenCalledOnce();
		expect(helper.reconfigure).toHaveBeenCalledWith(
			expect.objectContaining({ source: expect.objectContaining({ sourceId: "screen:2:0" }) }),
		);
		await expect(service.prepareResume(changedRequest)).resolves.toEqual({
			success: true,
			prepared: true,
		});
		expect(helper.reconfigure).toHaveBeenCalledOnce();

		await expect(service.resume(changedRequest)).resolves.toEqual({ success: true, clipIndex: 1 });
		expect(helper.reconfigure).toHaveBeenCalledOnce();
		await service.stop(true);
	});

	it("does not rebuild when only the app's own window list changed", async () => {
		helper.pauseResult = Promise.resolve({
			index: 0,
			screenVideoPath: "/tmp/clip-1.mp4",
			durationMs: 500,
		});
		const service = new NativeMacRecordingService(deps);
		const byProcess: NativeMacRecordingRequest = {
			...baseRequest,
			source: { ...baseRequest.source, excludedWindowIds: [10], excludedProcessIds: [4242] },
		};
		await service.start(byProcess);
		await service.pause();

		await expect(
			service.resume({
				...byProcess,
				source: { ...byProcess.source, excludedWindowIds: [10, 11] },
			}),
		).resolves.toEqual({ success: true, clipIndex: 1 });
		expect(helper.reconfigure).not.toHaveBeenCalled();
		await service.stop(true);
	});

	it("does not rebuild again when only the resolved bounds moved after a prepare", async () => {
		helper.pauseResult = Promise.resolve({
			index: 0,
			screenVideoPath: "/tmp/clip-1.mp4",
			durationMs: 500,
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		await service.pause();
		const windowRequest: NativeMacRecordingRequest = {
			...baseRequest,
			source: {
				type: "window",
				sourceId: "window:77:0",
				windowId: 77,
				bounds: { x: 0, y: 0, width: 1728, height: 1117 },
			},
		};
		await expect(service.prepareResume(windowRequest)).resolves.toEqual({
			success: true,
			prepared: true,
		});
		expect(helper.reconfigure).toHaveBeenCalledTimes(1);

		await expect(
			service.resume({
				...windowRequest,
				source: { ...windowRequest.source, bounds: { x: 100, y: 80, width: 1200, height: 800 } },
			}),
		).resolves.toEqual({ success: true, clipIndex: 1 });
		expect(helper.reconfigure).toHaveBeenCalledTimes(1);
		await service.stop(true);
	});

	it("ignores an early prepare while the recording is live", async () => {
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		const changedRequest: NativeMacRecordingRequest = {
			...baseRequest,
			source: { type: "display", sourceId: "screen:2:0", displayId: 2 },
		};
		await expect(service.prepareResume(changedRequest)).resolves.toEqual({
			success: true,
			prepared: false,
		});
		expect(helper.reconfigure).not.toHaveBeenCalled();
		await service.stop(true);
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

	it("recovers a fragmented active clip when the helper exits before Stop", async () => {
		const service = new NativeMacRecordingService(deps);
		const started = await service.start(baseRequest);
		await fs.writeFile(started.path as string, Buffer.alloc(70 * 1024));
		helper.running = false;

		await expect(service.stop()).resolves.toMatchObject({
			success: true,
			path: started.path,
			warning: expect.stringContaining("recovered from fragmented MP4"),
			session: {
				clips: [
					expect.objectContaining({
						index: 0,
						provisionalDuration: true,
					}),
				],
			},
		});
	});

	it("recovers the fragmented tail when Stop returns without the active clip", async () => {
		const service = new NativeMacRecordingService(deps);
		const started = await service.start(baseRequest);
		await fs.writeFile(started.path as string, Buffer.alloc(70 * 1024));

		await expect(service.stop()).resolves.toMatchObject({
			success: true,
			path: started.path,
			warning: expect.stringContaining("unfinished active clip was recovered"),
			session: {
				clips: [
					expect.objectContaining({
						index: 0,
						provisionalDuration: true,
					}),
				],
			},
		});
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

	it("retains a final-clip warning even when no fatal callback was emitted", async () => {
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		const clip = {
			index: 0,
			screenVideoPath: path.join(recordingsDir, "clip.mp4"),
			durationMs: 2000,
		};
		const warning = { code: "final-clip-failed", message: "The final clip could not be saved." };
		helper.stop.mockResolvedValueOnce({
			screenPath: clip.screenVideoPath,
			clips: [clip],
			...{ warning },
		});
		const result = await service.stop();
		expect(result).toMatchObject({ success: true, session: { interruption: warning } });
		expect(deps.onFatalError).not.toHaveBeenCalled();
	});

	it("persists a fatal interruption even when Stop salvages a valid session", async () => {
		let reportFatal: ((failure: { code: string; message: string }) => void) | undefined;
		vi.mocked(deps.createHelper).mockImplementation((_path, _config, fatal) => {
			reportFatal = fatal;
			return helper;
		});
		const service = new NativeMacRecordingService(deps);
		await service.start(baseRequest);
		const interruption = { code: "cadence-failed", message: "Capture could not keep up." };
		const screenVideoPath = path.join(recordingsDir, "recording-100-clip-0001.mp4");
		await fs.writeFile(screenVideoPath, "retained fragment");
		helper.stopClips = [{ index: 0, screenVideoPath, durationMs: 2000 }];
		reportFatal?.(interruption);
		const result = await service.stop();
		expect(result).toMatchObject({ success: true, session: { interruption } });
		expect(deps.onSessionStored).toHaveBeenCalledWith(expect.objectContaining({ interruption }));
		const restored = await restoreNativeMacRecoverySession(recordingsDir, 100);
		expect(restored?.interruption).toEqual(interruption);
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

	it("lists committed microphone clips for the transcript and marks a live take", async () => {
		const stem = path.join(recordingsDir, "recording-100-clip-0001");
		helper.pauseResult = Promise.resolve({
			index: 0,
			screenVideoPath: `${stem}.mp4`,
			durationMs: 2000,
			microphoneAudioPath: `${stem}-microphone.mov`,
		});
		const service = new NativeMacRecordingService(deps);
		expect(service.transcriptClipListing()).toEqual({ recordingId: null, clips: [], live: false });
		await service.start(baseRequest);
		expect(service.transcriptClipListing()).toMatchObject({
			recordingId: 100,
			clips: [],
			live: true,
		});
		await service.pause();
		expect(service.transcriptClipListing()).toEqual({
			recordingId: 100,
			clips: [{ index: 0, microphoneAudioPath: `${stem}-microphone.mov`, durationMs: 2000 }],
			live: false,
		});
		await service.resume();
		expect(service.transcriptClipListing().live).toBe(true);
	});
});
