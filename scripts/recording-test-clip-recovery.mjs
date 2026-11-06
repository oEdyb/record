import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = async (file) =>
	createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
export async function clipRecovery({ studio, snapshot, run, verifyClip }) {
	assert(process.env.AGENT_LAB_RUNTIME, "Clip recovery requires a private desktop");
	for (let i = 0; i < 100; i++) {
		const state = await snapshot();
		if (
			state.clips.some((clip) => clip.webcamVideoPath && clip.microphoneAudioPath) &&
			state.pill.canPause
		)
			break;
		await delay(100);
	}
	const before = await snapshot();
	assert.equal(before.phase, "paused");
	const directory = path.join(run, "profile", "recordings");
	const journal = path.join(directory, `recording-${before.recordingId}.recovery.json`);
	const retained = `${journal}.private-retained`;
	const obstruction = `${journal}.private-obstruction`;
	const files = before.clips.flatMap((clip) =>
		[clip.screenVideoPath, clip.webcamVideoPath, clip.microphoneAudioPath].filter(Boolean),
	);
	assert(files.length >= 3, "Expected a complete screen/camera/microphone prefix");
	for (const file of files) assert(file.startsWith(directory + path.sep));
	const hashes = await Promise.all(files.map(hash));
	await rename(journal, retained);
	await mkdir(journal);
	try {
		await studio.getByTestId("hud-remove-previous-clip-button").click();
		for (let i = 0; i < 100 && (await snapshot()).clipEdits !== "needs-recovery"; i++)
			await delay(100);
		assert.equal((await snapshot()).clipEdits, "needs-recovery");
		await studio.getByRole("status").filter({ hasText: "Clip edits are paused." }).waitFor();
		assert(await studio.getByTestId("hud-remove-previous-clip-button").isDisabled());
		assert(await studio.getByRole("button", { name: "Stop recording", exact: true }).isEnabled());
		await studio.screenshot({ path: path.join(run, "clip-edits-paused.png") });
		await studio.getByRole("button", { name: "Resume recording", exact: true }).click();
		for (let i = 0; i < 100 && (await snapshot()).phase !== "recording"; i++) await delay(100);
		assert.equal((await snapshot()).phase, "recording");
		const live = path.join(directory, `recording-${before.recordingId}-clip-0002.mp4`);
		await delay(1500);
		const firstSize = (await stat(live)).size;
		await delay(2000);
		assert((await stat(live)).size > firstSize, "Capture did not keep writing during recovery");
		assert.equal((await snapshot()).clipEdits, "needs-recovery");
		await studio.getByRole("button", { name: "Stop recording", exact: true }).click();
		for (let i = 0; i < 300 && (await snapshot()).phase !== "review"; i++) await delay(100);
		const saved = await snapshot();
		assert.equal(
			saved.phase,
			"review",
			"Stop and Save must remain available while edits are paused",
		);
		assert(
			saved.clips.some((clip) => clip.screenVideoPath === before.clips[0].screenVideoPath),
			"Rejected Remove lost the acknowledged clip",
		);
		assert(saved.clips.length >= 2, "Continued capture was not saved");
		for (const clip of saved.clips) verifyClip(clip);
		assert.deepEqual(
			await Promise.all(files.map(hash)),
			hashes,
			"Recovery changed an original clip file",
		);
		await writeFile(
			path.join(run, "clip-recovery-evidence.json"),
			JSON.stringify(
				{ before, saved, files, hashes, firstSize, stoppedDuringRecovery: true },
				null,
				2,
			),
		);
		await studio.screenshot({ path: path.join(run, "clip-recovery-saved.png") });
		console.log(
			"PASS failed Remove pauses only clip edits; real capture grows; Stop saves every track; original bytes unchanged",
		);
	} finally {
		await rename(journal, obstruction);
		await rename(retained, journal);
	}
}
