import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupOrphanedExportTemps,
	createVoiceoverTempPath,
	isVoiceoverTempPath,
} from "./voiceoverTemp";

describe("voiceover export temporary files", () => {
	let directory = "";

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-voiceover-test-"));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	it("creates a unique path inside the approved temp directory", () => {
		const first = createVoiceoverTempPath(directory);
		const second = createVoiceoverTempPath(directory);

		expect(first).not.toBe(second);
		expect(isVoiceoverTempPath(directory, first)).toBe(true);
		expect(isVoiceoverTempPath(directory, second)).toBe(true);
	});

	it("rejects lookalike and out-of-directory paths", () => {
		expect(isVoiceoverTempPath(directory, path.join(directory, ".klippt-voiceover-bad.mp4"))).toBe(
			false,
		);
		expect(
			isVoiceoverTempPath(
				directory,
				path.join(
					path.dirname(directory),
					".klippt-voiceover-00000000-0000-4000-8000-000000000000.mp4",
				),
			),
		).toBe(false);
	});

	it("removes orphaned intermediates without touching unrelated temp files", async () => {
		const orphan = createVoiceoverTempPath(directory, 88_888);
		const active = createVoiceoverTempPath(directory, 77_777);
		const unrelated = path.join(directory, "creator-recording.mp4");
		const lookalike = path.join(directory, ".klippt-voiceover-not-a-uuid.mp4");
		await Promise.all([
			fs.writeFile(orphan, "partial export"),
			fs.writeFile(active, "active export"),
			fs.writeFile(unrelated, "recording"),
			fs.writeFile(lookalike, "unrelated"),
		]);

		const orphanSpool = path.join(directory, "klippt-audio-88888-3.pcm");
		const activeSpool = path.join(directory, "klippt-audio-77777-0.pcm");
		const spoolLookalike = path.join(directory, "klippt-audio-88888-x.pcm");
		await Promise.all([
			fs.writeFile(orphanSpool, "pcm"),
			fs.writeFile(activeSpool, "pcm"),
			fs.writeFile(spoolLookalike, "unrelated"),
		]);

		expect(await cleanupOrphanedExportTemps(directory, (pid) => pid === 77_777)).toBe(2);
		await expect(fs.stat(orphanSpool)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.readFile(activeSpool, "utf8")).resolves.toBe("pcm");
		await expect(fs.readFile(spoolLookalike, "utf8")).resolves.toBe("unrelated");
		await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.readFile(active, "utf8")).resolves.toBe("active export");
		await expect(fs.readFile(unrelated, "utf8")).resolves.toBe("recording");
		await expect(fs.readFile(lookalike, "utf8")).resolves.toBe("unrelated");
	});
});
