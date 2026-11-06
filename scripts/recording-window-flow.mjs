import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import { launchRecordingTestApp, recordingTestTarget } from "./recording-test-app.mjs";
import { clipRecovery } from "./recording-test-clip-recovery.mjs";
import { exportPrivateTake } from "./recording-test-export.mjs";
import { acquireRecordingTestLock } from "./recording-test-lock.mjs";
import { selectedMicrophoneLoss } from "./recording-test-microphone-loss.mjs";
import { recordingOverlap } from "./recording-test-overlap.mjs";

function verifyClip(clip, { camera = true, minimumDuration = 0.1 } = {}) {
	for (const key of [
		"screenVideoPath",
		...(camera ? ["webcamVideoPath"] : []),
		"microphoneAudioPath",
	]) {
		assert(clip[key], `Missing ${key}`);
		const probe = JSON.parse(
			execFileSync(
				"ffprobe",
				["-v", "error", "-show_format", "-show_streams", "-of", "json", clip[key]],
				{ encoding: "utf8" },
			),
		);
		assert(probe.streams.length > 0);
		assert(
			Number(probe.format.duration) >= (clip.durationMs >= 300000 ? 300 : minimumDuration),
			`${key} is short`,
		);
		const microphone = key === "microphoneAudioPath";
		const decoded = spawnSync(
			"ffmpeg",
			[
				"-v",
				microphone ? "info" : "error",
				"-threads",
				"4",
				"-i",
				clip[key],
				...(microphone ? ["-af", "volumedetect"] : []),
				"-f",
				"null",
				"-",
			],
			{ encoding: "utf8" },
		);
		assert.equal(decoded.status, 0, decoded.stderr);
		if (microphone) {
			const volume = decoded.stderr.match(/mean_volume: (-?[\d.]+) dB/);
			assert(volume && Number(volume[1]) > -70, "Microphone source is silent");
		}
	}
}

const faultArgument = process.argv.find((arg) => arg.startsWith("--fault="));
const fault = faultArgument?.slice(8);
assert(
	!fault ||
		[
			"clip-recovery",
			"hung-stop",
			"pause-stop",
			"resume-stop",
			"resume-restart",
			"mic-unplug",
			"mic-selected",
			"crash",
			"export",
			"corrupt",
			"disk-low",
			"cancel",
			"export-full",
			"export-readonly",
		].includes(fault),
	"Unknown private fault scenario",
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = path.join(process.env.HOME, ".cache/klippt-work/window-flows");
await mkdir(base, { recursive: true });
if (!process.argv.includes("--worker")) {
	acquireRecordingTestLock();
	const run = await mkdtemp(path.join(base, "run-"));
	const lab = `klippt-windows-${process.pid}`;
	try {
		if (!process.argv.includes("--built") && !process.env.KLIPPT_TEST_EXECUTABLE)
			execFileSync("npm", ["run", "build-vite"], { cwd: root, stdio: "inherit" });
		execFileSync("agent-lab", ["start", lab], { stdio: "inherit" });
		execFileSync(
			"agent-lab",
			[
				"run",
				lab,
				"--",
				"env",
				`KLIPPT_WINDOW_TEST_DIR=${run}`,
				`KLIPPT_OVERLAP_BASELINE=${process.env.KLIPPT_OVERLAP_BASELINE ?? ""}`,
				`KLIPPT_TEST_EXECUTABLE=${process.env.KLIPPT_TEST_EXECUTABLE ?? ""}`,
				"node",
				"scripts/recording-window-niri.mjs",
			],
			{ cwd: root, stdio: "inherit" },
		);
		await new Promise((resolve, reject) => {
			const child = spawn(
				"agent-lab",
				[
					"run",
					lab,
					"--",
					"env",
					`KLIPPT_WINDOW_TEST_DIR=${run}`,
					`KLIPPT_OVERLAP_BASELINE=${process.env.KLIPPT_OVERLAP_BASELINE ?? ""}`,
					`KLIPPT_TEST_EXECUTABLE=${process.env.KLIPPT_TEST_EXECUTABLE ?? ""}`,
					...(process.env.KLIPPT_TEST_EXECUTABLE
						? []
						: [
								`OPENSCREEN_FFMPEG_PATH=${process.env.OPENSCREEN_FFMPEG_PATH ?? "/usr/bin/ffmpeg"}`,
								`OPENSCREEN_COMPOSITOR_VIEW_NODE=${process.env.KLIPPT_TEST_COMPOSITOR_VIEW_NODE ?? process.env.OPENSCREEN_COMPOSITOR_VIEW_NODE ?? ""}`,
								`OPENSCREEN_LINUX_CURSOR_HELPER_EXE=${process.env.OPENSCREEN_LINUX_CURSOR_HELPER_EXE ?? path.join(root, "electron/native/pipewire-capture/build/openscreen-pipewire-helper")}`,
							]),
					...(fault === "disk-low" || fault === "export-full"
						? ["unshare", "--user", "--map-current-user", "--keep-caps", "--mount"]
						: []),
					"node",
					fileURLToPath(import.meta.url),
					"--worker",
					...(faultArgument ? [faultArgument] : []),
				],
				{ cwd: root, stdio: ["ignore", "pipe", "inherit"] },
			);

			let workerActive = true;
			child.stdout.on("data", (data) => {
				process.stdout.write(data);
				if (data.toString().includes("SAVE_PRIVATE_EXPORT")) {
					let attempts = 0;
					const choose = () => {
						if (!workerActive) return;
						const windows = JSON.parse(
							execFileSync(
								"agent-lab",
								[
									"run",
									lab,
									"--",
									"python3",
									path.join(process.env.HOME, ".local/share/agent-lab/windows.py"),
								],
								{ encoding: "utf8" },
							),
						);
						if (!windows.some((window) => /save/i.test(window.caption))) {
							if (++attempts < 40) setTimeout(choose, 300);
							return;
						}
						execFileSync("agent-lab", ["input", lab, "chord", "29", "38"]);
						execFileSync("agent-lab", [
							"input",
							lab,
							"text",
							path.join(
								run,
								fault?.startsWith("export-") ? "export-disk/export.mp4" : "export.mp4",
							),
						]);
						execFileSync("agent-lab", ["input", lab, "key", "28"]);
					};
					setTimeout(choose, 600);
				}
				if (data.toString().includes("SELECT_PRIVATE_SOURCE")) {
					let attempts = 0;
					const choose = () => {
						if (!workerActive) return;
						const windows = JSON.parse(
							execFileSync(
								"agent-lab",
								[
									"run",
									lab,
									"--",
									"python3",
									path.join(process.env.HOME, ".local/share/agent-lab/windows.py"),
								],
								{ encoding: "utf8" },
							),
						);
						const dialog = windows.find((w) => w.caption === "Screen Sharing Requested");
						if (!dialog) {
							if (++attempts < 20) setTimeout(choose, 500);
							return;
						}
						const { x, y, width } = dialog.geometry;
						execFileSync("agent-lab", [
							"input",
							lab,
							"move",
							String(x + width - 100),
							String(y + 110),
						]);
						execFileSync("agent-lab", ["input", lab, "click"]);
						execFileSync("agent-lab", ["input", lab, "text", "Private recording fixture"]);
						setTimeout(() => {
							if (!workerActive) return;
							execFileSync("agent-lab", [
								"input",
								lab,
								"move",
								String(x + width / 2),
								String(y + 250),
							]);
							execFileSync("agent-lab", ["input", lab, "click"]);
						}, 300);
					};
					setTimeout(choose, 500);
				}
			});
			child.on("error", (error) => {
				workerActive = false;
				reject(error);
			});
			child.on("exit", (code) => {
				workerActive = false;
				code === 0 ? resolve() : reject(new Error(`Private flow exit ${code}; artifacts ${run}`));
			});
		});
	} finally {
		let stopped = false;
		for (let attempt = 0; attempt < 30; attempt++) {
			const result = spawnSync("agent-lab", ["stop", lab], { encoding: "utf8" });
			if (result.status === 0) {
				process.stdout.write(result.stdout);
				stopped = true;
				break;
			}
			if (!(result.stderr + result.stdout).includes("active run scopes")) {
				console.error(result.stderr + result.stdout);
				break;
			}
			await delay(200);
		}
		if (!stopped) {
			console.error("Private run scope did not settle during cleanup");
			process.exitCode = 1;
		} else console.log("PASS private desktop cleanup");
	}
} else {
	assert(process.env.AGENT_LAB_RUNTIME, "Only run inside a private agent-lab");
	assert(
		process.env.PULSE_SERVER?.includes(process.env.AGENT_LAB_RUNTIME),
		"Private Pulse server required before changing audio sources",
	);
	const run = process.env.KLIPPT_WINDOW_TEST_DIR;
	if (fault === "disk-low") {
		const recordings = path.join(run, "profile", "recordings");
		await mkdir(recordings, { recursive: true });
		execFileSync("python3", [
			"-c",
			"import ctypes,sys; lib=ctypes.CDLL(None,use_errno=True); result=lib.mount(b'tmpfs',sys.argv[1].encode(),b'tmpfs',0,b'size=2g'); assert result == 0, ctypes.get_errno()",
			recordings,
		]);
	}
	if (fault === "export-full" || fault === "export-readonly") {
		const directory = path.join(run, "export-disk");
		await mkdir(directory, { recursive: true });
		if (fault === "export-full")
			execFileSync("python3", [
				"-c",
				"import ctypes,sys; lib=ctypes.CDLL(None,use_errno=True); result=lib.mount(b'tmpfs',sys.argv[1].encode(),b'tmpfs',0,b'size=512m'); assert result==0,ctypes.get_errno()",
				directory,
			]);
	}
	const micModule = execFileSync("pactl", [
		"load-module",
		"module-remap-source",
		"master=agent_lab_audio.monitor",
		"source_name=klippt_test_mic",
	]);
	execFileSync("pactl", ["set-default-source", "klippt_test_mic"]);
	const fixturePath = path.join(run, "capture-fixture.cjs");
	await writeFile(
		fixturePath,
		`const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(run, "fixture-profile"))});
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.whenReady().then(()=>{
const w=new BrowserWindow({width:960,height:540,title:'Private recording fixture',webPreferences:{backgroundThrottling:false}});
w.loadURL('data:text/html,'+encodeURIComponent('<title>Private recording fixture</title><style>body{background:teal;color:white;font:40px monospace}div{animation:slide 3s infinite alternate}@keyframes slide{to{transform:translateX(300px)}}</style><div>Private recording fixture</div><pre style="font:12px monospace;background:white;color:black;position:absolute;left:24px;top:90px;padding:8px">Sharpness 0123456789 Il1 O0<br>Screen export probe: + - # ?</pre><script>const a=new AudioContext();const o=a.createOscillator();const g=a.createGain();g.gain.value=.02;o.connect(g).connect(a.destination);o.start();a.resume();<\/script>'));
});`,
	);
	const fixture = await _electron.launch({
		executablePath: path.join(root, "node_modules/electron/dist/electron"),
		args: [fixturePath, "--ozone-platform=wayland", "--class=klippt-private-fixture"],
		env: { ...process.env, TMPDIR: run },
	});
	await fixture.firstWindow();

	const launch = () =>
		launchRecordingTestApp(
			root,
			[
				"--ozone-platform=wayland",
				...(fault === "mic-selected" ? [] : ["--use-fake-device-for-media-stream"]),
				"--use-fake-ui-for-media-stream",
			],
			{
				...process.env,
				ELECTRON_USER_DATA_DIR: path.join(run, "profile"),
				KLIPPT_AGENT_SOCKET: "off",
				TMPDIR: run,
			},
		);
	let app = await launch();
	let completed = false;
	try {
		const page = async (type) => {
			for (let i = 0; i < 150; i++) {
				const p = app.windows().find((p) => p.url().includes(`windowType=${type}`));
				if (p) return p;
				await delay(100);
			}
			throw new Error(`Missing window ${type}`);
		};
		const hud = await page("hud-overlay");
		hud.setDefaultTimeout(10000);
		await hud.evaluate(() => {
			window.__privateMeterSettings = [];
			const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
			navigator.mediaDevices.getUserMedia = async (constraints) => {
				const stream = await getUserMedia(constraints);
				if (constraints.audio && !constraints.video)
					window.__privateMeterSettings.push(
						...stream.getAudioTracks().map((track) => track.getSettings()),
					);
				return stream;
			};
		});

		hud.on("console", (m) => console.log("HUD", m.type(), m.text()));
		await hud.waitForTimeout(1500);
		if (fault === "mic-selected") {
			await selectedMicrophoneLoss({
				hud,
				page,
				micModule,
				run,
				verify: (clip) => verifyClip(clip, { camera: false }),
			});
		} else
			recordingControls: {
				await hud.evaluate(() =>
					window.electronAPI.setRecordingPrefs({
						camFormatAuto: false,
						camFormat: { width: 640, height: 360, fps: 30 },
						recordingQuality: "medium",
					}),
				);
				await hud.getByTestId("launch-webcam-button").click();
				await hud.evaluate(() => window.electronAPI.setRecordingPrefs({ micDeviceId: "default" }));
				await hud.getByTestId("launch-microphone-button").click();
				await hud.waitForFunction(() => window.__privateMeterSettings.length > 0);
				for (const settings of await hud.evaluate(() => window.__privateMeterSettings)) {
					assert.equal(settings.autoGainControl, false);
					assert.equal(settings.echoCancellation, false);
					assert.equal(settings.noiseSuppression, false);
				}
				console.log("PASS microphone meters use unprocessed input");

				await hud.evaluate(() =>
					window.electronAPI.onNativeMacRecordingError((e) =>
						console.error("NATIVE FAILURE", JSON.stringify(e)),
					),
				);
				const camera = await page("camera-preview");
				await camera.getByTestId("camera-preview-expand").click();
				await delay(500);
				const expanded = await camera.evaluate(() => window.innerWidth);
				await camera.getByTestId("camera-preview-expand").click();
				await delay(500);
				assert(
					(await camera.evaluate(() => window.innerWidth)) < expanded,
					"Camera did not shrink",
				);
				console.log("SELECT_PRIVATE_SOURCE");
				await hud.getByTestId("launch-source-selector-button").click();
				await hud.waitForFunction(
					() =>
						document
							.querySelector('[data-testid="launch-record-button"]')
							?.getAttribute("aria-label") === "Cancel recording",
				);
				await hud.waitForFunction(
					() =>
						document
							.querySelector('[data-testid="launch-record-button"]')
							?.getAttribute("aria-label") === "Record",
					{},
					{ timeout: 30000 },
				);
				await hud
					.getByTestId("launch-record-button")
					.filter({ hasNot: hud.locator("[disabled]") })
					.waitFor({ state: "visible", timeout: 30000 });
				for (let i = 0; i < 100; i++) {
					if (
						(await hud.getByTestId("launch-record-button").getAttribute("aria-label")) === "Record"
					)
						break;
					await delay(200);
				}
				await hud.evaluate(() =>
					localStorage.setItem(
						"openscreen_user_preferences",
						JSON.stringify({ studioLayout: { view: "replay", split: 0, dockFrac: 99 } }),
					),
				);
				await hud.getByTestId("hud-open-studio-button").click();
				const studio = await page("studio");
				await studio.waitForTimeout(500);
				studio.setDefaultTimeout(10000);
				console.log("SELECT_PRIVATE_SOURCE");
				studio.on("console", (m) => console.log("STUDIO", m.type(), m.text()));
				await studio.getByRole("button", { name: "Record", exact: true }).press("Enter");
				const snapshot = () => studio.evaluate(() => window.electronAPI.getStudioSnapshot());
				for (let i = 0; i < 200; i++) {
					if ((await snapshot())?.phase === "recording") break;
					await delay(200);
				}
				assert.equal((await snapshot())?.phase, "recording", "Writer never entered recording");
				if (fault === "clip-recovery") await delay(2500);

				await studio.getByTestId("hud-compact-pause-button").click();
				await studio.waitForFunction(
					() =>
						document
							.querySelector('[data-testid="hud-compact-pause-button"]')
							?.getAttribute("aria-label") === "Resume recording",
					{},
					{ timeout: 30000 },
				);

				for (const id of ["studio-live", "studio-replay", "studio-document"]) {
					const bounds = await studio.locator(`#${id}`).boundingBox();
					assert(
						bounds && bounds.width > 20 && bounds.height > 20,
						`Legacy saved layout did not recover ${id}`,
					);
				}
				await studio.getByTestId("hud-remove-previous-clip-button").click();
				await studio.getByRole("button", { name: "Undo", exact: true }).click();
				if (fault === "clip-recovery") {
					await clipRecovery({ studio, snapshot, run, verifyClip });
					break recordingControls;
				}
				for (const name of ["Smaller text", "Larger text", "Switch dock side", "Switch dock side"])
					await studio.getByRole("button", { name, exact: true }).click();
				await studio.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
				await studio.getByRole("button", { name: "Done", exact: true }).click();
				for (const name of ["Notes", "Transcript"])
					await studio
						.locator("#studio-document")
						.getByRole("button", { name, exact: true })
						.click();
				for (const name of ["Replay", "Camera", "Both", "Swap panes", "Swap panes"])
					await studio.locator("#studio-dock").getByRole("button", { name, exact: true }).click();
				for (const separator of await studio.getByRole("separator").all()) {
					const box = await separator.boundingBox();
					assert(box);
					const vertical = (await separator.getAttribute("aria-orientation")) === "vertical";
					for (const extreme of [-200, 2200]) {
						await studio.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
						await studio.mouse.down();
						await studio.mouse.move(vertical ? extreme : box.x, vertical ? box.y : extreme, {
							steps: 8,
						});
						await studio.mouse.up();
						for (const id of ["studio-live", "studio-replay", "studio-document"]) {
							const bounds = await studio.locator(`#${id}`).boundingBox();
							assert(bounds && bounds.width > 20 && bounds.height > 20, `${id} disappeared`);
						}
					}
				}
				await studio.screenshot({ path: path.join(run, "split-extremes.png") });
				console.log("PASS split extremes");
				await studio.getByRole("button", { name: "Switch to pill", exact: true }).click();
				await camera.getByTestId("camera-preview-expand").click();
				await camera.waitForFunction(() => window.innerWidth > 500);
				await camera.getByTestId("camera-preview-expand").click();
				await camera.waitForFunction(() => window.innerWidth === 312);

				const grip = await camera.getByTestId("camera-preview-resize").boundingBox();
				assert(grip);
				await camera.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
				await camera.mouse.down();
				await camera.mouse.move(grip.x + grip.width / 2 + 80, grip.y + grip.height / 2 + 45, {
					steps: 8,
				});
				await camera.mouse.up();
				await camera.waitForFunction(() => innerWidth > 312);
				await camera.getByTestId("camera-preview-resize").dblclick();
				await camera.waitForFunction(() => innerWidth === 312);
				for (const title of ["Klippt Camera", "Klippt"]) {
					const targetPage = title === "Klippt Camera" ? camera : hud;
					let before;
					for (let i = 0; i < 40; i++) {
						before = await app.nativeWindow(title, "getBounds");
						const viewport = await targetPage.evaluate(() => ({
							width: innerWidth,
							height: innerHeight,
						}));
						if (before.width === viewport.width && before.height === viewport.height) break;
						await delay(100);
					}
					assert.deepEqual(
						{ width: before.width, height: before.height },
						await targetPage.evaluate(() => ({ width: innerWidth, height: innerHeight })),
						"Compositor did not settle before maximize",
					);
					await app.nativeWindow(title, "maximize");
					await delay(300);
					const maximized = await app.nativeWindow(title, "isMaximized");

					if (title === "Klippt Camera" && maximized) {
						await camera
							.getByRole("button", { name: "Collapse camera preview", exact: true })
							.click();
						await camera.waitForFunction(() => innerWidth === 312);
					}

					if (title === "Klippt" && maximized) {
						await hud.getByTestId("launch-device-settings-button").click();
						await hud.getByTestId("hud-device-settings").waitFor();
						await delay(300);
					}
					await app.nativeWindow(title, "unmaximize");
					await delay(500);

					if (title === "Klippt" && maximized) {
						const panel = await hud.getByTestId("hud-device-settings").boundingBox();
						const viewport = await hud.evaluate(() => ({ width: innerWidth, height: innerHeight }));
						assert(
							panel &&
								panel.x + panel.width <= viewport.width + 1 &&
								panel.y + panel.height <= viewport.height + 1,
							"Settings clipped after restore",
						);
						await hud.getByTestId("launch-device-settings-button").click();
						await delay(500);
					}
					const after = await app.nativeWindow(title, "getBounds");
					assert.equal(after.width, before.width, `${title} did not restore width`);
					assert.equal(after.height, before.height, `${title} did not restore height`);
					console.log(
						maximized
							? "PASS native maximize/restore"
							: "Native maximize declined; restore preserved bounds",
						title,
					);
				}
				await camera.getByTestId("camera-preview-hide").click();
				await hud.getByTestId("launch-device-settings-button").click();
				await hud
					.getByTestId("hud-device-settings")
					.getByRole("button", { name: /^Camera/ })
					.first()
					.click();
				await hud.waitForFunction(
					() =>
						document
							.querySelector('[role="switch"][aria-label="Camera monitor"]')
							?.getAttribute("aria-checked") === "false",
				);
				await hud.getByRole("switch", { name: "Camera monitor", exact: true }).click();
				await camera.waitForFunction(() => document.visibilityState === "visible");
				assert(
					await app.nativeWindow("Klippt Camera", "isVisible"),
					"Camera did not recover after Hide",
				);
				await hud.getByTestId("launch-device-settings-button").click();
				await hud.getByTestId("hud-expand-button").click();
				await hud.getByTestId("hud-expand-button").click();
				await hud.getByTestId("hud-open-studio-button").click();

				console.log("SELECT_PRIVATE_SOURCE");
				await studio.getByRole("button", { name: "Switch to pill", exact: true }).click();
				await hud.getByTestId("hud-compact-pause-button").click();
				for (let i = 0; i < 200; i++) {
					if ((await snapshot())?.phase === "recording") break;
					await delay(200);
				}
				assert.equal((await snapshot())?.phase, "recording");

				const settings = hud.getByTestId("hud-device-settings");
				await hud.getByTestId("launch-device-settings-button").click();
				assert.equal(
					await hud.getByTestId("hud-close-app-button").count(),
					0,
					"Quit must not be exposed during a take",
				);
				const previousId = (await snapshot()).recordingId;
				console.log("SELECT_PRIVATE_SOURCE");
				await settings.getByRole("button", { name: "Restart", exact: true }).click();
				for (let i = 0; i < 200; i++) {
					const state = await snapshot();
					if (
						state?.phase === "recording" &&
						state.recordingId !== previousId &&
						state.pill.canPause
					)
						break;
					await delay(200);
				}
				assert.equal((await snapshot())?.phase, "recording", "Restart did not resume capture");
				assert.notEqual(
					(await snapshot()).recordingId,
					previousId,
					"Restart did not create a new take",
				);

				await delay(1000);
				await hud.getByTestId("hud-compact-pause-button").click();
				for (let i = 0; i < 150; i++) {
					const state = await snapshot();
					if (
						state?.phase === "paused" &&
						state.clips.some((c) => c.webcamVideoPath && c.microphoneAudioPath)
					)
						break;
					await delay(200);
				}
				const restarted = await snapshot();
				assert.equal(restarted.phase, "paused");
				assert(restarted.clips.length > 0, "Restart produced no committed clip");
				for (const clip of restarted.clips) verifyClip(clip);
				console.log("PASS Restart screen/camera/mic files decode before Discard");
				if (!(await settings.isVisible()))
					await hud.getByTestId("launch-device-settings-button").click();
				await settings.getByRole("button", { name: "Discard", exact: true }).click();
				for (let i = 0; i < 200 && (await snapshot())?.phase !== "idle"; i++) await delay(200);
				assert.equal((await snapshot())?.phase, "idle");
				if (await settings.isVisible())
					await hud.getByTestId("launch-device-settings-button").click();
				console.log("SELECT_PRIVATE_SOURCE");
				await hud.getByTestId("launch-record-button").click();
				for (let i = 0; i < 200; i++) {
					const state = await snapshot();
					if (state?.phase === "recording" && state.pill.canPause && !state.pill.transportBusy)
						break;
					await delay(200);
				}
				assert.equal((await snapshot())?.phase, "recording");
				await hud.getByTestId("launch-device-settings-button").click();
				await settings.getByRole("button", { name: "Hide HUD", exact: true }).click();
				const activate = spawn(
					recordingTestTarget(root).executablePath,
					[...recordingTestTarget(root).args, "--ozone-platform=wayland"],
					{
						env: {
							...process.env,
							ELECTRON_USER_DATA_DIR: path.join(run, "profile"),
							KLIPPT_AGENT_SOCKET: "off",
							TMPDIR: run,
						},
						stdio: "ignore",
					},
				);
				await new Promise((resolve, reject) => {
					activate.on("error", reject);
					activate.on("exit", (code) =>
						code === 0 ? resolve() : reject(new Error(`Activation exited ${code}`)),
					);
				});
				for (let i = 0; i < 100; i++) {
					if (await app.nativeWindow("Klippt", "isVisible")) break;
					await delay(100);
				}
				if (await settings.isVisible())
					await hud.getByTestId("launch-device-settings-button").click();
				console.log(
					"PASS recording controls: Pause, Continue, Remove, Undo, Restart, Discard, Hide, activation, settings, preview, Studio",
				);
				let micUnplugged = false;
				let diskFilled = false;
				const started = Date.now();
				while (Date.now() - started < (fault ? 11000 : 301000)) {
					await delay(fault ? 1000 : 10000);
					if (fault === "disk-low" && !diskFilled && Date.now() - started >= 2000) {
						execFileSync(process.execPath, [
							"-e",
							`const fs=require('node:fs');const directory=process.argv[1];const stats=fs.statfsSync(directory);let remaining=stats.bavail*stats.bsize-200*1024*1024;const fd=fs.openSync(require('node:path').join(directory,'private-fill'),'w');const chunk=Buffer.alloc(4*1024*1024);while(remaining>0){const size=Math.min(remaining,chunk.length);fs.writeSync(fd,chunk,0,size);remaining-=size;}fs.closeSync(fd);`,
							path.join(run, "profile", "recordings"),
						]);
						diskFilled = true;
						for (let i = 0; i < 100 && (await snapshot())?.phase !== "paused"; i++)
							await delay(100);
						assert.equal(
							(await snapshot())?.phase,
							"paused",
							"Low-disk guard did not pause the live take",
						);
						console.log(
							"PASS actual private 2 GiB disk reaches low capacity and auto-pauses with Stop available",
						);
						break;
					}
					if (fault === "mic-unplug" && Date.now() - started >= 2000 && !micUnplugged) {
						execFileSync("pactl", ["unload-module", micModule.toString().trim()]);
						micUnplugged = true;
						console.log("PASS removed only the private microphone source mid-take");
					}
					assert.equal((await snapshot())?.phase, "recording", "Take stopped unexpectedly");
					assert(!hud.isClosed(), "HUD closed");
					assert(!camera.isClosed(), "Camera window closed");
					assert(
						await app.nativeWindow("Klippt", "isVisible"),
						"Recording bar unexpectedly hidden",
					);
					assert(
						await app.nativeWindow("Klippt Camera", "isVisible"),
						"Camera unexpectedly hidden",
					);
					if (Math.floor((Date.now() - started) / 1000) % 60 < 10)
						console.log("recording seconds", Math.floor((Date.now() - started) / 1000));
				}
				if (fault === "crash") {
					const recordingId = (await snapshot()).recordingId;
					process.kill(app.process().pid, "SIGKILL");
					await delay(2000);
					app = await launch();
					const recoveredHud = await page("hud-overlay");
					let session;
					for (let i = 0; i < 200; i++) {
						session = (
							await recoveredHud.evaluate(() => window.electronAPI.getCurrentRecordingSession())
						).session;
						if (session?.createdAt === recordingId) break;
						await delay(100);
					}
					assert.equal(
						session?.createdAt,
						recordingId,
						"Startup did not restore the crashed private take",
					);
					assert(
						session.clips.some((clip) => !clip.removed),
						"No recoverable clip",
					);
					for (const clip of session.clips.filter((clip) => !clip.removed)) verifyClip(clip);
					const editor = await page("editor");
					await editor
						.getByRole("button", { name: "Save video", exact: true })
						.waitFor({ timeout: 30000 });
					await writeFile(
						path.join(run, "crash-recovered-session.json"),
						JSON.stringify(session, null, 2),
					);
					console.log(
						"PASS crashed private app restores journal, opens review and decodes all tracks",
						run,
					);
				} else {
					await hud.getByTestId("hud-open-studio-button").click();
					if (fault === "hung-stop") {
						let helper;
						for (const pid of await readdir("/proc")) {
							if (!/^\d+$/.test(pid)) continue;
							try {
								const status = await readFile(`/proc/${pid}/status`, "utf8");
								const executable = await realpath(`/proc/${pid}/exe`);
								if (
									status.match(/^PPid:\s+(\d+)/m)?.[1] === String(app.process().pid) &&
									executable.endsWith("openscreen-pipewire-helper")
								) {
									helper = Number(pid);
									break;
								}
							} catch {
								/* A process can exit while /proc is being read. */
							}
						}
						assert(helper, "Missing owned capture helper");
						process.kill(helper, "SIGSTOP");
						console.log("FROZEN OWNED HELPER", helper);
					}
					if (["pause-stop", "resume-stop", "resume-restart"].includes(fault)) {
						await recordingOverlap({ app, hud, studio, snapshot, run, fault, verifyClip });
					} else await studio.getByRole("button", { name: "Stop recording", exact: true }).click();
					for (let i = 0; i < 300; i++) {
						if ((await snapshot())?.phase === "review") break;
						await delay(200);
					}
					const saved = await snapshot();
					await writeFile(path.join(run, "saved-snapshot.json"), JSON.stringify(saved, null, 2));
					assert.equal(saved?.phase, "review");
					assert(saved.clips.length > 0);
					assert(
						saved.clips.some((c) => c.durationMs >= (fault ? 1000 : 300000)),
						fault ? "No recovered diagnostic clip" : "No five-minute clip",
					);
					for (const clip of saved.clips)
						verifyClip(clip, {
							camera:
								fault !== "resume-stop" ||
								clip.durationMs >= 500 ||
								clip.webcamVideoPath !== undefined,
							minimumDuration: fault === "resume-stop" ? 0 : 0.1,
						});
					if (fault === "resume-stop") {
						const pending = JSON.parse(
							await readFile(path.join(run, "overlap-pending.json"), "utf8"),
						);
						for (const old of pending.prefix)
							assert(
								saved.clips.some(
									(clip) =>
										clip.screenVideoPath === old.screenVideoPath &&
										clip.webcamVideoPath === old.webcamVideoPath &&
										clip.microphoneAudioPath === old.microphoneAudioPath,
								),
								"Stop overlap lost committed footage",
							);
					}

					if (fault === "pause-stop") {
						const pending = JSON.parse(
							await readFile(path.join(run, "overlap-pending.json"), "utf8"),
						);
						assert(
							saved.clips.some(
								(clip) => clip.index === 0 && clip.durationMs >= pending.expectedLiveMs,
							),
							"Pause/Stop lost the pending clip's captured duration",
						);
					}

					await studio.getByRole("button", { name: "Play", exact: true }).click();
					await studio.getByRole("button", { name: "Pause", exact: true }).click();
					const mute = studio.getByRole("button", { name: /^(Unmute|Mute)$/ });
					const originalMute = await mute.getAttribute("aria-label");
					await mute.press("Enter");
					assert.notEqual(await mute.getAttribute("aria-label"), originalMute);
					await mute.press("Enter");
					assert.equal(await mute.getAttribute("aria-label"), originalMute);
					await studio.getByRole("button", { name: "Seek recording +5", exact: true }).click();
					assert(
						Number(
							await studio
								.getByRole("slider", { name: "Seek recording", exact: true })
								.getAttribute("aria-valuenow"),
						) >= 5,
					);
					await studio.getByRole("button", { name: "Seek recording −5", exact: true }).click();
					console.log("PASS saved take replay controls");
					console.log(
						fault
							? `PASS ${fault}: saved screen/camera/microphone take opens and decodes`
							: "PASS five-minute screen/camera/microphone take opens and decodes",
						run,
					);
					if (
						!fault ||
						fault === "export" ||
						fault === "corrupt" ||
						fault === "cancel" ||
						fault === "export-full" ||
						fault === "export-readonly"
					)
						app =
							(await exportPrivateTake({
								app,
								hud,
								studio,
								run,
								corrupt: fault === "corrupt",
								cancel: fault === "cancel",
								destinationFault:
									fault === "export-full"
										? "full"
										: fault === "export-readonly"
											? "readonly"
											: null,
								relaunch: launch,
							})) ?? app;
				}
			}
		completed = true;
	} catch (error) {
		for (const page of app.windows()) {
			console.log(
				"FAILED WINDOW",
				page.url(),
				await page
					.locator("body")
					.textContent()
					.catch(() => "unavailable"),
			);
			if (await page.evaluate(() => document.visibilityState === "visible").catch(() => false))
				await page
					.screenshot({
						path: path.join(run, `failure-${app.windows().indexOf(page)}.png`),
						timeout: 3000,
					})
					.catch((e) => console.log(e.message));
		}
		throw error;
	} finally {
		console.log("closing private app");
		if (!completed)
			await app.abort().catch((error) => console.log("Private app exited:", error.message));
		await app.close();
		await fixture.close();
	}
}
