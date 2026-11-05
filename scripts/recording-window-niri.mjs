import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { launchRecordingTestApp } from "./recording-test-app.mjs";

assert(process.env.AGENT_LAB_RUNTIME, "Niri tests require a private agent-lab");
const root = process.cwd();
const run = process.env.KLIPPT_WINDOW_TEST_DIR;
const config = path.join(run, "niri.kdl");
await writeFile(
	config,
	`hotkey-overlay { skip-at-startup; }
window-rule { match app-id="^co.dyberg.klippt$"; open-floating true; }
`,
);
const nested = spawn("niri", ["-c", config], { stdio: ["ignore", "ignore", "inherit"] });
let app;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
	const socket = path.join(process.env.AGENT_LAB_RUNTIME, `niri.wayland-1.${nested.pid}.sock`);
	for (let i = 0; i < 100 && !existsSync(socket); i++) await delay(100);
	assert(existsSync(socket), "Private nested niri did not start");
	const env = {
		...process.env,
		NIRI_SOCKET: socket,
		WAYLAND_DISPLAY: "wayland-1",
		ELECTRON_USER_DATA_DIR: path.join(run, "niri-profile"),
		KLIPPT_AGENT_SOCKET: "off",
		TMPDIR: run,
	};
	const niri = (args) => execFileSync("niri", ["msg", ...args], { env, encoding: "utf8" });
	const windows = () => JSON.parse(niri(["-j", "windows"]));
	app = await launchRecordingTestApp(
		root,
		[
			"--ozone-platform=wayland",
			"--class=co.dyberg.klippt",
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
		],
		env,
	);
	let hud;
	for (let i = 0; i < 100; i++) {
		hud = app.windows().find((p) => p.url().includes("hud-overlay"));
		if (hud) break;
		await delay(100);
	}
	assert(hud);
	hud.setDefaultTimeout(15000);
	await hud.getByTestId("launch-webcam-button").click();
	let camera;
	for (let i = 0; i < 100; i++) {
		camera = app.windows().find((p) => p.url().includes("camera-preview"));
		if (camera) break;
		await delay(100);
	}
	assert(camera);
	camera.setDefaultTimeout(15000);
	await camera.getByTestId("camera-preview-expand").waitFor();
	const owned = () =>
		windows().find((w) => w.title === "Klippt Camera" && w.pid === app.process().pid);
	for (let i = 0; i < 100 && !owned(); i++) await delay(100);
	assert(owned(), "Niri did not map the camera");
	niri(["action", "move-floating-window", "--id", String(owned().id), "--x", "90", "--y", "100"]);
	await delay(300);
	const before = owned().layout.tile_pos_in_workspace_view;
	for (let i = 0; i < 3; i++) {
		await camera.getByTestId("camera-preview-expand").click();
		await camera.waitForFunction(() => innerWidth > 500);
		await camera.getByTestId("camera-preview-expand").click();
		await camera.waitForFunction(() => innerWidth === 312);
		for (
			let j = 0;
			j < 30 &&
			JSON.stringify(owned().layout.tile_pos_in_workspace_view) !== JSON.stringify(before);
			j++
		)
			await delay(100);
		assert.deepEqual(
			owned().layout.tile_pos_in_workspace_view,
			before,
			"Camera did not return to its compositor position",
		);
	}
	await camera.getByTestId("camera-preview-expand").click();
	await camera.waitForFunction(() => innerWidth > 500);
	for (let i = 0; i < 3; i++) await camera.getByTestId("camera-preview-expand").click();
	await camera.waitForFunction(() => innerWidth === 312);
	for (
		let i = 0;
		i < 30 && JSON.stringify(owned().layout.tile_pos_in_workspace_view) !== JSON.stringify(before);
		i++
	)
		await delay(100);
	assert.deepEqual(
		owned().layout.tile_pos_in_workspace_view,
		before,
		"Rapid toggles lost original position",
	);

	// The renderer can receive the compact configure before niri publishes its
	// corresponding layout. Never treat the previous expanded layout as baseline.
	for (
		let i = 0;
		i < 30 && JSON.stringify(owned().layout.window_size) !== JSON.stringify([312, 186]);
		i++
	)
		await delay(100);
	assert.deepEqual(
		owned().layout.window_size,
		[312, 186],
		"Rapid collapse did not settle in the compositor",
	);
	for (const title of ["Klippt Camera", "Klippt"]) {
		const win = windows().find((w) => w.title === title && w.pid === app.process().pid);
		assert(win);
		niri(["action", "maximize-window-to-edges", "--id", String(win.id)]);
		await delay(500);
		const expanded = windows().find((w) => w.id === win.id);
		niri(["action", "maximize-window-to-edges", "--id", String(win.id)]);
		await delay(500);
		const restored = windows().find((w) => w.id === win.id);
		assert.deepEqual(
			restored.layout.window_size,
			win.layout.window_size,
			`${title} did not restore size`,
		);
		assert.deepEqual(
			restored.layout.tile_pos_in_workspace_view,
			win.layout.tile_pos_in_workspace_view,
			`${title} did not restore position`,
		);
		console.log(
			JSON.stringify(expanded.layout.window_size) === JSON.stringify(win.layout.window_size)
				? "Niri declined native maximize for fixed window; restore preserved bounds"
				: "PASS private niri compositor maximize/restore",
			title,
			{
				before: win.layout.window_size,
				expanded: expanded.layout.window_size,
			},
		);
	}
	await camera.screenshot({ path: path.join(run, "niri-camera-restored.png") });
	console.log("PASS private niri camera Expand/Collapse restores original position", before);
} finally {
	try {
		if (app) await app.close();
	} finally {
		nested.kill("SIGTERM");
	}
}
