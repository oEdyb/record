import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function exportPrivateTake({
	app,
	hud,
	studio,
	run,
	corrupt = false,
	cancel = false,
	destinationFault = null,
	relaunch,
}) {
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
	if (destinationFault) {
		const directory = path.join(run, "export-disk");
		await editor.waitForFunction(
			() =>
				Array.from(document.querySelectorAll('[role="progressbar"]')).some(
					(bar) =>
						Number(bar.getAttribute("aria-valuenow")) > 0 &&
						Number(bar.getAttribute("aria-valuenow")) < 100,
				),
			null,
			{ timeout: 30000 },
		);
		try {
			if (destinationFault === "full")
				execFileSync(process.execPath, [
					"-e",
					`const fs=require('node:fs'),path=require('node:path');const root=process.argv[1],s=fs.statfsSync(root);if(s.type!==0x01021994||s.blocks*s.bsize>3*1024**3)throw new Error('Private capped tmpfs required');const fd=fs.openSync(path.join(root,'private-fill'),'w'),b=Buffer.alloc(4*1024*1024);try{while(true)fs.writeSync(fd,b);}catch(e){if(e.code!=='ENOSPC')throw e;}finally{fs.closeSync(fd);}`,
					directory,
				]);
			else await chmod(directory, 0o555);
			const message =
				destinationFault === "full"
					? "Not enough free space to finish this export safely."
					: "Export was not saved. Klippt cannot remove its partial file; restore write access to the destination folder.";
			await editor.getByText(message, { exact: false }).first().waitFor({ timeout: 30000 });
			assert(
				!(await readdir(directory)).some((name) => /^export\.mp4/.test(name)),
				"Failed export was published",
			);
			console.log(
				`PASS native Studio export ${destinationFault}: readable error and no published output`,
			);
		} finally {
			if (destinationFault === "readonly") await chmod(directory, 0o755);
			else
				await unlink(path.join(directory, "private-fill")).catch((error) => {
					if (error.code !== "ENOENT") throw error;
				});
		}

		if (destinationFault === "readonly") {
			assert(relaunch, "Private relaunch is required to verify export journal recovery");
			assert(
				(await readdir(directory)).some((name) => name.includes(".klippt-export-")),
				"Missing retained partial export",
			);
			await app.close();
			const reopened = await relaunch();
			try {
				for (let i = 0; i < 150; i++) {
					if (!(await readdir(directory)).some((name) => name.includes(".klippt-export-"))) break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				assert(
					!(await readdir(directory)).some((name) => name.includes(".klippt-export-")),
					"Restored folder permissions did not allow journal cleanup after relaunch",
				);
				console.log(
					"PASS restored folder permissions and fresh private launch recover the partial export journal",
				);
				return reopened;
			} catch (error) {
				await reopened.close();
				throw error;
			}
		}
		return;
	}
	if (cancel) {
		const progressAtCancel = await editor.waitForFunction(
			() => {
				const bar = Array.from(document.querySelectorAll('[role="progressbar"]')).find(
					(bar) =>
						Number(bar.getAttribute("aria-valuenow")) > 0 &&
						Number(bar.getAttribute("aria-valuenow")) < 100,
				);
				const button = Array.from(document.querySelectorAll("button")).find(
					(button) => button.textContent.trim() === "Stop saving",
				);
				if (!bar || !button) return false;
				const progress = Number(bar.getAttribute("aria-valuenow"));
				button.click();
				return progress;
			},
			null,
			{ timeout: 30000 },
		);
		await writeFile(
			path.join(run, "cancel-progress.json"),
			JSON.stringify({ percent: await progressAtCancel.jsonValue() }),
		);
		await editor
			.getByRole("button", { name: "Stop saving", exact: true })
			.waitFor({ state: "hidden", timeout: 30000 });
		assert(
			!(await readdir(run)).some((name) => /^export\.mp4/.test(name)),
			"Cancelled export was published",
		);
		console.log("PASS native Studio export cancelled after frame progress, no output published");
		return;
	}
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
	const sourceProbe = JSON.parse(
		execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height",
				"-of",
				"json",
				copied.clips[0].screenVideoPath,
			],
			{ encoding: "utf8" },
		),
	);
	const video = probe.streams.find((stream) => stream.codec_type === "video");
	assert(video, "Missing exported video");
	assert(video.width >= sourceProbe.streams[0].width, "Export reduced source width");
	assert(video.height >= sourceProbe.streams[0].height, "Export reduced source height");
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
	const tail = execFileSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-threads",
			"4",
			"-ss",
			String(Math.max(0, expected - 2)),
			"-i",
			output,
			"-map",
			"0:v:0",
			"-an",
			"-t",
			"1",
			"-vf",
			"fps=5",
			"-filter_threads",
			"1",
			"-f",
			"framemd5",
			"-",
		],
		{ encoding: "utf8" },
	);
	const hashes = tail
		.split("\n")
		.filter((line) => line.trim() && !line.startsWith("#"))
		.map((line) => line.split(",").at(-1).trim());
	assert(new Set(hashes).size >= 2, "Private fixture froze before the end of the export");
	await writeFile(path.join(run, "export-probe.json"), JSON.stringify(probe, null, 2));
	console.log(
		"PASS copied private take exports with padding, no account, full decode and duration",
		output,
	);
}
