import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	NativeMacOriginalStarted,
	NativeMacRecordingRequest,
} from "../../src/lib/nativeMacRecording";
import type { RecordingSession, RecordingSessionClip } from "../../src/lib/recordingSession";
import {
	type NativeMacCaptureHelper,
	NativeMacRecordingService,
	type NativeMacRecordingServiceDependencies,
} from "./nativeMacRecordingService";
import * as currentFiles from "./nativeMacRecoveryJournal";
import { RecoveryJournalLifecycle } from "./recoveryJournalLifecycle";

vi.mock("../export/sourceHandoffMedia", () => ({
	inspectHandoffSourceMedia: vi.fn(async () => ({
		hasAudio: true,
		hasKlipptMetadata: false,
		roles: [],
		durationSec: 0.5,
		video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
	})),
}));

const output = path.join(os.homedir(), ".cache", "klippt-work", "journal-tests");
const records: Record<string, unknown>[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.writeFile(path.join(output, "observations.json"), JSON.stringify(records, null, 2));
});
function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = () => done();
	});
	return { promise, resolve };
}
const request: NativeMacRecordingRequest = {
	schemaVersion: 1,
	recordingId: 100,
	source: { type: "display", sourceId: "screen:1:0", displayId: 1 },
	video: { fps: 60, width: 1920, height: 1080, hideSystemCursor: false },
	audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
	webcam: { enabled: false, width: 1920, height: 1080, fps: 60 },
	cursor: { mode: "system" },
	outputs: { screenPath: "" },
};
async function fixture(Service: typeof NativeMacRecordingService) {
	await fs.mkdir(output, { recursive: true });
	const root = await fs.mkdtemp(path.join(output, "fixture-"));
	const clip: RecordingSessionClip = {
		index: 0,
		screenVideoPath: path.join(root, "recording-100-clip-0001.mp4"),
		durationMs: 500,
	};
	await fs.writeFile(clip.screenVideoPath, "private synthetic screen bytes");
	let original: (event: NativeMacOriginalStarted) => void = () => undefined;
	let running = true;
	const helper: NativeMacCaptureHelper = {
		captureBounds: null,
		output: "",
		isRunning: () => running,
		kill: async () => {
			running = false;
		},
		waitForStart: async () => undefined,
		pause: async () => clip,
		resume: async () => 1,
		reconfigure: async () => undefined,
		stop: async () => {
			running = false;
			return { screenPath: clip.screenVideoPath, clips: [clip] };
		},
	};
	const deps: NativeMacRecordingServiceDependencies = {
		recordingsDir: root,
		now: () => 100,
		findHelperPath: async () => "private-fake-helper",
		createHelper: (_path, _config, _fatal, onOriginal) => {
			original = onOriginal;
			return helper;
		},
		resolveCapture: (input, recordingId, screenPath) => ({
			config: { ...input, recordingId, outputs: { screenPath } },
			cursorCaptureMode: "system",
		}),
		prepareCapturePermissions: async () => undefined,
		startCursor: async () => false,
		stopCursor: async () => undefined,
		clearCursor: () => undefined,
		finalizeCursor: async () => undefined,
		registerMediaLinks: async () => undefined,
		onSessionStored: () => undefined,
		onRecordingStateChange: () => undefined,
		onFatalError: () => undefined,
		freeDiskBytes: async () => 100 * 1024 ** 3,
	};
	const service = new Service(deps);
	expect(await service.start(request)).toMatchObject({ success: true });
	expect(await service.pause()).toMatchObject({ success: true });
	return { root, clip, service, original: (event: NativeMacOriginalStarted) => original(event) };
}
async function envelope(root: string) {
	return JSON.parse(await fs.readFile(path.join(root, "recording-100.recovery.json"), "utf8")) as {
		session: RecordingSession;
	};
}

describe.each([
	{ name: "current", Service: NativeMacRecordingService, files: currentFiles },
])("reviewA $name durable rollback", ({ name, Service, files }) => {
	it("post-rename sync failure: rejected removal must recover the previously kept clip", async () => {
		const f = await fixture(Service);
		const open = fs.open;
		let fail = true;
		const spy = vi
			.spyOn(fs, "open")
			.mockImplementation(async (...args: Parameters<typeof fs.open>) => {
				const handle = await open(...args);
				if (args[0] === f.root && fail) {
					fail = false;
					const sync = handle.sync.bind(handle);
					handle.sync = async () => {
						handle.sync = sync;
						throw new Error("EIO: injected directory sync failure after rename");
					};
				}
				return handle;
			});
		try {
			await expect(f.service.removePreviousClip()).rejects.toThrow(
				"injected directory sync failure",
			);
			await vi.waitFor(() => expect(f.service.studioTake().clipEdits).toBe("ready"), {
				timeout: 2500,
			});
			const inMemoryKept = f.service.studioTake().clips.length;
			const diskRemoved = (await envelope(f.root)).session.clips?.[0].removed === true;
			const recovered = await files.restoreNativeMacRecoverySession(f.root, 100);
			const observed = {
				name,
				probe: "post-rename-sync-failure",
				inMemoryKept,
				diskRemoved,
				recoveryIsNull: recovered === null,
			};
			await fs.writeFile(
				path.join(output, `evidence-sync-${name}.json`),
				JSON.stringify({ observed, journal: await envelope(f.root), recovered }, null, 2),
			);
			records.push(observed);
			console.log(JSON.stringify(observed));
			expect(inMemoryKept).toBe(1);
			expect(recovered?.clips?.some((clip) => !clip.removed)).toBe(true);
		} finally {
			spy.mockRestore();
			await f.service.stop();
		}
	});

	it("queued metadata during rejected removal must not persist the rolled-back removal", async () => {
		const f = await fixture(Service);
		const entered = deferred();
		const release = deferred();
		const rename = fs.rename;
		let fail = true;
		const spy = vi
			.spyOn(fs, "rename")
			.mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
				if (args[1] === path.join(f.root, "recording-100.recovery.json") && fail) {
					fail = false;
					entered.resolve();
					await release.promise;
					throw new Error("ENOSPC: injected failed removal rename");
				}
				return rename(...args);
			});
		try {
			const removal = f.service.removePreviousClip().then(
				() => "success",
				(error: Error) => error.message,
			);
			await entered.promise;
			const webcam = path.join(f.root, "recording-100-clip-0001-webcam.mp4");
			await fs.writeFile(webcam, "private synthetic camera bytes");
			const snapshots = vi.spyOn(
				f.service as unknown as { persistRecoverySession(): Promise<void> },
				"persistRecoverySession",
			);
			const registration = f.service.registerRendererWebcam(100, {
				clipIndex: 0,
				key: "webcamVideoPath",
				path: webcam,
				offsetMs: 20,
			});
			await vi.waitFor(() => expect(snapshots).toHaveBeenCalledOnce());
			release.resolve();
			expect(await removal).toContain("injected failed removal rename");
			expect(await registration).toBe(true);
			snapshots.mockRestore();
			await vi.waitFor(async () =>
				expect((await envelope(f.root)).session.clips?.[0].webcamVideoPath).toBe(webcam),
			);
			await vi.waitFor(() => expect(f.service.studioTake().clipEdits).toBe("ready"), {
				timeout: 2500,
			});
			const inMemoryKept = f.service.studioTake().clips.length;
			const diskRemoved = (await envelope(f.root)).session.clips?.[0].removed === true;
			const recovered = await files.restoreNativeMacRecoverySession(f.root, 100);
			const observed = {
				name,
				probe: "metadata-during-rejected-removal",
				inMemoryKept,
				diskRemoved,
				recoveryIsNull: recovered === null,
			};
			await fs.writeFile(
				path.join(output, `evidence-metadata-remove-${name}.json`),
				JSON.stringify({ observed, journal: await envelope(f.root), recovered }, null, 2),
			);
			records.push(observed);
			console.log(JSON.stringify(observed));
			expect(inMemoryKept).toBe(1);
			expect(recovered?.clips?.some((clip) => !clip.removed)).toBe(true);
		} finally {
			release.resolve();
			spy.mockRestore();
			await f.service.stop();
		}
	});

	it("queued metadata during rejected Undo must keep the durable clip removed", async () => {
		const f = await fixture(Service);
		await f.service.removePreviousClip();
		const entered = deferred();
		const release = deferred();
		const rename = fs.rename;
		let fail = true;
		const spy = vi
			.spyOn(fs, "rename")
			.mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
				if (args[1] === path.join(f.root, "recording-100.recovery.json") && fail) {
					fail = false;
					entered.resolve();
					await release.promise;
					throw new Error("ENOSPC: injected failed Undo rename");
				}
				return rename(...args);
			});
		try {
			const restoration = f.service.restoreRemovedClip(0).then(
				() => "success",
				(error: Error) => error.message,
			);
			await entered.promise;
			const camera = path.join(f.root, "recording-100-clip-0001-webcam.mp4");
			await fs.writeFile(camera, "private camera bytes");
			const snapshots = vi.spyOn(
				f.service as unknown as { persistRecoverySession(): Promise<void> },
				"persistRecoverySession",
			);
			const registration = f.service.registerRendererWebcam(100, {
				clipIndex: 0,
				key: "webcamVideoPath",
				path: camera,
				offsetMs: 20,
			});
			await vi.waitFor(() => expect(snapshots).toHaveBeenCalledOnce());
			release.resolve();
			expect(await restoration).toContain("injected failed Undo rename");
			expect(await registration).toBe(true);
			snapshots.mockRestore();
			await vi.waitFor(async () =>
				expect((await envelope(f.root)).session.clips?.[0].webcamVideoPath).toBe(camera),
			);
			await vi.waitFor(() => expect(f.service.studioTake().clipEdits).toBe("ready"), {
				timeout: 2500,
			});
			const inMemoryKept = f.service.studioTake().clips.length;
			const diskRemoved = (await envelope(f.root)).session.clips?.[0].removed === true;
			const recovered = await files.restoreNativeMacRecoverySession(f.root, 100);
			const observed = {
				name,
				probe: "metadata-during-rejected-undo",
				inMemoryKept,
				diskRemoved,
				recoveryIsNull: recovered === null,
			};
			records.push(observed);
			console.log(JSON.stringify(observed));
			await fs.writeFile(
				path.join(output, `evidence-metadata-undo-${name}.json`),
				JSON.stringify({ observed, journal: await envelope(f.root), recovered }, null, 2),
			);
			expect(inMemoryKept).toBe(0);
			expect(recovered).toBeNull();
		} finally {
			release.resolve();
			spy.mockRestore();
			await f.service.stop();
		}
	});
});

it("reviewA current: clear before late post-Stop camera update stays cleared", async () => {
	const f = await fixture(NativeMacRecordingService);
	const result = await f.service.stop();
	expect(result.success).toBe(true);
	if (!result.session) throw new Error("missing stopped session");
	const clearing = currentFiles.clearNativeMacRecoveryJournal(f.root, 100);
	const update = currentFiles.updateNativeMacRecoveryJournalIfPresent(f.root, {
		...result.session,
		clips: result.session.clips?.map((clip) => ({
			...clip,
			webcamVideoPath: path.join(f.root, "recording-100-clip-0001-webcam.mp4"),
			webcamOffsetMs: 20,
		})),
	});
	await clearing;
	await update;
	await expect(
		fs.stat(currentFiles.nativeMacRecoveryJournalPath(f.root, 100)),
	).rejects.toMatchObject({ code: "ENOENT" });
});

it("reviewA current: publication waits for a pending snapshot and rejects late same-generation changes", async () => {
	const owner = new RecoveryJournalLifecycle();
	await fs.mkdir(output, { recursive: true });
	const root = await fs.mkdtemp(path.join(output, "fixture-"));
	const file = path.join(root, "ordered.json");
	owner.transition({ type: "bind", owner: { generation: 1, recordingId: 100 } });
	const entered = deferred();
	const release = deferred();
	const a = owner.write(1, "snapshot", async () => {
		entered.resolve();
		await release.promise;
		await fs.writeFile(file, "snapshot");
	});
	await entered.promise;
	const b = owner.write(1, "publish", () => fs.writeFile(file, "published"));
	const late = vi.fn(async () => fs.writeFile(file, "wrong"));
	await expect(owner.write(1, "snapshot", late)).rejects.toThrow("no longer open");
	release.resolve();
	await a;
	await b;
	expect(late).not.toHaveBeenCalled();
	expect(await fs.readFile(file, "utf8")).toBe("published");
	expect(owner.state.kind).toBe("published");
});

it("reviewA current: an update failed before rename does not poison the later clear", async () => {
	await fs.mkdir(output, { recursive: true });
	const root = await fs.mkdtemp(path.join(output, "fixture-"));
	const session: RecordingSession = {
		createdAt: 100,
		screenVideoPath: path.join(root, "screen.mp4"),
	};
	await currentFiles.persistNativeMacRecoveryJournal(root, session);
	const rename = fs.rename;
	let fail = true;
	const entered = deferred();
	const release = deferred();
	const spy = vi
		.spyOn(fs, "rename")
		.mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
			if (args[1] === currentFiles.nativeMacRecoveryJournalPath(root, 100) && fail) {
				fail = false;
				entered.resolve();
				await release.promise;
				throw new Error("injected failed update");
			}
			return rename(...args);
		});
	try {
		const updating = currentFiles.updateNativeMacRecoveryJournalIfPresent(root, session).then(
			() => "success",
			(error: Error) => error.message,
		);
		await entered.promise;
		const clearing = currentFiles.clearNativeMacRecoveryJournal(root, 100);
		release.resolve();
		expect(await updating).toBe("injected failed update");
		await clearing;
		await expect(
			fs.stat(currentFiles.nativeMacRecoveryJournalPath(root, 100)),
		).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		release.resolve();
		spy.mockRestore();
	}
});

it("reviewA current: queued persist retains its call-time snapshot and serializes a later update", async () => {
	await fs.mkdir(output, { recursive: true });
	const root = await fs.mkdtemp(path.join(output, "fixture-"));
	const session: RecordingSession = {
		createdAt: 100,
		screenVideoPath: path.join(root, "screen.mp4"),
		clips: [{ index: 0, screenVideoPath: path.join(root, "screen.mp4"), durationMs: 500 }],
	};
	const rename = fs.rename;
	let first = true;
	const entered = deferred();
	const release = deferred();
	const spy = vi
		.spyOn(fs, "rename")
		.mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
			if (args[1] === currentFiles.nativeMacRecoveryJournalPath(root, 100) && first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return rename(...args);
		});
	try {
		const persist = currentFiles.persistNativeMacRecoveryJournal(root, session);
		await entered.promise;
		const updated = structuredClone(session);
		if (!updated.clips?.[0]) throw new Error("missing fixture clip");
		updated.clips[0].webcamVideoPath = path.join(root, "camera.mp4");
		const update = currentFiles.updateNativeMacRecoveryJournalIfPresent(root, updated);
		updated.clips[0].removed = true;
		release.resolve();
		await persist;
		await update;
		const result = await envelope(root);
		expect(result.session.clips?.[0]).toMatchObject({
			webcamVideoPath: path.join(root, "camera.mp4"),
		});
		expect(result.session.clips?.[0].removed).not.toBe(true);
	} finally {
		release.resolve();
		spy.mockRestore();
	}
});
it("keeps capture and Stop available during persistent clip-edit recovery without changing media", async () => {
	const f = await fixture(NativeMacRecordingService);
	const bytes = await fs.readFile(f.clip.screenVideoPath);
	const rename = fs.rename;
	const spy = vi
		.spyOn(fs, "rename")
		.mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
			if (args[1] === path.join(f.root, "recording-100.recovery.json"))
				throw new Error("EIO: recovery metadata unavailable");
			return rename(...args);
		});
	try {
		await expect(f.service.removePreviousClip()).rejects.toThrow("Clip edits are paused");
		expect(f.service.studioTake().clipEdits).toBe("needs-recovery");
		await expect(f.service.removePreviousClip()).rejects.toThrow("Clip edits are paused");
		expect(await f.service.resume()).toMatchObject({ success: true });
		expect(f.service.isCapturing()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(f.service.isCapturing()).toBe(true);
		expect(f.service.studioTake().clipEdits).toBe("needs-recovery");
		expect(await fs.readFile(f.clip.screenVideoPath)).toEqual(bytes);
		spy.mockRestore();
		expect(await f.service.stop()).toMatchObject({
			success: true,
			session: { clips: [expect.objectContaining({ index: 0 })] },
		});
		expect(await fs.readFile(f.clip.screenVideoPath)).toEqual(bytes);
	} finally {
		spy.mockRestore();
		await f.service.stop();
	}
});
