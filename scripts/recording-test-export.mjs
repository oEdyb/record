import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function exportPrivateTake({ app, hud, studio, run, corrupt = false }) {
	const { session: original } = await hud.evaluate(() =>
		window.electronAPI.getCurrentRecordingSession(),
	);
	assert(original, "Missing private take");
	const copied = structuredClone(original);
	const directory = path.join(run, "profile", "recordings", "export-copy");
	await mkdir(directory, { recursive: true });
	const copies = new Map();
	for (const clip of copied.clips) {
		for (const key of [
			"screenVideoPath",
			"webcamVideoPath",
			"microphoneAudioPath",
			"systemAudioPath",
		]) {
			if (!clip[key]) continue;
			const source = clip[key],
				destination = path.join(directory, path.basename(source));
			await copyFile(source, destination);
			copies.set(source, destination);
			clip[key] = destination;
		}
	}
	copied.screenVideoPath = copies.get(original.screenVideoPath);
	if (corrupt) {
		const file = copied.clips[0].screenVideoPath;
		const packets = JSON.parse(
			execFileSync(
				"ffprobe",
				[
					"-v",
					"error",
					"-select_streams",
					"v:0",
					"-show_packets",
					"-show_entries",
					"packet=pos,size",
					"-of",
					"json",
					file,
				],
				{ encoding: "utf8" },
			),
		).packets;
		const bytes = await readFile(file);
		for (const packet of packets)
			bytes.fill(0, Number(packet.pos), Number(packet.pos) + Number(packet.size));
		await writeFile(file, bytes);
	}

	const applied = await hud.evaluate(
		(session) => window.electronAPI.setCurrentRecordingSession(session),
		copied,
	);
	assert(applied.success, JSON.stringify(applied));
	await studio.getByRole("button", { name: "Finish", exact: true }).click();
	const editor = app.windows().find((page) => page.url().includes("windowType=editor"));
	assert(editor, "Missing review window");
	await editor.getByRole("button", { name: "Save video", exact: true }).waitFor({ timeout: 30000 });
	const padding = await editor.evaluate(async () => {
		const api = window.electronAPI;
		const latest = await api.invokeNativeBridge({
			version: 1,
			requestId: "padding-read",
			domain: "aiEdition",
			action: "document.getLatest",
			payload: {},
		});
		const document = latest.data?.document;
		if (!document) throw new Error(JSON.stringify(latest));
		document.legacyEditor = { ...document.legacyEditor, padding: 50 };
		return api.invokeNativeBridge({
			version: 1,
			requestId: "padding-write",
			domain: "aiEdition",
			action: "document.save",
			payload: { document },
		});
	});
	assert(
		padding.ok && padding.data?.success && padding.data.document.legacyEditor.padding === 50,
		"Padding was not saved",
	);
	await editor.goto(editor.url().replace("&prewarm=1", ""));
	await editor.getByRole("button", { name: "Save video", exact: true }).click();
	await editor.getByRole("button", { name: "One video", exact: true }).click();
	console.log("SAVE_PRIVATE_EXPORT");
	await editor
		.getByRole("dialog")
		.getByRole("button", { name: /Save video|Export|Save…/ })
		.click();
	if (corrupt) {
		await editor
			.getByText(/damaged or incomplete frames/i)
			.first()
			.waitFor({ timeout: 60000 });
		console.log("PASS actual corrupt private media has a readable decode error");
		return;
	}
	await editor.getByRole("button", { name: /Show in folder/i }).waitFor({ timeout: 600000 });
	const outputs = (await readdir(run)).filter((name) => /^export\.mp4(?:\.mp4)?$/.test(name));
	assert.equal(outputs.length, 1, "Missing or ambiguous export");
	const output = path.join(run, outputs[0]);
	const probe = JSON.parse(
		execFileSync(
			"ffprobe",
			["-v", "error", "-show_format", "-show_streams", "-of", "json", output],
			{ encoding: "utf8" },
		),
	);
	assert(probe.streams.some((stream) => stream.codec_type === "video"));
	assert(probe.streams.some((stream) => stream.codec_type === "audio"));
	const expected =
		copied.clips.filter((clip) => !clip.removed).reduce((sum, clip) => sum + clip.durationMs, 0) /
		1000;
	assert(
		Math.abs(Number(probe.format.duration) - expected) < 0.15,
		`Export length ${probe.format.duration}, expected ${expected}`,
	);
	execFileSync(
		"ffmpeg",
		["-v", "error", "-xerror", "-threads", "4", "-i", output, "-f", "null", "-"],
		{ stdio: "pipe" },
	);
	execFileSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-threads",
			"4",
			"-ss",
			"2",
			"-i",
			output,
			"-frames:v",
			"1",
			"-threads",
			"1",
			path.join(run, "padded-export.png"),
		],
		{ stdio: "pipe" },
	);
	await writeFile(path.join(run, "export-probe.json"), JSON.stringify(probe, null, 2));
	console.log(
		"PASS copied private take exports with padding, no account, full decode and duration",
		output,
	);
}
