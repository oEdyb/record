import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function selectedMicrophoneLoss({ hud, page, micModule, run, verify }) {
	assert(
		process.env.PULSE_SERVER?.includes(process.env.AGENT_LAB_RUNTIME),
		"Private Pulse server required",
	);
	await hud.evaluate(() => {
		const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
		const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.enumerateDevices = async () =>
			(await enumerate()).filter((device) => device.kind !== "videoinput");
		navigator.mediaDevices.getUserMedia = (constraints) => {
			if (constraints.video)
				return Promise.reject(new Error("This private microphone test exposes no camera"));
			return capture(constraints);
		};
		navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
	});
	await delay(300);
	await hud.getByTestId("launch-microphone-button").click();
	await delay(1500);
	const device = await hud.evaluate(async () => {
		const item = (await navigator.mediaDevices.enumerateDevices()).find(
			(device) =>
				device.kind === "audioinput" &&
				device.deviceId !== "default" &&
				device.label.includes("Remapped agent_lab_audio.monitor source"),
		);
		return item ? { deviceId: item.deviceId, label: item.label } : null;
	});
	assert(device, "No explicitly selectable private microphone");
	await hud.getByTestId("launch-device-settings-button").click();
	const settings = hud;
	await settings.getByRole("button", { name: /^Microphone/ }).click();
	await settings.getByRole("menuitemradio", { name: device.label, exact: true }).click();
	await hud.getByTestId("launch-device-settings-button").click();
	await delay(500);
	await hud.getByTestId("hud-open-studio-button").click();
	const studio = await page("studio");
	console.log("SELECT_PRIVATE_SOURCE");
	await studio.getByRole("button", { name: "Record", exact: true }).click();
	const snapshot = () => hud.evaluate(() => window.electronAPI.getStudioSnapshot());
	for (let i = 0; i < 200 && (await snapshot())?.phase !== "recording"; i++) await delay(200);
	assert.equal((await snapshot())?.phase, "recording");
	const id = (await snapshot()).recordingId;
	const graph = JSON.parse(execFileSync("pw-dump", [], { encoding: "utf8" }));
	await writeFile(path.join(run, "selected-microphone-graph.json"), JSON.stringify(graph, null, 2));
	const nodes = graph.filter((item) => item.type === "PipeWire:Interface:Node");
	const source = nodes.find((node) => node.info?.props?.["node.name"] === "klippt_test_mic");
	assert(source, "Missing private source node");
	const captures = nodes.filter(
		(node) =>
			node.info?.props?.["target.object"] === "klippt_test_mic" &&
			String(node.info.props["node.dont-fallback"]) === "true",
	);
	assert(
		captures.length > 0,
		"Native capture did not bind the explicitly selected mic without fallback",
	);
	assert(
		graph.some(
			(item) =>
				item.type === "PipeWire:Interface:Link" &&
				Number(item.info?.props?.["link.output.node"] ?? item.info?.["output-node-id"]) ===
					source.id &&
				captures.some(
					(node) =>
						node.id === Number(item.info.props["link.input.node"] ?? item.info["input-node-id"]),
				),
		),
		"Selected mic was not actually linked to capture",
	);
	// UI state precedes portal startup. Establish actual encoded footage before unplugging.
	const screenPath = path.join(run, "profile", "recordings", `recording-${id}-clip-0001.mp4`);
	let observed;
	for (let i = 0; i < 150; i++) {
		try {
			const probe = JSON.parse(
				execFileSync(
					"ffprobe",
					[
						"-v",
						"error",
						"-threads",
						"4",
						"-count_frames",
						"-select_streams",
						"v:0",
						"-show_entries",
						"stream=nb_read_frames,avg_frame_rate",
						"-of",
						"json",
						screenPath,
					],
					{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
				),
			);
			const stream = probe.streams[0];
			const [num, den] = stream.avg_frame_rate.split("/").map(Number);
			const fps = num / den;
			const frames = Number(stream.nb_read_frames);
			if (fps > 0 && frames >= fps * 3) {
				observed = { frames, fps, knownPrefixMs: ((frames - 1) / fps) * 1000 };
				break;
			}
		} catch {
			/* Fragmented output may not have flushed its first complete fragment yet. */
		}
		await delay(200);
	}
	assert(observed, "No three-second encoded prefix before unplug");
	await writeFile(path.join(run, "microphone-loss-prefix.json"), JSON.stringify(observed, null, 2));
	execFileSync("pactl", ["unload-module", micModule.toString().trim()]);
	for (let i = 0; i < 150; i++) {
		const state = await snapshot();
		if (state?.phase === "review") break;
		await delay(200);
	}
	let saved = await snapshot();
	const afterLoss = saved.phase;
	if (saved.phase === "recording" || saved.phase === "paused") {
		await studio.getByRole("button", { name: "Stop recording", exact: true }).click();
		for (let i = 0; i < 200 && (await snapshot())?.phase !== "review"; i++) await delay(200);
		saved = await snapshot();
	}
	assert.equal(saved.phase, "review");
	assert.equal(saved.recordingId, id);
	assert(
		saved.clips.some((clip) => !clip.removed && clip.durationMs >= observed.knownPrefixMs - 50),
		"Unplug lost the captured prefix",
	);
	for (const clip of saved.clips.filter((clip) => !clip.removed)) verify(clip);
	await writeFile(
		path.join(run, "selected-microphone-loss.json"),
		JSON.stringify({ afterLoss, observed, saved }, null, 2),
	);
	console.log(
		"PASS explicitly selected private mic unplug: capture state",
		afterLoss,
		"review and screen/mic decode",
		run,
	);
}
