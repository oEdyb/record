import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingSession } from "../../src/lib/recordingSession";
import { inspectHandoffSourceMedia } from "../export/sourceHandoffMedia";
import {
	clearNativeMacRecoveryJournal,
	nativeMacRecoveryJournalPath,
	persistNativeMacRecoveryJournal,
	restoreLatestNativeMacRecoverySession,
	restoreNativeMacRecoverySession,
	updateNativeMacRecoveryJournalIfPresent,
} from "./nativeMacRecoveryJournal";

vi.mock("../export/sourceHandoffMedia", () => ({ inspectHandoffSourceMedia: vi.fn() }));

describe("native macOS recovery journal", () => {
	let recordingsDir: string;

	beforeEach(async () => {
		vi.mocked(inspectHandoffSourceMedia).mockReset();
		vi.mocked(inspectHandoffSourceMedia).mockResolvedValue({
			hasAudio: false,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 0.5,
			video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
		});
		recordingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "record-recovery-"));
	});

	afterEach(async () => {
		await fs.rm(recordingsDir, { recursive: true, force: true });
	});

	it("recovers all three journaled originals after a killed helper with their captured offsets", async () => {
		const stem = path.join(recordingsDir, "recording-61-clip-0001");
		const screenVideoPath = `${stem}.mp4`;
		const originals = {
			webcamVideoPath: `${stem}-webcam.mov`,
			webcamOffsetMs: 0,
			microphoneAudioPath: `${stem}-microphone.mov`,
			microphoneAudioOffsetMs: 23.5,
			systemAudioPath: `${stem}-system.mov`,
			systemAudioOffsetMs: 7.25,
		};
		for (const file of [
			screenVideoPath,
			originals.webcamVideoPath,
			originals.microphoneAudioPath,
			originals.systemAudioPath,
		])
			await fs.writeFile(file, "durable fragment");
		vi.mocked(inspectHandoffSourceMedia).mockImplementation(async (file) => ({
			hasAudio: !file.endsWith("webcam.mov"),
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 5.95,
			...(file.endsWith("webcam.mov") || file.endsWith(".mp4")
				? { video: { codec: "h264", width: 1920, height: 1080, fps: 30 } }
				: {}),
		}));
		await persistNativeMacRecoveryJournal(recordingsDir, {
			createdAt: 61,
			screenVideoPath,
			schemaVersion: 2,
			clips: [
				{ index: 0, screenVideoPath, durationMs: 60_000, provisionalDuration: true, ...originals },
			],
		});
		const recovered = await restoreNativeMacRecoverySession(recordingsDir, 61);
		expect(recovered?.clips?.[0]).toMatchObject(originals);
		expect(recovered?.recoveryWarnings).toBeUndefined();
		expect(inspectHandoffSourceMedia).toHaveBeenCalledTimes(4);
	});

	it("keeps the screen and valid microphone when another original has no readable media duration", async () => {
		const stem = path.join(recordingsDir, "recording-62-clip-0001");
		const screenVideoPath = `${stem}.mp4`;
		for (const file of [
			screenVideoPath,
			`${stem}-webcam.mov`,
			`${stem}-microphone.mov`,
			`${stem}-system.mov`,
		])
			await fs.writeFile(file, "fragment");
		vi.mocked(inspectHandoffSourceMedia).mockImplementation(async (file) => ({
			hasAudio: true,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: file.endsWith("microphone.mov") || file.endsWith(".mp4") ? 3 : null,
			...(file.endsWith(".mp4")
				? { video: { codec: "h264", width: 1920, height: 1080, fps: 60 } }
				: {}),
		}));
		await persistNativeMacRecoveryJournal(recordingsDir, {
			createdAt: 62,
			screenVideoPath,
			schemaVersion: 2,
			clips: [
				{
					index: 0,
					screenVideoPath,
					durationMs: 60_000,
					provisionalDuration: true,
					webcamVideoPath: `${stem}-webcam.mov`,
					webcamOffsetMs: 0,
					microphoneAudioPath: `${stem}-microphone.mov`,
					microphoneAudioOffsetMs: 33,
					systemAudioPath: `${stem}-system.mov`,
					systemAudioOffsetMs: 0,
				},
			],
		});
		const recovered = await restoreNativeMacRecoverySession(recordingsDir, 62);
		expect(recovered?.clips?.[0]).toMatchObject({
			screenVideoPath,
			microphoneAudioPath: `${stem}-microphone.mov`,
			microphoneAudioOffsetMs: 33,
		});
		expect(recovered?.clips?.[0]).not.toHaveProperty("webcamVideoPath");
		expect(recovered?.clips?.[0]).not.toHaveProperty("systemAudioPath");
		expect(recovered?.recoveryWarnings).toHaveLength(2);
	});

	it("rejects a journaled outside original or missing timing without probing or inventing sync", async () => {
		const stem = path.join(recordingsDir, "recording-63-clip-0001");
		const screenVideoPath = `${stem}.mp4`;
		await fs.writeFile(screenVideoPath, "screen");
		await fs.writeFile(`${stem}-microphone.mov`, "microphone");
		await persistNativeMacRecoveryJournal(recordingsDir, {
			createdAt: 63,
			screenVideoPath,
			schemaVersion: 2,
			clips: [
				{
					index: 0,
					screenVideoPath,
					durationMs: 60_000,
					webcamVideoPath: "/tmp/unrelated-camera.mov",
					webcamOffsetMs: 0,
					microphoneAudioPath: `${stem}-microphone.mov`,
				},
			],
		});
		const recovered = await restoreNativeMacRecoverySession(recordingsDir, 63);
		expect(recovered?.clips?.[0]).not.toHaveProperty("webcamVideoPath");
		expect(recovered?.clips?.[0]).not.toHaveProperty("microphoneAudioPath");
		expect(recovered?.recoveryWarnings).toHaveLength(2);
		expect(inspectHandoffSourceMedia).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("rejects an exact-name original symlink", async () => {
		const stem = path.join(recordingsDir, "recording-64-clip-0001");
		const screenVideoPath = `${stem}.mp4`;
		await fs.writeFile(screenVideoPath, "screen");
		await fs.symlink(screenVideoPath, `${stem}-webcam.mov`);
		await persistNativeMacRecoveryJournal(recordingsDir, {
			createdAt: 64,
			screenVideoPath,
			schemaVersion: 2,
			clips: [
				{
					index: 0,
					screenVideoPath,
					durationMs: 60_000,
					webcamVideoPath: `${stem}-webcam.mov`,
					webcamOffsetMs: 0,
				},
			],
		});
		const recovered = await restoreNativeMacRecoverySession(recordingsDir, 64);
		expect(recovered?.clips?.[0]).not.toHaveProperty("webcamVideoPath");
		expect(inspectHandoffSourceMedia).not.toHaveBeenCalled();
	});

	it("restores finalized clips and a crash-readable provisional active clip", async () => {
		const firstPath = path.join(recordingsDir, "recording-42-clip-0001.mp4");
		const activePath = path.join(recordingsDir, "recording-42-clip-0002.mp4");
		await fs.writeFile(firstPath, "finalized");
		await fs.writeFile(activePath, Buffer.alloc(70 * 1024));
		const session: RecordingSession = {
			schemaVersion: 2,
			createdAt: 42,
			screenVideoPath: firstPath,
			clips: [
				{ index: 0, screenVideoPath: firstPath, durationMs: 1_500 },
				{
					index: 1,
					screenVideoPath: activePath,
					durationMs: 60_000,
					provisionalDuration: true,
				},
			],
		};
		await persistNativeMacRecoveryJournal(recordingsDir, session);

		await expect(restoreLatestNativeMacRecoverySession(recordingsDir)).resolves.toEqual(session);
		await expect(restoreNativeMacRecoverySession(recordingsDir, 42)).resolves.toEqual(session);
	});

	it("marks a missing clip removed without losing later recoverable media", async () => {
		const missingPath = path.join(recordingsDir, "recording-43-clip-0001.mp4");
		const secondPath = path.join(recordingsDir, "recording-43-clip-0002.mp4");
		await fs.writeFile(secondPath, "finalized second clip");
		await persistNativeMacRecoveryJournal(recordingsDir, {
			schemaVersion: 2,
			createdAt: 43,
			screenVideoPath: missingPath,
			clips: [
				{ index: 0, screenVideoPath: missingPath, durationMs: 1_000 },
				{ index: 1, screenVideoPath: secondPath, durationMs: 2_000 },
			],
		});

		const recovered = await restoreLatestNativeMacRecoverySession(recordingsDir);

		expect(recovered?.screenVideoPath).toBe(secondPath);
		expect(recovered?.clips).toEqual([
			{ index: 0, screenVideoPath: missingPath, durationMs: 1_000, removed: true },
			{ index: 1, screenVideoPath: secondPath, durationMs: 2_000 },
		]);
	});

	it("discovers a readable later clip that a stale journal did not list", async () => {
		const firstPath = path.join(recordingsDir, "recording-47-clip-0001.mp4");
		const laterPath = path.join(recordingsDir, "recording-47-clip-0002.mp4");
		await fs.writeFile(firstPath, "finalized first clip");
		await persistNativeMacRecoveryJournal(recordingsDir, {
			schemaVersion: 2,
			createdAt: 47,
			screenVideoPath: firstPath,
			cursorCaptureMode: "editable-overlay",
			clips: [{ index: 0, screenVideoPath: firstPath, durationMs: 1_000 }],
		});
		await fs.writeFile(laterPath, Buffer.alloc(1_817));
		await fs.writeFile(
			path.join(recordingsDir, "recording-47-clip-0002-webcam.mp4"),
			Buffer.alloc(70 * 1024),
		);

		const recovered = await restoreLatestNativeMacRecoverySession(recordingsDir);

		expect(recovered?.clips).toEqual([
			{ index: 0, screenVideoPath: firstPath, durationMs: 1_000 },
			{
				index: 1,
				screenVideoPath: laterPath,
				durationMs: 60_000,
				provisionalDuration: true,
				cursorCaptureMode: "editable-overlay",
			},
		]);
	});

	it.each([
		"FFmpeg unavailable",
		"Recording processing timed out",
	])("keeps recovery retryable after %s", async (message) => {
		const screenVideoPath = path.join(recordingsDir, "recording-48-clip-0001.mp4");
		await fs.writeFile(screenVideoPath, "fragment");
		await persistNativeMacRecoveryJournal(recordingsDir, {
			createdAt: 48,
			screenVideoPath,
			schemaVersion: 2,
			clips: [{ index: 0, screenVideoPath, durationMs: 60000, provisionalDuration: true }],
		});
		const before = await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 48), "utf8");
		vi.mocked(inspectHandoffSourceMedia).mockRejectedValueOnce(new Error(message));
		const unverified = await restoreNativeMacRecoverySession(recordingsDir, 48);
		expect(unverified?.clips?.[0]).toMatchObject({ provisionalDuration: true, screenVideoPath });
		expect(unverified?.clips?.[0].removed).not.toBe(true);
		expect(unverified?.interruption?.message).toContain(message);
		expect(await fs.readFile(nativeMacRecoveryJournalPath(recordingsDir, 48), "utf8")).toBe(before);
		expect((await restoreNativeMacRecoverySession(recordingsDir, 48))?.clips?.[0].removed).not.toBe(
			true,
		);
	});

	it("excludes a header-only active tail while retaining all original files and completed clips", async () => {
		const screenVideoPath = path.join(recordingsDir, "recording-49-clip-0001.mp4");
		const tail = path.join(recordingsDir, "recording-49-clip-0002.mp4");
		await fs.writeFile(screenVideoPath, "finalized");
		await fs.writeFile(tail, "header only");
		await persistNativeMacRecoveryJournal(recordingsDir, {
			schemaVersion: 2,
			createdAt: 49,
			screenVideoPath,
			clips: [{ index: 0, screenVideoPath, durationMs: 1000 }],
		});
		vi.mocked(inspectHandoffSourceMedia).mockRejectedValue(new Error("moov atom not found"));
		const restored = await restoreNativeMacRecoverySession(recordingsDir, 49);
		expect(restored?.clips).toMatchObject([{ index: 0 }, { index: 1, removed: true }]);
		expect(restored?.recoveryWarnings?.[0]).toContain("file is retained");
		expect(restored?.interruption?.code).toBe("capture-recovery-incomplete");
		expect(await fs.readFile(tail, "utf8")).toBe("header only");
		expect(await fs.readFile(screenVideoPath, "utf8")).toBe("finalized");
	});

	it("keeps a short non-empty fragmented clip for the editor's media probe", async () => {
		const firstPath = path.join(recordingsDir, "recording-50-clip-0001.mp4");
		const shortPath = path.join(recordingsDir, "recording-50-clip-0002.mp4");
		await fs.writeFile(firstPath, "finalized first clip");
		await fs.writeFile(shortPath, Buffer.alloc(1_817));
		await persistNativeMacRecoveryJournal(recordingsDir, {
			schemaVersion: 2,
			createdAt: 50,
			screenVideoPath: firstPath,
			clips: [{ index: 0, screenVideoPath: firstPath, durationMs: 1_000 }],
		});

		expect((await restoreNativeMacRecoverySession(recordingsDir, 50))?.clips).toEqual([
			{ index: 0, screenVideoPath: firstPath, durationMs: 1_000 },
			{
				index: 1,
				screenVideoPath: shortPath,
				durationMs: 60_000,
				provisionalDuration: true,
			},
		]);
	});

	it.skipIf(process.platform === "win32")(
		"does not discover an exact-name symlink outside the recordings directory",
		async () => {
			const firstPath = path.join(recordingsDir, "recording-51-clip-0001.mp4");
			const outsidePath = path.join(
				path.dirname(recordingsDir),
				`${path.basename(recordingsDir)}-outside-clip.mp4`,
			);
			const linkedPath = path.join(recordingsDir, "recording-51-clip-0002.mp4");
			await fs.writeFile(firstPath, "finalized first clip");
			await fs.writeFile(outsidePath, Buffer.alloc(1_817));
			await fs.symlink(outsidePath, linkedPath);
			await persistNativeMacRecoveryJournal(recordingsDir, {
				schemaVersion: 2,
				createdAt: 51,
				screenVideoPath: firstPath,
				clips: [{ index: 0, screenVideoPath: firstPath, durationMs: 1_000 }],
			});

			expect((await restoreNativeMacRecoverySession(recordingsDir, 51))?.clips).toEqual([
				{ index: 0, screenVideoPath: firstPath, durationMs: 1_000 },
			]);
			await fs.rm(outsidePath, { force: true });
		},
	);

	it.skipIf(process.platform === "win32")(
		"replaces a planted journal symlink without writing through it",
		async () => {
			const screenVideoPath = path.join(recordingsDir, "recording-52-clip-0001.mp4");
			const victimPath = path.join(
				path.dirname(recordingsDir),
				`${path.basename(recordingsDir)}-journal-victim.json`,
			);
			const journalPath = nativeMacRecoveryJournalPath(recordingsDir, 52);
			await fs.writeFile(screenVideoPath, "video");
			await fs.writeFile(victimPath, "untouched", "utf8");
			await fs.symlink(victimPath, journalPath);

			await persistNativeMacRecoveryJournal(recordingsDir, {
				createdAt: 52,
				screenVideoPath,
			});

			await expect(fs.readFile(victimPath, "utf8")).resolves.toBe("untouched");
			expect((await fs.lstat(journalPath)).isSymbolicLink()).toBe(false);
			await fs.rm(victimPath, { force: true });
		},
	);

	it("does not resurrect a removed clip while discovering stale-journal media", async () => {
		const keptPath = path.join(recordingsDir, "recording-48-clip-0001.mp4");
		const removedPath = path.join(recordingsDir, "recording-48-clip-0002.mp4");
		await fs.writeFile(keptPath, "kept");
		await fs.writeFile(removedPath, Buffer.alloc(70 * 1024));
		await persistNativeMacRecoveryJournal(recordingsDir, {
			schemaVersion: 2,
			createdAt: 48,
			screenVideoPath: keptPath,
			clips: [
				{ index: 0, screenVideoPath: keptPath, durationMs: 1_000 },
				{ index: 1, screenVideoPath: removedPath, durationMs: 1_000, removed: true },
			],
		});

		expect((await restoreLatestNativeMacRecoverySession(recordingsDir))?.clips).toEqual([
			{ index: 0, screenVideoPath: keptPath, durationMs: 1_000 },
			{ index: 1, screenVideoPath: removedPath, durationMs: 1_000, removed: true },
		]);
	});

	it("does not fall back to the legacy anchor when every clip was removed", async () => {
		const removedPath = path.join(recordingsDir, "recording-49-clip-0001.mp4");
		await fs.writeFile(removedPath, Buffer.alloc(70 * 1024));
		await persistNativeMacRecoveryJournal(recordingsDir, {
			schemaVersion: 2,
			createdAt: 49,
			screenVideoPath: removedPath,
			clips: [{ index: 0, screenVideoPath: removedPath, durationMs: 1_000, removed: true }],
		});

		await expect(restoreNativeMacRecoverySession(recordingsDir, 49)).resolves.toBeNull();
	});

	it("updates only an existing handoff and removes it after import", async () => {
		const screenVideoPath = path.join(recordingsDir, "recording-44-clip-0001.mp4");
		await fs.writeFile(screenVideoPath, Buffer.alloc(70 * 1024));
		const session: RecordingSession = { createdAt: 44, screenVideoPath };

		await updateNativeMacRecoveryJournalIfPresent(recordingsDir, session);
		await expect(fs.access(nativeMacRecoveryJournalPath(recordingsDir, 44))).rejects.toThrow();

		await persistNativeMacRecoveryJournal(recordingsDir, session);
		await updateNativeMacRecoveryJournalIfPresent(recordingsDir, {
			...session,
			importProjectId: "project_1",
		});
		expect((await restoreLatestNativeMacRecoverySession(recordingsDir))?.importProjectId).toBe(
			"project_1",
		);

		await clearNativeMacRecoveryJournal(recordingsDir, 44);
		await expect(fs.access(nativeMacRecoveryJournalPath(recordingsDir, 44))).rejects.toThrow();
	});

	it("skips a newer malformed journal and restores the latest usable session", async () => {
		const validPath = path.join(recordingsDir, "recording-45-clip-0001.mp4");
		await fs.writeFile(validPath, Buffer.alloc(70 * 1024));
		await persistNativeMacRecoveryJournal(recordingsDir, {
			createdAt: 45,
			screenVideoPath: validPath,
		});
		await fs.writeFile(
			nativeMacRecoveryJournalPath(recordingsDir, 46),
			'{"schemaVersion":1,"session":',
			"utf-8",
		);

		expect((await restoreLatestNativeMacRecoverySession(recordingsDir))?.createdAt).toBe(45);
	});
});
