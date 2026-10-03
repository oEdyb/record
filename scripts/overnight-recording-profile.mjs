#!/usr/bin/env node
// Real Mac capture, private dev app + Chrome profiles. Never launches Klippt.app.
// Example: node scripts/overnight-recording-profile.mjs --phase after --warm true --out artifacts/overnight-2026-10-03/after-recording
// Same-source export: add --source <baseline/source-recording.mp4> in a separate run.
// Contracts: https://playwright.dev/docs/api/class-electronapplication
// https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session
// https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	completedStopSince,
	createTerminalFixture,
	parseProfileArgs,
	reviewMatchesRecording,
} from "./overnight-recording-profile-utils.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { _electron: electron, expect, chromium } = require("@playwright/test");
const opt = parseProfileArgs(process.argv.slice(2));
if (process.platform !== "darwin") throw new Error("This real desktop profiler requires macOS");
const APP_ROOT = path.resolve(opt["app-root"] ?? ROOT);
if (APP_ROOT.startsWith("/Applications/"))
	throw new Error("Installed apps are outside this profiler");
const appPackage = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
if (appPackage.main !== "dist-electron/bootstrap.js")
	throw new Error("Expected a Klippt development package");
const phase = opt.phase ?? "baseline";
const out = path.resolve(opt.out ?? path.join(ROOT, "artifacts/overnight-2026-10-03", phase));
await fsp.mkdir(out, { recursive: true });
const runRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "klippt-overnight-profile-"));
const userData = path.join(runRoot, "user-data"),
	tmp = path.join(runRoot, "tmp");
await fsp.mkdir(tmp, { recursive: true });
const report = {
	version: 1,
	phase,
	options: opt,
	startedAt: new Date().toISOString(),
	runRoot,
	appRoot: APP_ROOT,
	host: {
		platform: process.platform,
		arch: process.arch,
		release: os.release(),
		totalMemory: os.totalmem(),
		freeMemoryAtStart: os.freemem(),
		loadAtStart: os.loadavg(),
	},
	build: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
	workingTree: execFileSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8" }).trim(),
	methods: {
		record:
			"HUD real click event to first Stop-enabled DOM after first encoded native frame; no recorder mocks",
		export:
			"GUI export click to Saved to status; native save picker only is redirected to owned output",
		source:
			"Isolated Chrome terminal fixture (1280x720 CSS viewport, capture includes retina window); system cursor",
		quality: "Source/Highest, 60fps, H.264",
		native:
			"Observe native IPC results unchanged, after handlers register; sample only this Electron process tree",
	},
	recordings: [],
};
const log = fs.createWriteStream(path.join(out, "electron.log"));
let app, fixture, child;
function digest(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
for (const file of [
	"dist-electron/bootstrap.js",
	"electron/native/bin/darwin-arm64/openscreen-screencapturekit-helper",
])
	if (fs.existsSync(path.join(APP_ROOT, file)))
		report[file] = { sha256: digest(path.join(APP_ROOT, file)) };
const title = `Klippt Overnight Terminal Fixture ${process.pid}`;
const alternateTitle = `Klippt Alternate Fixture ${process.pid}`;
const fixtureHtml = createTerminalFixture(title);
async function windowFor(kind) {
	await expect
		.poll(
			() =>
				app
					.windows()
					.find((w) => w.url().includes(`windowType=${kind}`))
					?.url(),
			{ timeout: 60000 },
		)
		.toContain(`windowType=${kind}`);
	const page = app.windows().find((w) => w.url().includes(`windowType=${kind}`));
	await page.waitForLoadState("domcontentloaded");
	return page;
}
async function loadSource(src) {
	const records = path.join(userData, "recordings");
	await fsp.mkdir(records, { recursive: true });
	const ownedSource = path.join(records, "same-baseline-source.mp4");
	await fsp.copyFile(src, ownedSource);
	report.loadedSource = { source: src, ownedSource, sha256: digest(ownedSource) };
	const hud = await windowFor("hud-overlay");
	await hud.evaluate((p) => window.electronAPI.setCurrentVideoPath(p), ownedSource);
	await hud.evaluate(() => window.electronAPI.switchToEditor());
	const editor = await windowFor("editor");
	await expect(editor.getByRole("button", { name: /^(Export|Save video)$/ })).toBeEnabled({
		timeout: 60000,
	});
	await expect
		.poll(
			async () =>
				reviewMatchesRecording(
					Number(
						await editor
							.getByRole("slider", { name: "Seek video", exact: true })
							.getAttribute("max"),
					),
					Number(report.sourceProbe.format.duration),
				),
			{ timeout: 60000 },
		)
		.toBe(true);
	return editor;
}
async function startTiming(hud) {
	await hud.evaluate(() => {
		const button = document.querySelector('[data-testid="launch-record-button"]');
		window.__overnightTiming = {};
		button.addEventListener(
			"click",
			() => {
				window.__overnightTiming.clickAt = performance.now();
			},
			{ capture: true, once: true },
		);
		const observer = new MutationObserver(() => {
			const buttons = [...document.querySelectorAll("button")];
			const stop = buttons.find((b) =>
				/^Stop(?: recording| and open editor)?$/.test(b.getAttribute("aria-label") ?? ""),
			);
			if (stop && !stop.disabled) {
				window.__overnightTiming.recordingAt = performance.now();
				observer.disconnect();
			}
		});
		observer.observe(document.body, { subtree: true, attributes: true, childList: true });
	});
}
async function armSource(hud, sourceTitle = title) {
	await hud.getByTestId("launch-source-selector-button").click();
	const picker = await windowFor("source-selector");
	await picker.getByRole("tab", { name: /Windows/ }).click();
	await expect(
		picker.getByTestId("source-selector-card").filter({ hasText: sourceTitle }),
	).toBeVisible({
		timeout: 30000,
	});
	await picker.getByTestId("source-selector-card").filter({ hasText: sourceTitle }).click();
	await picker.getByTestId("source-selector-share-button").click();
	await expect(hud.getByTestId("launch-source-selector-button")).toHaveAttribute(
		"aria-label",
		sourceTitle,
		{ timeout: 10000 },
	);
}
async function setupControls(hud) {
	if (
		(await hud.getByTestId("launch-microphone-button").count()) === 0 &&
		(await hud.getByTestId("hud-recording-size-button").count())
	)
		await hud.getByTestId("hud-recording-size-button").click();
	for (const id of [
		"launch-system-audio-button",
		"launch-microphone-button",
		"launch-webcam-button",
		"launch-cursor-mode-button",
	]) {
		const btn = hud.getByTestId(id);
		if ((await btn.getAttribute("aria-pressed")) === "true") await btn.click();
	}
	if (["microphone", "both"].includes(opt.audio)) {
		const permission = await app.evaluate(({ systemPreferences }) =>
			systemPreferences.getMediaAccessStatus("microphone"),
		);
		if (permission !== "granted") {
			throw new Error(`Microphone smoke skipped: existing permission is ${permission}`);
		}
		await hud.getByTestId("launch-microphone-button").click();
	}
	if (["system", "both"].includes(opt.audio)) {
		await hud.getByTestId("launch-system-audio-button").click();
	}
}
async function exportGui(editor, tag) {
	const output = path.join(out, `${tag}.mp4`);
	await app.evaluate(({ ipcMain }, target) => {
		ipcMain.removeHandler("pick-export-save-path");
		ipcMain.handle("pick-export-save-path", () => ({
			success: true,
			path: target,
			canceled: false,
		}));
	}, output);
	const save = editor.getByRole("button", { name: "Save video", exact: true });
	const quick = (await save.count()) > 0;
	const open = quick ? save : editor.getByRole("button", { name: "Export", exact: true });
	const clickStart = performance.now();
	await editor.evaluate(() => {
		window.__overnightExport = {};
		document.addEventListener(
			"click",
			(e) => {
				const b = e.target.closest("button");
				const label = b?.getAttribute("aria-label") ?? (b?.textContent ?? "").trim();
				if (b && (label === "Export MP4" || label.startsWith("Save video")))
					window.__overnightExport.clickAt = performance.now();
			},
			true,
		);
		const observer = new MutationObserver(() => {
			const body = document.body.textContent ?? "";
			if (window.__overnightExport.clickAt && body.includes("Saved to")) {
				window.__overnightExport.savedAt = performance.now();
				observer.disconnect();
			}
		});
		observer.observe(document.body, { subtree: true, childList: true, characterData: true });
	});
	await open.click();
	const dialog = editor.getByRole("dialog");
	if (!quick) {
		await dialog.getByRole("button", { name: "One video", exact: true }).click();
		await dialog.getByRole("button", { name: "MP4", exact: true }).click();
		const buttons = await dialog.getByRole("button").allTextContents();
		fs.writeFileSync(path.join(out, "export-buttons.json"), JSON.stringify(buttons));
		const highest = dialog.getByRole("button", { name: /^(Highest|Source)/ });
		if (await highest.count()) await highest.first().click();
		await dialog.getByRole("button", { name: "60", exact: true }).click();
		await dialog.getByRole("button", { name: "H.264", exact: true }).click();
		await editor.screenshot({ path: path.join(out, "export-settings.png") });
	}
	if (!quick) await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
	await expect(dialog.getByText("Saved to")).toBeVisible({ timeout: 600000 });
	const exportTiming = await editor.evaluate(() => window.__overnightExport);
	if (!exportTiming?.clickAt || !exportTiming?.savedAt)
		throw new Error("Export UI timing event was not observed");
	const elapsed = exportTiming.savedAt - exportTiming.clickAt;
	await expect(dialog.getByText(output, { exact: true })).toBeVisible();
	await editor.screenshot({ path: path.join(out, "export-complete.png") });
	const probe = JSON.parse(
		execFileSync(
			"/opt/homebrew/bin/ffprobe",
			["-v", "error", "-show_format", "-show_streams", "-of", "json", output],
			{ encoding: "utf8", maxBuffer: 10000000 },
		),
	);
	report.export = {
		output,
		sourceSha256: report.loadedSource?.sha256 ?? report.sourceSha256,
		wallMs: elapsed,
		openToSavedMs: performance.now() - clickStart,
		quick,
		timing: exportTiming,
		bytes: fs.statSync(output).size,
		probe,
	};
	console.log(JSON.stringify({ event: "export-complete", wallMs: elapsed, quick, output }));
	return output;
}
async function reviewSmoke(editor) {
	const dialog = editor.getByRole("dialog");
	if (await dialog.isVisible())
		await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
	const seek = editor.getByRole("slider", { name: "Seek video", exact: true });
	await editor.getByRole("button", { name: "Play / Pause", exact: true }).click();
	await expect
		.poll(async () => Number(await seek.inputValue()), { timeout: 10000 })
		.toBeGreaterThan(0.1);
	await editor.getByRole("button", { name: "Play / Pause", exact: true }).click();
	const playbackTimeSec = Number(await seek.inputValue());
	await editor.screenshot({ path: path.join(out, "review-desktop.png") });
	const previousSize = await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((w) =>
			w.webContents.getURL().includes("windowType=editor"),
		);
		const size = {
			content: window.getContentSize(),
			minimum: window.getMinimumSize(),
			maximized: window.isMaximized(),
		};
		if (size.maximized) window.unmaximize();
		window.setMinimumSize(400, 400);
		window.setContentSize(400, 800);
		return size;
	});
	await expect.poll(() => editor.evaluate(() => window.innerWidth)).toBe(400);
	await editor.screenshot({ path: path.join(out, "review-narrow-400px.png") });
	const narrow = await editor.evaluate(() => ({
		width: innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
		buttons: [...document.querySelectorAll("button")].map((b) => ({
			text: b.textContent,
			aria: b.getAttribute("aria-label"),
			bounds: b.getBoundingClientRect().toJSON(),
		})),
	}));
	await app.evaluate(({ BrowserWindow }, size) => {
		const window = BrowserWindow.getAllWindows().find((w) =>
			w.webContents.getURL().includes("windowType=editor"),
		);
		window.setContentSize(...size.content);
		window.setMinimumSize(...size.minimum);
		if (size.maximized) window.maximize();
	}, previousSize);
	await app.evaluate(({ ipcMain }) => {
		globalThis.__overnightPickerCalls = 0;
		ipcMain.removeHandler("pick-export-save-path");
		ipcMain.handle("pick-export-save-path", () => {
			globalThis.__overnightPickerCalls++;
			return { success: true, canceled: true };
		});
	});
	async function menu(id) {
		await app.evaluate(({ Menu, BrowserWindow }, menuId) => {
			const window = BrowserWindow.getAllWindows().find((w) =>
				w.webContents.getURL().includes("windowType=editor"),
			);
			window.focus();
			const item = Menu.getApplicationMenu().getMenuItemById(menuId);
			if (!item) throw new Error(`Missing recording menu ${menuId}`);
			item.click(item, window, {});
		}, id);
	}
	await menu("recording-save");
	await expect.poll(() => app.evaluate(() => globalThis.__overnightPickerCalls)).toBe(1);
	await expect(dialog.getByText("Saved to")).not.toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await editor.getByRole("button", { name: "Save video", exact: true }).click();
	await expect.poll(() => app.evaluate(() => globalThis.__overnightPickerCalls)).toBe(2);
	await expect(dialog.getByText("Saved to")).not.toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await menu("recording-new");
	const hud = await windowFor("hud-overlay");
	await expect(hud.getByTestId("launch-record-button")).toBeVisible();
	report.reviewSmoke = {
		playbackTimeSec,
		narrow,
		pickerCancellations: 2,
		menuSave: true,
		menuRecord: true,
		method: "Invoke real native menu callbacks; only save-picker cancellation is adapted",
	};
}
try {
	const launched = performance.now();
	app = await electron.launch({
		args: [APP_ROOT, "--no-sandbox", "--lang=en-US", `--user-data-dir=${userData}`],
		env: {
			...process.env,
			ELECTRON_USER_DATA_DIR: userData,
			TMPDIR: tmp,
			TMP: tmp,
			TEMP: tmp,
			HEADLESS: "false",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			LANGUAGE: "en_US",
		},
	});
	await app.evaluate(({ app: host }) =>
		host.on("browser-window-created", (_event, w) => {
			console.log("[PROFILE window-created]", Date.now(), w.id);
			w.on("ready-to-show", () =>
				console.log(
					"[PROFILE ready-to-show]",
					Date.now(),
					w.id,
					w.webContents.isLoading(),
					w.webContents.getURL(),
				),
			);
			w.webContents.on("did-finish-load", () =>
				console.log(
					"[PROFILE did-finish-load]",
					Date.now(),
					w.id,
					w.webContents.isLoading(),
					w.webContents.getURL(),
				),
			);
		}),
	);
	child = app.process();
	child.stdout?.on("data", (x) => log.write(x));
	child.stderr?.on("data", (x) => log.write(x));
	app.on("window", (p) =>
		p.on("console", (m) => log.write(`[renderer:${p.url()}] ${m.type()} ${m.text()}\n`)),
	);
	let hud = await windowFor("hud-overlay");
	hud.on("console", (m) => log.write(`[HUD] ${m.type()} ${m.text()}\n`));
	hud.on("dialog", async (dialog) => {
		log.write(`[HUD dialog] ${dialog.type()} ${dialog.message()}\n`);
		await dialog.dismiss();
	});
	await expect(hud.getByTestId("launch-record-button")).toBeVisible({ timeout: 60000 });
	await app.evaluate(({ ipcMain }) => {
		globalThis.__overnightCapture = [];
		const handlers = ipcMain._invokeHandlers;
		for (const name of [
			"start-native-mac-recording",
			"pause-native-mac-recording",
			"resume-native-mac-recording",
			"stop-native-mac-recording",
		]) {
			const original = handlers?.get(name);
			if (original)
				handlers.set(name, async (...args) => {
					const startedAt = performance.now();
					const result = await original(...args);
					globalThis.__overnightCapture.push({
						name,
						startedAt,
						finishedAt: performance.now(),
						result,
					});
					return result;
				});
		}
	});
	report.launchToHudMs = performance.now() - launched;
	const actualHelper = await hud.evaluate(() => window.electronAPI.isNativeMacCaptureAvailable());
	if (actualHelper.helperPath)
		report.actualCaptureHelper = {
			path: actualHelper.helperPath,
			sha256: digest(actualHelper.helperPath),
		};
	console.log(JSON.stringify({ event: "hud-ready", runRoot, launchMs: report.launchToHudMs }));
	if (opt.source) {
		report.source = path.resolve(opt.source);
		report.sourceProbe = JSON.parse(
			execFileSync(
				"/opt/homebrew/bin/ffprobe",
				["-v", "error", "-show_format", "-show_streams", "-of", "json", report.source],
				{ encoding: "utf8", maxBuffer: 10000000 },
			),
		);
		const editor = await loadSource(report.source);
		await exportGui(editor, `${phase}-same-source-export`);
		if (opt["review-smoke"] === "true") await reviewSmoke(editor);
	} else {
		fixture = await chromium.launchPersistentContext(path.join(runRoot, "chrome-profile"), {
			executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			headless: false,
			args: [
				"--no-first-run",
				"--disable-sync",
				"--disable-extensions",
				"--disable-background-networking",
				"--window-size=1280,720",
			],
			viewport: { width: 1280, height: 720 },
		});
		const page = fixture.pages()[0];
		const html =
			opt.static === "true"
				? fixtureHtml
						.replace(/<script>[\s\S]*<\/script>/, "")
						.replace("animation:pulse 1s infinite", "")
						.replace("animation:sweep 3s linear infinite", "")
						.replace(
							"<main id=lines></main>",
							"<main id=lines>STATIC SCREEN CAPTURE — preserve idle duration</main>",
						)
				: fixtureHtml;
		await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		if (opt["change-source"] === "true") {
			const cdp = await fixture.newCDPSession(page);
			const created = fixture.waitForEvent("page");
			await cdp.send("Target.createTarget", {
				url: `data:text/html;charset=utf-8,${encodeURIComponent(html.replace(title, alternateTitle).replace("olle@mac", "ALTERNATE SOURCE"))}`,
				newWindow: true,
				width: 1280,
				height: 720,
			});
			const alternate = await created;
			await alternate.waitForLoadState("domcontentloaded");
			await cdp.detach();
		}
		await page.bringToFront();
		if (opt.fullscreen === "true") {
			// Cover the display with our own fixture. Keep the recorder's real default
			// display selection to verify its ScreenCaptureKit exclusion filter.
			const bounds = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
			const cdp = await fixture.newCDPSession(page);
			const { windowId } = await cdp.send("Browser.getWindowForTarget");
			await cdp.send("Browser.setWindowBounds", {
				windowId,
				bounds: {
					left: bounds.x,
					top: bounds.y,
					width: bounds.width,
					height: bounds.height,
				},
			});
			await cdp.detach();
		}
		await page.screenshot({ path: path.join(out, "capture-fixture.png") });
		if (opt.fullscreen !== "true") await armSource(hud);
		await setupControls(hud);
		report.initialSetup = await hud.evaluate(async () => ({
			source: ((source) =>
				source ? { id: source.id, name: source.name, display_id: source.display_id } : null)(
				await window.electronAPI.getSelectedSource(),
			),
			prefs: await window.electronAPI.getRecordingPrefs(),
			entitlement: await window.electronAPI.getEntitlement(),
			platform: window.electronAPI.getPlatform(),
			native: await window.electronAPI.isNativeMacCaptureAvailable(),
			controls: [...document.querySelectorAll("button")].map((b) => ({
				text: b.textContent,
				aria: b.getAttribute("aria-label"),
				testId: b.dataset.testid,
				pressed: b.getAttribute("aria-pressed"),
				disabled: b.disabled,
			})),
		}));
		await hud
			.screenshot({ path: path.join(out, "hud-before-record.png"), timeout: 5000 })
			.catch((e) => log.write("HUD screenshot: " + e.message + "\n"));
		if (opt.warm === "true") {
			await hud.evaluate(() => {
				void window.electronAPI.showCountdownOverlay(3, 123456789);
			});
			await windowFor("countdown-overlay");
			await expect
				.poll(
					() =>
						app.evaluate(({ BrowserWindow }) =>
							BrowserWindow.getAllWindows().every((w) => !w.webContents.isLoading()),
						),
					{ timeout: 30000 },
				)
				.toBe(true);
			report.overlayWarmState = await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().map((w) => ({
					id: w.id,
					url: w.webContents.getURL(),
					loading: w.webContents.isLoading(),
				})),
			);
			await hud.evaluate(() => window.electronAPI.hideCountdownOverlay(123456789));
		}
		const durations = opt.durations ? opt.durations.split(",").map(Number) : [2, 2, 120];
		for (let i = 0; i < durations.length; i++) {
			if (i > 0) {
				await (await windowFor("editor")).evaluate(() => window.electronAPI.startNewRecording());
				hud = await windowFor("hud-overlay");
				await expect(hud.getByTestId("launch-record-button")).toBeVisible();
				await setupControls(hud);
				const selected = await hud.evaluate(() => window.electronAPI.getSelectedSource());
				if (opt.fullscreen !== "true" && selected?.name !== title) await armSource(hud);
			}
			const recordingDir = path.join(userData, "recordings");
			const beforeFiles = new Set(fs.existsSync(recordingDir) ? fs.readdirSync(recordingDir) : []);
			const stopResponses = await app.evaluate(
				() =>
					globalThis.__overnightCapture.filter(
						(event) => event.name === "stop-native-mac-recording",
					).length,
			);
			await startTiming(hud);
			await hud.getByTestId("launch-record-button").click();
			await expect
				.poll(() => hud.evaluate(() => window.__overnightTiming), {
					timeout: 60000,
					intervals: [20, 20, 20],
				})
				.toHaveProperty("recordingAt");
			const timing = await hud.evaluate(() => window.__overnightTiming);
			const startMs = timing.recordingAt - timing.clickAt;
			console.log(
				JSON.stringify({
					event: "capture-started",
					index: i,
					durationSec: durations[i],
					clickToRecordingMs: startMs,
				}),
			);
			await hud
				.screenshot({ path: path.join(out, `recording-${i}.png`), timeout: 5000 })
				.catch((e) => log.write("HUD recording screenshot: " + e.message + "\n"));
			const elapsed = performance.now();
			const samples = [];
			const pauseEvents = [];
			let pauseCount = 0;
			let killedHelper = false;
			while (performance.now() - elapsed < durations[i] * 1000) {
				if (opt["kill-helper"] === "true" && performance.now() - elapsed >= 2000) {
					const row = execFileSync("/bin/ps", ["-axo", "pid,ppid,comm"], { encoding: "utf8" })
						.split("\n")
						.map((line) => line.trim().split(/\s+/))
						.find(
							([pid, parent, command]) =>
								Number(pid) > 1 &&
								Number(parent) === child.pid &&
								path.basename(command ?? "") === "openscreen-screencapturekit-helper",
						);
					if (!row) throw new Error("No task-owned capture child to terminate");
					process.kill(Number(row[0]), "SIGKILL");
					killedHelper = true;
					report.killedHelper = { pid: Number(row[0]), atMs: performance.now() - elapsed };
					break;
				}
				if (
					opt.pause === "true" &&
					pauseCount < 2 &&
					performance.now() - elapsed >= (pauseCount + 1) * 2000
				) {
					pauseCount += 1;
					const pause = hud.getByRole("button", { name: /^Pause/ }).first();
					pauseEvents.push({ kind: "pause", atMs: performance.now() - elapsed });
					await pause.click();
					if (opt["remove-zero"] === "true" && pauseCount === 1) {
						await hud.getByTestId("hud-remove-previous-clip-button").click();
						await expect(hud.locator("body")).toContainText("00:00");
						pauseEvents.push({ kind: "remove-back-to-zero", atMs: performance.now() - elapsed });
					}
					if (opt["change-source"] === "true" && pauseCount === 1) {
						if (!(await hud.getByTestId("launch-source-selector-button").count()))
							await hud.getByTestId("hud-recording-size-button").click();
						await expect(hud.getByTestId("launch-source-selector-button")).toBeEnabled();
						await armSource(hud, alternateTitle);
						pauseEvents.push({
							kind: "source-change",
							title: alternateTitle,
							atMs: performance.now() - elapsed,
						});
					}
					await new Promise((r) => setTimeout(r, 1000));
					await hud
						.getByRole("button", { name: /^(Continue|Resume)/ })
						.first()
						.click();
					pauseEvents.push({ kind: "resume", atMs: performance.now() - elapsed });
				}
				samples.push({
					elapsedMs: performance.now() - elapsed,
					ps: execFileSync("/bin/ps", ["-axo", "pid,ppid,%cpu,rss,comm"], { encoding: "utf8" })
						.split("\n")
						.filter((line) => {
							const [pid, parent] = line.trim().split(/\s+/);
							return Number(pid) === child.pid || Number(parent) === child.pid;
						}),
				});
				await new Promise((r) =>
					setTimeout(
						r,
						Math.min(1000, Math.max(10, durations[i] * 1000 - (performance.now() - elapsed))),
					),
				);
			}
			const stopStart = performance.now();
			if (!killedHelper) {
				if (opt["pause-stop"] === "true") {
					await hud
						.getByRole("button", { name: /^Pause/ })
						.first()
						.click();
					pauseEvents.push({
						kind: "pause-immediately-before-stop",
						atMs: performance.now() - elapsed,
					});
				}
				await hud.getByTestId("launch-record-button").click();
			}
			await expect
				.poll(
					async () =>
						Boolean(
							completedStopSince(
								await app.evaluate(() => globalThis.__overnightCapture),
								stopResponses,
							),
						),
					{ timeout: 60000, intervals: [10, 10, 10] },
				)
				.toBe(true);
			const editor = await windowFor("editor");
			await expect
				.poll(
					() =>
						app.evaluate(({ BrowserWindow }) =>
							BrowserWindow.getAllWindows().some(
								(window) =>
									window.webContents.getURL().includes("windowType=editor") && window.isVisible(),
							),
						),
					{ timeout: 60000 },
				)
				.toBe(true);
			await expect(editor.getByRole("button", { name: /^(Export|Save video)$/ })).toBeEnabled({
				timeout: 60000,
			});
			const session = await editor.evaluate(() => window.electronAPI.getCurrentRecordingSession());
			const current = await editor.evaluate(() => window.electronAPI.getCurrentVideoPath());
			const nativeHistory = await app.evaluate(() => globalThis.__overnightCapture);
			const lastStop = completedStopSince(nativeHistory, stopResponses);
			let source =
				lastStop?.result?.path ??
				(typeof current === "string" ? current : (current?.path ?? current?.videoPath));
			if (!source) {
				const candidates = fs
					.readdirSync(recordingDir)
					.filter((name) => !beforeFiles.has(name) && /\.(mp4|mov|webm)$/.test(name))
					.map((name) => path.join(recordingDir, name));
				source = candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
				if (!source) throw new Error("Stop produced no durable recorded video");
			}
			const sourceProbe = JSON.parse(
				execFileSync(
					"/opt/homebrew/bin/ffprobe",
					["-v", "error", "-show_format", "-show_streams", "-of", "json", source],
					{ encoding: "utf8", maxBuffer: 10000000 },
				),
			);
			const clips = lastStop?.result?.session?.clips?.filter((clip) => !clip.removed) ?? [];
			const clipProbes = clips.map((clip) => ({
				...clip,
				probe: JSON.parse(
					execFileSync(
						"/opt/homebrew/bin/ffprobe",
						["-v", "error", "-show_format", "-show_streams", "-of", "json", clip.screenVideoPath],
						{ encoding: "utf8", maxBuffer: 10000000 },
					),
				),
			}));
			const reviewDuration = clipProbes.length
				? clipProbes.reduce((total, clip) => total + Number(clip.probe.format.duration), 0)
				: Number(sourceProbe.format.duration);
			await expect
				.poll(
					async () =>
						reviewMatchesRecording(
							Number(
								await editor
									.getByRole("slider", { name: "Seek video", exact: true })
									.getAttribute("max"),
							),
							reviewDuration,
						),
					{ timeout: 60000, intervals: [10, 10, 10] },
				)
				.toBe(true);
			const stopMs = performance.now() - stopStart;
			report.recordings.push({
				durationRequestedSec: durations[i],
				clickToRecordingMs: startMs,
				stopToReviewMs: stopMs,
				source,
				session,
				sourceProbe,
				clipProbes,
				nativeStopMs: lastStop.finishedAt - lastStop.startedAt,
				previewDurationSec: Number(
					await editor.getByRole("slider", { name: "Seek video", exact: true }).getAttribute("max"),
				),
				liveSamples: samples,
				pauseEvents,
				static: opt.static === "true",
				native: nativeHistory,
			});
			console.log(
				JSON.stringify({ event: "capture-stopped", index: i, stopToReviewMs: stopMs, current }),
			);
			await editor.screenshot({ path: path.join(out, `review-${i}.png`) });
			for (const [clipIndex, clip] of clipProbes.entries())
				await fsp.copyFile(
					clip.screenVideoPath,
					path.join(out, `recording-${i}-clip-${clipIndex}.mp4`),
				);
			if (i === durations.length - 1) {
				report.source = source;
				report.sourceArtifact = path.join(out, "source-recording.mp4");
				await fsp.copyFile(source, report.sourceArtifact);
				report.sourceSha256 = digest(source);
				report.sourceProbe = JSON.parse(
					execFileSync(
						"/opt/homebrew/bin/ffprobe",
						["-v", "error", "-show_format", "-show_streams", "-of", "json", source],
						{ encoding: "utf8", maxBuffer: 10000000 },
					),
				);
				if (opt.export !== "false") await exportGui(editor, `${phase}-export`);
				if (opt["review-smoke"] === "true") await reviewSmoke(editor);
			}
		}
	}
	report.host.freeMemoryAtEnd = os.freemem();
	report.host.loadAtEnd = os.loadavg();
	report.status = "passed";
} catch (error) {
	report.status = error.message?.startsWith("Microphone smoke skipped:") ? "skipped" : "failed";
	if (app)
		report.failedWindowState = await app
			.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().map((w) => ({
					id: w.id,
					url: w.webContents.getURL(),
					loading: w.webContents.isLoading(),
					visible: w.isVisible(),
				})),
			)
			.catch(() => []);
	report.error = String(error.stack ?? error);
	console.error(report.error);
	if (app)
		for (const [i, p] of app.windows().entries()) {
			await p
				.screenshot({ path: path.join(out, `failure-${i}.png`), timeout: 5000 })
				.catch((error) => log.write(`Failure screenshot unavailable: ${error.message}\n`));
			await fsp.writeFile(
				path.join(out, `failure-${i}.txt`),
				await p
					.locator("body")
					.innerText()
					.catch(() => p.url()),
			);
		}
	process.exitCode = 1;
} finally {
	if (app)
		report.nativeCaptureHistory = await app
			.evaluate(() => globalThis.__overnightCapture)
			.catch(() => []);
	const workloads = path.join(userData, "diagnostics/workloads");
	if (fs.existsSync(workloads)) {
		await fsp.mkdir(path.join(out, "workloads"), { recursive: true });
		for (const file of fs.readdirSync(workloads)) {
			const workload = JSON.parse(fs.readFileSync(path.join(workloads, file), "utf8"));
			if (["capture", "export"].includes(workload.kind))
				await fsp.copyFile(path.join(workloads, file), path.join(out, "workloads", file));
		}
	}
	await fsp.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
	if (app)
		await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch((error) =>
			log.write(`Graceful close unavailable: ${error.message}\n`),
		);
	if (child && child.exitCode === null) child.kill("SIGKILL");
	if (fixture) await fixture.close();
	log.end();
	console.log(
		JSON.stringify({ event: "report", path: path.join(out, "report.json"), status: report.status }),
	);
}
