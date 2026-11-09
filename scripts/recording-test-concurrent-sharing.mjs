import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function recordingConcurrentSharing({ studio, snapshot, run, verifyClip }) {
	assert(process.env.AGENT_LAB_RUNTIME, "Private desktop required");
	const started = Date.now();
	const casts = [];
	for (let cycle = 0; cycle < 6; cycle++) {
		const child = spawn(
			path.resolve("electron/native/bin/linux-x64/openscreen-pipewire-helper"),
			[JSON.stringify({ cursor: { mode: "metadata" }, sampleIntervalMs: 1000 })],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let buffer = "";
		const events = [];
		child.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop();
			for (const line of lines.filter(Boolean)) events.push(JSON.parse(line));
		});
		child.stderr.on("data", (data) => process.stderr.write(data));
		try {
			console.log("SELECT_PRIVATE_MONITOR");
			for (let i = 0; i < 300 && !events.some((e) => e.event === "stream-started"); i++) {
				assert(child.exitCode === null, `Share exited ${child.exitCode}`);
				await delay(100);
			}
			assert(
				events.some((e) => e.event === "stream-started"),
				"Second share never streamed",
			);
			await writeFile(path.join(run, `share-${cycle}.json`), JSON.stringify(events, null, 2));
			assert(
				events.some((e) => e.sourceKind === "monitor"),
				"Second share must cover the HUD monitor",
			);
			casts.push({
				cycle,
				startedAt: Date.now(),
				events: events.filter((e) => e.event !== "cursor-sample"),
			});
			for (let second = 0; second < 90; second++) {
				await delay(1000);
				assert.equal((await snapshot())?.phase, "recording");
				assert(child.exitCode === null, "Second share ended prematurely");
			}
		} finally {
			child.kill("SIGTERM");
			await new Promise((resolve) =>
				child.exitCode !== null || child.signalCode !== null
					? resolve()
					: child.once("exit", resolve),
			);
		}
		for (let second = 0; second < 11; second++) {
			await delay(1000);
			assert.equal((await snapshot())?.phase, "recording");
		}
		console.log("PRIVACY_CYCLE", cycle + 1, "elapsed", (Date.now() - started) / 1000);
	}
	assert(Date.now() - started >= 600000);
	await studio.getByRole("button", { name: "Stop recording", exact: true }).click();
	for (let i = 0; i < 300 && (await snapshot())?.phase !== "review"; i++) await delay(200);
	const saved = await snapshot();
	assert.equal(saved?.phase, "review");
	assert.equal(saved.clips.length, 1, "Privacy created extra takes");
	assert(saved.clips[0].durationMs >= 600000);
	verifyClip(saved.clips[0]);
	const log = await readFile(
		path.join(run, "profile/diagnostics/record-pause-continue-timing.jsonl"),
		"utf8",
	).catch((error) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	assert(
		!log
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse)
			.some((r) => ["pause", "continue"].includes(r.action)),
		"Unrequested transport event",
	);
	await writeFile(
		path.join(run, "concurrent-sharing-proof.json"),
		JSON.stringify({ saved, casts, elapsedMs: Date.now() - started, pauseEvents: 0 }, null, 2),
	);
	console.log(
		"PASS KDE concurrent sharing: ten minutes, six monitor shares, one take, zero pauses, full decode. Niri privacy path is not exercised.",
		run,
	);
}
