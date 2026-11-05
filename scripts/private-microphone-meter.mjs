import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { _electron } from "@playwright/test";
import { acquireRecordingTestLock } from "./recording-test-lock.mjs";

assert(
	process.env.AGENT_LAB_RUNTIME &&
		process.env.PULSE_SERVER?.includes(process.env.AGENT_LAB_RUNTIME),
);
acquireRecordingTestLock();
const output = process.argv[2];
assert(output.startsWith(path.join(process.env.HOME, ".cache/klippt-work/")));
await mkdir(output, { recursive: true });
execFileSync("pactl", [
	"load-module",
	"module-remap-source",
	"master=agent_lab_audio.monitor",
	"source_name=klippt_meter_mic",
]);
execFileSync("pactl", ["set-default-source", "klippt_meter_mic"]);
const file = path.join(output, "meter.cjs"),
	html = path.join(output, "meter.html");
await writeFile(html, "<title>Private microphone control</title>");
await writeFile(
	file,
	`const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output, "profile"))});app.whenReady().then(()=>{session.defaultSession.setPermissionRequestHandler((w,p,done)=>done(true));const w=new BrowserWindow({webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(html)});});`,
);
const app = await _electron.launch({
	executablePath: path.resolve("node_modules/electron/dist/electron"),
	args: [file, "--ozone-platform=wayland", "--use-fake-ui-for-media-stream"],
});
const volumes = [];
let poll;
try {
	const page = await app.firstWindow();
	await page.waitForLoadState();
	const devices = await page.evaluate(async () =>
		(await navigator.mediaDevices.enumerateDevices())
			.filter((d) => d.kind === "audioinput")
			.map((d) => ({ id: d.deviceId, label: d.label })),
	);
	assert(
		devices.every((d) => !d.label || /agent_lab|klippt_meter|Default|Monitor/i.test(d.label)),
		JSON.stringify(devices),
	);
	poll = setInterval(
		() =>
			volumes.push({
				at: Date.now(),
				volume: execFileSync("pactl", ["get-source-volume", "klippt_meter_mic"], {
					encoding: "utf8",
				}).trim(),
			}),
		500,
	);
	const result = await page.evaluate(async () => {
		const output = new AudioContext(),
			oscillator = output.createOscillator(),
			gain = output.createGain();
		gain.gain.value = 0.0004;
		oscillator.connect(gain).connect(output.destination);
		oscillator.start();
		await output.resume();
		const phases = [];
		for (const audio of [
			true,
			{ autoGainControl: false, echoCancellation: false, noiseSuppression: false },
		]) {
			const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
			const context = new AudioContext();
			await context.resume();
			const meter = context.createAnalyser();
			meter.fftSize = 1024;
			context.createMediaStreamSource(stream).connect(meter);
			const buffer = new Float32Array(1024),
				levels = [];
			for (let i = 0; i < 120; i++) {
				meter.getFloatTimeDomainData(buffer);
				levels.push(
					20 * Math.log10(Math.sqrt(buffer.reduce((sum, n) => sum + n * n, 0) / buffer.length)),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			phases.push({
				constraints: audio,
				settings: stream.getAudioTracks()[0].getSettings(),
				levels,
			});
			stream.getTracks().forEach((t) => t.stop());
			await context.close();
		}
		oscillator.stop();
		await output.close();
		return phases;
	});
	await writeFile(
		path.join(output, "meter-results.json"),
		JSON.stringify({ devices, phases: result, volumes }, null, 2),
	);
	console.log("PASS private microphone browser-processing comparison", output);
} finally {
	clearInterval(poll);
	await app.close();
}
