import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ownedHelper(appPid) {
	for (const pid of await readdir("/proc")) {
		if (!/^\d+$/.test(pid)) continue;
		try {
			const status = await readFile(`/proc/${pid}/status`, "utf8");
			if (
				status.match(/^PPid:\s+(\d+)/m)?.[1] === String(appPid) &&
				(await realpath(`/proc/${pid}/exe`)).endsWith("openscreen-pipewire-helper")
			)
				return Number(pid);
		} catch {
			/* Processes can exit between directory entries. */
		}
	}
	throw new Error("Missing owned real PipeWire helper");
}

async function queuedBytes(pid) {
	const inode = (await readlink(`/proc/${pid}/fd/0`)).match(/^socket:\[(\d+)\]$/)?.[1];
	assert(inode, "Expected Node's helper stdin socketpair");
	const line = execFileSync("ss", ["-x", "-n", "-H"], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.find((fields) => fields[5] === inode);
	assert(line, "Missing owned helper stdin socket statistics");
	return Number(line[2]);
}

export async function recordingOverlap({ app, hud, studio, snapshot, run, fault, verifyClip }) {
	assert(process.env.AGENT_LAB_RUNTIME, "Overlap tests require a private desktop");
	const resume = fault !== "pause-stop";
	const before = await snapshot();
	if (resume) {
		await studio.evaluate(() => window.electronAPI.studioCommand("pause"));
		for (let i = 0; i < 200; i++) {
			const state = await snapshot();
			if (state.phase === "paused" && !state.pill.transportBusy && state.clips.length) break;
			await delay(50);
		}
		const paused = await snapshot();
		assert.equal(paused.phase, "paused");
		for (const clip of paused.clips) verifyClip(clip);
	}
	const prefix = (await snapshot()).clips;
	const expectedLiveMs = Math.max(1000, Date.now() - (before.liveSinceMs ?? Date.now()) - 2000);
	const helper = await ownedHelper(app.process().pid);
	let queued;
	process.kill(helper, "SIGSTOP");
	try {
		assert.equal(
			await queuedBytes(helper),
			0,
			"Helper command pipe was not empty before the overlap",
		);
		await studio.evaluate(
			(command) => window.electronAPI.studioCommand(command),
			resume ? "resume" : "pause",
		);
		for (let i = 0; i < 100; i++) {
			queued = await queuedBytes(helper);
			if (queued > 0) break;
			await delay(20);
		}
		assert(queued > 0, "No actual command reached the suspended real helper");
		if (fault === "resume-restart") {
			await hud.getByTestId("launch-device-settings-button").evaluate((button) => button.click());
			// Invoke the actual React action even though the busy UI disables the button.
			await hud
				.getByRole("button", { name: "Restart", exact: true, includeHidden: true })
				.evaluate((button) => {
					const key = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
					if (!key || typeof button[key].onClick !== "function")
						throw new Error("Missing production Restart action");
					button[key].onClick();
				});
		} else await studio.evaluate(() => window.electronAPI.studioCommand("stop"));
		await delay(100);
		const afterStopBytes = await queuedBytes(helper);
		const during = await snapshot();
		if (!process.env.KLIPPT_OVERLAP_BASELINE) assert.equal(during.pill.transportBusy, true);
		if (!process.env.KLIPPT_OVERLAP_BASELINE)
			assert.equal(
				afterStopBytes,
				queued,
				"Stop dispatched before pending transport acknowledgement",
			);
		await writeFile(
			path.join(run, "overlap-pending.json"),
			JSON.stringify(
				{
					fault,
					helper,
					queuedBytes: queued,
					afterStopBytes,
					before,
					during,
					expectedLiveMs,
					prefix,
				},
				null,
				2,
			),
		);
	} finally {
		try {
			process.kill(helper, "SIGCONT");
		} catch (error) {
			if (error.code !== "ESRCH") {
				console.error("Could not resume owned helper", helper, error);
				process.exitCode = 1;
			}
		}
	}
	if (fault === "resume-restart") {
		console.log("SELECT_PRIVATE_SOURCE");
		for (let i = 0; i < 300; i++) {
			const state = await snapshot();
			if (
				state.phase === "recording" &&
				state.recordingId !== before.recordingId &&
				!state.pill.transportBusy
			)
				break;
			await delay(100);
		}
		const replacement = await snapshot();
		assert.equal(
			replacement.phase,
			"recording",
			"Restart overlap did not start replacement capture",
		);
		assert.notEqual(replacement.recordingId, before.recordingId);
		await delay(7000);
		await studio.evaluate(() => window.electronAPI.openRecordingStudio());
		await studio.evaluate(() => window.electronAPI.studioCommand("stop"));
	}
	console.log("PASS real-helper unacknowledged overlap issued", fault, {
		helper,
		queuedBytes: queued,
	});
}
