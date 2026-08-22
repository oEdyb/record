import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordingSession } from "../../src/lib/recordingSession";
import {
	clearNativeMacRecoveryJournal,
	nativeMacRecoveryJournalPath,
	persistNativeMacRecoveryJournal,
	restoreLatestNativeMacRecoverySession,
	restoreNativeMacRecoverySession,
	updateNativeMacRecoveryJournalIfPresent,
} from "./nativeMacRecoveryJournal";

describe("native macOS recovery journal", () => {
	let recordingsDir: string;

	beforeEach(async () => {
		recordingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "record-recovery-"));
	});

	afterEach(async () => {
		await fs.rm(recordingsDir, { recursive: true, force: true });
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
