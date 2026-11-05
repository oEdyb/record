import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { _electron } from "@playwright/test";
import { acquireRecordingTestLock } from "./recording-test-lock.mjs";

assert(process.env.AGENT_LAB_RUNTIME, "Only run on a private desktop");
acquireRecordingTestLock();
const output = process.argv[2];
assert(output.startsWith(path.join(process.env.HOME, ".cache/klippt-work/")));
await mkdir(output, { recursive: true });
const fixture = path.join(output, "camera-control.cjs");
await writeFile(
	path.join(output, "camera.html"),
	'<video muted autoplay playsinline width="320"></video>',
);
await writeFile(
	fixture,
	`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({width:400,height:300,webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(path.join(output, "camera.html"))});});`,
);
const app = await _electron.launch({
	executablePath: path.resolve("node_modules/electron/dist/electron"),
	args: [
		fixture,
		"--ozone-platform=wayland",
		"--use-fake-device-for-media-stream=fps=30",
		"--use-fake-ui-for-media-stream",
	],
});
let deadline;
try {
	const page = await app.firstWindow();
	page.on("console", (message) => console.log("CONTROL", message.text()));
	await page.waitForLoadState();
	const result = await Promise.race([
		new Promise(
			(_, reject) =>
				(deadline = setTimeout(
					() => reject(new Error("Private camera control exceeded 45 seconds")),
					45000,
				)),
		),
		page.evaluate(async () => {
			console.log("opening private fake camera");
			const stream = await navigator.mediaDevices.getUserMedia({
				video: {
					width: { exact: 3840 },
					height: { exact: 2160 },
					frameRate: { ideal: 30, max: 30 },
				},
				audio: false,
			});
			console.log("private camera opened");
			const settings = stream.getVideoTracks()[0].getSettings();
			const video = document.querySelector("video");
			video.srcObject = stream;
			await video.play();
			const source = [];
			let watching = true;
			const processor = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] });
			const reader = processor.readable.getReader();
			const read = (async () => {
				while (watching) {
					const { value, done } = await reader.read();
					if (done) break;
					source.push(value.timestamp);
					value.close();
				}
			})();
			const recorder = new MediaRecorder(stream, {
				mimeType: "video/mp4;codecs=avc1",
				videoBitsPerSecond: 16000000,
				videoKeyFrameIntervalDuration: 500,
			});
			const chunks = [];
			recorder.ondataavailable = (e) => chunks.push(e.data);
			const stopped = new Promise((resolve, reject) => {
				recorder.onstop = resolve;
				recorder.onerror = reject;
			});
			recorder.start(250);
			await new Promise((resolve) => setTimeout(resolve, 15000));
			console.log("stopping control recorder");
			recorder.stop();
			await stopped;
			console.log("control recorder stopped");
			watching = false;
			stream.getTracks().forEach((track) => track.stop());
			await reader.cancel();
			await read;
			stream.getTracks().forEach((track) => track.stop());
			return {
				settings,
				source,
				bytes: Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())),
			};
		}),
	]);
	const { bytes, ...stats } = result;
	await writeFile(path.join(output, "camera.mp4"), Buffer.from(bytes));
	await writeFile(path.join(output, "source.json"), JSON.stringify(stats, null, 2));
	execFileSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-xerror",
			"-threads",
			"4",
			"-i",
			path.join(output, "camera.mp4"),
			"-f",
			"null",
			"-",
		],
		{ stdio: "pipe" },
	);
	console.log("PASS independent Chromium camera writer", output);
} finally {
	clearTimeout(deadline);
	await app.close();
}
