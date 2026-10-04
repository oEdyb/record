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
	profileRequiresSourceDirectory,
	reviewMatchesRecording,
	selectVideoExportChoice,
} from "./overnight-recording-profile-utils.mjs";
import {
	analyzePacketCadence,
	assertCleanNativeStop,
	assertKnownSystemSignal,
	chromeLaunchServicesArgs,
	createQualityFixture,
	cssContrastRatio,
	installedCaptureConfiguration,
	installedCaptureProcesses,
	matchSourceCopy,
	nativeWarningEventsFromDiagnostic,
	ownedCaptureProcessPid,
	ownedChromeProcessPids,
	summarizeDecodedAudioSignal,
	summarizeVideoProbe,
} from "./source-quality-profile-utils.mjs";

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
const runRoot = await fsp.mkdtemp(
	profileRequiresSourceDirectory(opt)
		? "/tmp/klippt-source-profile-"
		: path.join(os.tmpdir(), "klippt-overnight-profile-"),
);
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
function installedCaptureContext() {
	const rows = installedCaptureProcesses(
		execFileSync("/bin/ps", ["-axo", "pid,ppid,%cpu,rss,comm"], { encoding: "utf8" }),
	);
	return {
		at: new Date().toISOString(),
		processes: rows.map((row) => {
			let configuration = null;
			try {
				configuration = installedCaptureConfiguration(
					execFileSync("/bin/ps", ["-p", String(row.pid), "-o", "command="], {
						encoding: "utf8",
					}),
				);
			} catch {
				// A user's recording may finish between the two read-only probes.
			}
			return { ...row, configuration };
		}),
	};
}
report.host.installedCaptureAtStart = installedCaptureContext();
if (opt["export-mode"] === "sources") {
	report.methods.export =
		"Actual Export sources click to Sources exported; native folder picker redirected to owned output; original files copied unchanged";
	report.methods.quality = `${opt.quality ?? "default"} capture profile; native screen pixels, configured 60fps and H.264; actual saved cadence/bitrate measured separately`;
}
const log = fs.createWriteStream(path.join(out, "electron.log"));
let app, fixture, child, launchServicesBrowser;
let sampledFatal = false;
function sampleOwnedFatalCapture() {
	if (sampledFatal || process.env.OPENSCREEN_CAPTURE_DIAGNOSTICS !== "1") return;
	sampledFatal = true;
	const receipt = { at: new Date().toISOString(), helper: report.actualCaptureHelper?.path };
	try {
		const rows = execFileSync("/bin/ps", ["-axo", "pid,ppid,comm"], { encoding: "utf8" });
		receipt.pid = ownedCaptureProcessPid(rows, receipt.helper, child.pid);
		if (!receipt.pid) throw new Error("Owned native helper already exited before sampling");
		receipt.samplePath = path.join(out, "owned-native-fatal-sample.txt");
		receipt.output = execFileSync(
			"/usr/bin/sample",
			[String(receipt.pid), "1", "1", "-file", receipt.samplePath],
			{ encoding: "utf8", timeout: 5000 },
		);
	} catch (error) {
		receipt.error = String(error.message);
	}
	fs.writeFileSync(
		path.join(out, "owned-native-fatal-sample.json"),
		JSON.stringify(receipt, null, 2),
	);
}
function digest(file) {
	const hash = crypto.createHash("sha256");
	const descriptor = fs.openSync(file, "r");
	const buffer = Buffer.alloc(1024 * 1024);
	try {
		for (;;) {
			const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytes === 0) break;
			hash.update(buffer.subarray(0, bytes));
		}
		return hash.digest("hex");
	} finally {
		fs.closeSync(descriptor);
	}
}
for (const file of [
	"dist-electron/bootstrap.js",
	"electron/native/bin/darwin-arm64/openscreen-screencapturekit-helper",
])
	if (fs.existsSync(path.join(APP_ROOT, file)))
		report[file] = { sha256: digest(path.join(APP_ROOT, file)) };
const title =
	opt.fixture === "detailed"
		? "Klippt Deterministic Quality Fixture"
		: `Klippt Overnight Terminal Fixture ${process.pid}`;
const alternateTitle = `Klippt Alternate Fixture ${process.pid}`;
const fixtureHtml =
	opt.fixture === "detailed" ? createQualityFixture(title) : createTerminalFixture(title);
if (opt.fixture === "detailed")
	report.fixtureSha256 = crypto.createHash("sha256").update(fixtureHtml).digest("hex");
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
	if (opt.camera === "true") {
		const permission = await app.evaluate(({ systemPreferences }) =>
			systemPreferences.getMediaAccessStatus("camera"),
		);
		if (permission !== "granted") throw new Error(`Camera permission is ${permission}`);
		await hud.getByTestId("launch-webcam-button").click();
		await expect(hud.getByTestId("launch-webcam-button")).toHaveAttribute("aria-pressed", "true");
	}
	if (opt.quality) {
		await hud.getByTestId("launch-device-settings-button").click();
		report.qualityBeforeSelection = await hud.getByTestId("hud-recording-quality").innerText();
		await hud.getByTestId("hud-recording-quality").click();
		await hud
			.getByRole("option", { name: opt.quality === "high" ? "High" : "Standard", exact: true })
			.click();
		const contrast = async (element) => {
			const colors = await element.evaluate((node) => {
				const text = node.querySelector("span") ?? node;
				let current = node;
				while (current) {
					const background = getComputedStyle(current).backgroundColor;
					if (/^rgb\(/.test(background) || /^rgba\([^)]*,\s*1\)$/.test(background))
						return {
							foreground: getComputedStyle(text).color,
							background,
							hovered: node.matches(":hover"),
						};
					current = current.parentElement;
				}
				throw new Error("No opaque effective panel background");
			});
			const ratio = cssContrastRatio(colors.foreground, colors.background);
			expect(ratio).toBeGreaterThanOrEqual(4.5);
			return { ...colors, ratio };
		};
		const trigger = hud.getByTestId("hud-recording-quality");
		await hud
			.getByRole("button", { name: /Done|Close/, exact: true })
			.last()
			.hover();
		await trigger.evaluate((node) => getComputedStyle(node).backgroundColor);
		await expect
			.poll(() =>
				trigger.evaluate((node) =>
					node.getAnimations().every((animation) => animation.playState !== "running"),
				),
			)
			.toBe(true);
		expect(await trigger.evaluate((node) => node.matches(":hover"))).toBe(false);
		report.uiContrast = { qualityRest: await contrast(trigger) };
		await hud.screenshot({ path: path.join(out, "quality-normal-contrast.png") });
		await trigger.hover();
		expect(await trigger.evaluate((node) => node.matches(":hover"))).toBe(true);
		await trigger.evaluate((node) => getComputedStyle(node).backgroundColor);
		await expect
			.poll(() =>
				trigger.evaluate((node) =>
					node.getAnimations().every((animation) => animation.playState !== "running"),
				),
			)
			.toBe(true);
		report.uiContrast.qualityHover = await contrast(trigger);
		const nativeLabel = hud.getByTestId("hud-native-camera-format");
		if (await nativeLabel.count()) report.uiContrast.nativeCamera = await contrast(nativeLabel);
		await hud.screenshot({ path: path.join(out, "quality-hover-contrast.png") });
		await hud.screenshot({ path: path.join(out, `quality-${opt.quality}-settings.png`) });
		await hud
			.getByRole("button", { name: /Done|Close/, exact: true })
			.last()
			.click();
	}
}
async function sourceMediaHashes() {
	const directory = path.join(userData, "recordings");
	const files = fs.readdirSync(directory).filter((name) => /\.(mp4|mov|webm|m4a|wav)$/i.test(name));
	return files.map((name) => {
		const file = path.join(directory, name);
		return { path: file, file: name, bytes: fs.statSync(file).size, sha256: digest(file) };
	});
}
async function exportSourcesGui(editor) {
	const originalsBefore = await sourceMediaHashes();
	await app.evaluate(({ dialog }, directory) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
	}, out);
	await editor.getByRole("button", { name: "Save video", exact: true }).click();
	await expect(editor.getByRole("button", { name: "Separate takes", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	const exportButton = editor.getByRole("button", { name: "Export sources…", exact: true });
	await expect(exportButton).toBeEnabled();
	await editor.screenshot({ path: path.join(out, "source-export-ready.png") });
	await editor.evaluate(() => {
		window.__sourceExportTiming = {};
		const button = [...document.querySelectorAll("button")].find(
			(b) => b.textContent.trim() === "Export sources…",
		);
		button.addEventListener(
			"click",
			() => {
				window.__sourceExportTiming.clickAt = performance.now();
			},
			{ capture: true, once: true },
		);
		const observer = new MutationObserver(() => {
			if (
				window.__sourceExportTiming.clickAt &&
				document.body.textContent.includes("Sources exported")
			) {
				window.__sourceExportTiming.finishedAt = performance.now();
				observer.disconnect();
			}
		});
		observer.observe(document.body, { subtree: true, childList: true, characterData: true });
	});
	await exportButton.click();
	await expect(editor.getByText("Sources exported", { exact: true })).toBeVisible({
		timeout: 60000,
	});
	const timing = await editor.evaluate(() => window.__sourceExportTiming);
	const native = await app.evaluate(() => globalThis.__sourceExportHistory.at(-1));
	const result = native?.result?.data;
	if (!result?.directory || !result.manifestPath)
		throw new Error("No successful native source-export receipt");
	const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
	const media = fs
		.readdirSync(result.directory)
		.filter((name) => /\.(mp4|mov|webm|m4a|wav)$/i.test(name));
	const hashPairs = media.map((name) => {
		const file = path.join(result.directory, name),
			sha256 = digest(file);
		const original = matchSourceCopy(name, sha256, manifest, native.document, originalsBefore);
		return { exported: file, original: original.path, sha256, bytes: fs.statSync(file).size };
	});
	const originalsAfter = await sourceMediaHashes();
	if (JSON.stringify(originalsBefore) !== JSON.stringify(originalsAfter))
		throw new Error("Source export changed original media");
	if (hashPairs.length < 4)
		throw new Error("Four-source proof requires screen, camera, microphone and system media");
	for (const kind of ["screen", "camera", "microphone", "system"])
		if (!media.some((name) => new RegExp(`^\\d+-${kind}\\.`).test(name)))
			throw new Error(`Four-source export is missing the ${kind} original`);
	for (const pair of hashPairs) {
		pair.probe = JSON.parse(
			execFileSync(
				"/opt/homebrew/bin/ffprobe",
				["-v", "error", "-show_format", "-show_streams", "-of", "json", pair.exported],
				{ encoding: "utf8", maxBuffer: 10_000_000 },
			),
		);
		if (!(Number(pair.probe.format?.duration) > 0))
			throw new Error(`Unreadable or empty exported original: ${pair.exported}`);
		const isVideo = /-(screen|camera)\./.test(pair.exported);
		if (!pair.probe.streams?.some((stream) => stream.codec_type === (isVideo ? "video" : "audio")))
			throw new Error(`Exported original has the wrong stream type: ${pair.exported}`);
		execFileSync(
			"/opt/homebrew/bin/ffmpeg",
			[
				"-v",
				"error",
				"-threads",
				"2",
				"-ss",
				"0.2",
				"-i",
				pair.exported,
				...(isVideo
					? ["-map", "0:v:0", "-frames:v", "1", "-an"]
					: ["-map", "0:a:0", "-t", "0.1", "-vn"]),
				"-f",
				"null",
				"-",
			],
			{ stdio: "pipe", timeout: 30_000 },
		);
		pair.decodeProbePassed = true;
	}
	report.sourceExport = {
		wallMs: timing.finishedAt - timing.clickAt,
		nativeMs: native.finishedAt - native.startedAt,
		result,
		manifest,
		hashPairs,
		originalsBefore,
		originalsAfter,
		method:
			"Actual Save video and default Separate takes Export sources clicks; folder picker only redirected to an owned directory",
	};
	for (const pair of hashPairs.filter((value) =>
		/^\d+-system\./.test(path.basename(value.exported)),
	)) {
		const pcm = execFileSync(
			"/opt/homebrew/bin/ffmpeg",
			[
				"-v",
				"error",
				"-threads",
				"2",
				"-i",
				pair.original,
				"-map",
				"0:a:0",
				"-t",
				"8",
				"-ac",
				"1",
				"-ar",
				"48000",
				"-f",
				"f32le",
				"-",
			],
			{ maxBuffer: 4_000_000, timeout: 30_000 },
		);
		if (pcm.byteLength % 4) throw new Error("Decoded system PCM byte length is invalid");
		pair.systemSignal = {
			original: pair.original,
			sha256: pair.sha256,
			...summarizeDecodedAudioSignal(
				new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4),
			),
			method:
				"Read-only first eight seconds of actual system original, FFmpeg mono 48kHz float PCM; after export timer",
		};
		assertKnownSystemSignal(pair);
	}
	await editor.screenshot({ path: path.join(out, "source-export-success.png") });
	console.log(
		JSON.stringify({
			event: "sources-exported",
			wallMs: report.sourceExport.wallMs,
			directory: result.directory,
		}),
	);
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
	if (quick && (await selectVideoExportChoice(dialog))) {
		await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
	}
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
	if (await selectVideoExportChoice(dialog))
		await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
	await expect.poll(() => app.evaluate(() => globalThis.__overnightPickerCalls)).toBe(1);
	await expect(dialog.getByText("Saved to")).not.toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await editor.getByRole("button", { name: "Save video", exact: true }).click();
	if (await selectVideoExportChoice(dialog))
		await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
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
			...(opt["export-mode"] === "sources" ? { OPENSCREEN_AGENT_CLI: "1" } : {}),
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
	let stdoutLines = "";
	child.stdout?.on("data", (x) => {
		log.write(x);
		if (process.env.OPENSCREEN_CAPTURE_DIAGNOSTICS !== "1") return;
		stdoutLines += x.toString();
		const lines = stdoutLines.split("\n");
		stdoutLines = lines.pop();
		if (lines.some((line) => line.startsWith("OWN_CAPTURE_FATAL_SAMPLE ")))
			sampleOwnedFatalCapture();
	});
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
	await app.evaluate(({ ipcMain, BrowserWindow, app: host }) => {
		globalThis.__overnightCapture = [];
		globalThis.__sourceExportHistory = [];
		globalThis.__nativeFailureHistory = [];
		const observeFailure = (window) => {
			const original = window.webContents.send.bind(window.webContents);
			window.webContents.send = (channel, ...args) => {
				if (channel === "native-mac-recording-error") {
					globalThis.__nativeFailureHistory.push({ at: performance.now(), failure: args[0] });
					if (process.env.OPENSCREEN_CAPTURE_DIAGNOSTICS === "1")
						console.log("OWN_CAPTURE_FATAL_SAMPLE " + JSON.stringify(args[0]));
				}
				return original(channel, ...args);
			};
		};
		for (const window of BrowserWindow.getAllWindows()) observeFailure(window);
		host.on("browser-window-created", (_event, window) => observeFailure(window));
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
						request: args[1],
						startedAt,
						finishedAt: performance.now(),
						result,
					});
					return result;
				});
		}
		const bridge = handlers?.get("native-bridge:invoke");
		if (bridge)
			handlers.set("native-bridge:invoke", async (...args) => {
				if (args[1]?.action !== "document.exportSources") return bridge(...args);
				const startedAt = performance.now(),
					result = await bridge(...args);
				globalThis.__sourceExportHistory.push({
					startedAt,
					finishedAt: performance.now(),
					result,
					document: args[1].payload.document,
				});
				return result;
			});
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
		if (opt["fixture-launch"] === "launchservices") {
			const profile = path.join(runRoot, "chrome-profile");
			execFileSync("/usr/bin/open", chromeLaunchServicesArgs(profile), { encoding: "utf8" });
			const portFile = path.join(profile, "DevToolsActivePort");
			const deadline = performance.now() + 15000;
			while (!fs.existsSync(portFile) && performance.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 100));
			if (!fs.existsSync(portFile))
				throw new Error("Owned LaunchServices Chrome did not start CDP");
			const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
			if (!(port > 0)) throw new Error("Owned Chrome returned no valid private CDP port");
			launchServicesBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
			fixture = launchServicesBrowser.contexts()[0];
			report.fixtureLaunch = "LaunchServices open -n with task-owned profile; CDP observer";
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
			report.fixtureLaunch = "Playwright direct Chrome child with task-owned profile";
		}
		const page = fixture.pages()[0];
		if (launchServicesBrowser) {
			await page.setViewportSize({ width: 1280, height: 720 });
			const session = await fixture.newCDPSession(page);
			const { windowId } = await session.send("Browser.getWindowForTarget");
			await session.send("Browser.setWindowBounds", {
				windowId,
				bounds: { width: 1282, height: 846 },
			});
			report.fixtureChromeCommandLine = await session.send("Browser.getBrowserCommandLine");
			await session.detach();
		}
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
		if (opt.fixture === "detailed")
			await page.getByRole("button", { name: "Start fixture and sound", exact: true }).click();
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
			const failuresBefore = await app.evaluate(() => globalThis.__nativeFailureHistory.length);
			await startTiming(hud);
			const startsBefore = await app.evaluate(
				() =>
					globalThis.__overnightCapture.filter(
						(event) => event.name === "start-native-mac-recording",
					).length,
			);
			await hud.getByTestId("launch-record-button").click();
			await expect
				.poll(
					() =>
						app.evaluate(
							() =>
								globalThis.__overnightCapture.filter(
									(event) => event.name === "start-native-mac-recording",
								).length,
						),
					{ timeout: 60_000, intervals: [20, 20, 20] },
				)
				.toBe(startsBefore + 1);
			const started = await app.evaluate(() =>
				globalThis.__overnightCapture
					.filter((event) => event.name === "start-native-mac-recording")
					.at(-1),
			);
			if (!started.result.success)
				throw new Error(`Actual native Record failed: ${started.result.error}`);
			await expect
				.poll(() => hud.evaluate(() => window.__overnightTiming), {
					timeout: 60000,
					intervals: [20, 20, 20],
				})
				.toHaveProperty("recordingAt");
			const timing = await hud.evaluate(() => window.__overnightTiming);
			const startMs = timing.recordingAt - timing.clickAt;
			if (opt.fixture === "detailed") await page.evaluate(() => window.qualityFixture.reset());
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
			let failedDuringCapture = false;
			while (performance.now() - elapsed < durations[i] * 1000) {
				if ((await app.evaluate(() => globalThis.__nativeFailureHistory.length)) > failuresBefore) {
					failedDuringCapture = true;
					break;
				}
				if (
					opt["kill-helper"] === "true" &&
					performance.now() - elapsed >= Number(opt["kill-at-sec"] ?? 2) * 1000
				) {
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
					await hud.exposeFunction("__rememberNativeFailureProof", (proof) => {
						report.helperFailureProof = proof;
					});
					await hud.evaluate(() => {
						window.__nativeFailureProof = {};
						window.electronAPI.onNativeMacRecordingError((failure) => {
							window.__nativeFailureProof.event = failure;
							window.__nativeFailureProof.observedAt = performance.now();
						});
						const observer = new MutationObserver(() => {
							if (document.body.textContent.includes("Saving completed clips now.")) {
								window.__nativeFailureProof.visibleRecoveryMessage = true;
								window.__nativeFailureProof.toastAt = performance.now();
								void window.__rememberNativeFailureProof(window.__nativeFailureProof);
								observer.disconnect();
							}
						});
						observer.observe(document.body, {
							subtree: true,
							childList: true,
							characterData: true,
						});
					});
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
					if (opt["closed-source"] === "true" && pauseCount === 1) {
						const alternate = fixture.pages().find((candidate) => candidate !== page);
						if (!alternate || (await alternate.title()) !== alternateTitle)
							throw new Error("No owned alternate source window to close");
						await alternate.close();
						const previousResumes = await app.evaluate(
							() =>
								globalThis.__overnightCapture.filter(
									(event) => event.name === "resume-native-mac-recording",
								).length,
						);
						await hud
							.getByRole("button", { name: /^(Continue|Resume)/ })
							.first()
							.click();
						await expect
							.poll(
								() =>
									app.evaluate(
										() =>
											globalThis.__overnightCapture.filter(
												(event) => event.name === "resume-native-mac-recording",
											).length,
									),
								{ timeout: 30_000 },
							)
							.toBe(previousResumes + 1);
						const failure = await app.evaluate(() =>
							globalThis.__overnightCapture
								.filter((event) => event.name === "resume-native-mac-recording")
								.at(-1),
						);
						expect(failure.result.success).toBe(false);
						await expect(
							hud.getByRole("button", { name: /^(Continue|Resume)/ }).first(),
						).toBeEnabled();
						pauseEvents.push({ kind: "closed-owned-source-resume-failed", failure });
						await armSource(hud, title);
					}
					await hud
						.getByRole("button", { name: /^(Continue|Resume)/ })
						.first()
						.click();
					pauseEvents.push({ kind: "resume", atMs: performance.now() - elapsed });
				}
				const allProcessRows = execFileSync("/bin/ps", ["-axo", "pid,ppid,%cpu,rss,comm"], {
					encoding: "utf8",
				});
				samples.push({
					elapsedMs: performance.now() - elapsed,
					installedCaptureProcesses: installedCaptureProcesses(allProcessRows),
					ps: allProcessRows.split("\n").filter((line) => {
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
			if (opt.fixture === "detailed")
				report.fixtureStats = await page.evaluate(() => window.qualityFixture.stats());
			if (!killedHelper && !failedDuringCapture) {
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
				await hud
					.getByTestId("launch-record-button")
					.click()
					.catch((error) => {
						// The real Stop can destroy its HUD before Playwright finishes the
						// click. Never retry; only a new native Stop receipt can validate it.
						report.stopClickCompletionError = String(error);
					});
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
			const failureHistory = await app.evaluate(() => globalThis.__nativeFailureHistory);
			if (!killedHelper && failureHistory.length > failuresBefore)
				throw new Error(
					`Actual capture failed after starting: ${failureHistory.at(-1).failure.message}`,
				);
			const editor = await windowFor("editor");
			if (killedHelper) {
				report.helperFailureProof ??= await hud
					.evaluate(() => window.__nativeFailureProof)
					.catch(() => ({}));
				expect(report.helperFailureProof.event?.message).toBeTruthy();
				expect(report.helperFailureProof.visibleRecoveryMessage).toBe(true);
			}
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
			if (killedHelper) {
				await expect(editor.getByRole("status")).toContainText("Recording stopped unexpectedly");
				await expect(
					editor.getByRole("button", { name: "Record again", exact: true }),
				).toBeEnabled();
				await editor.screenshot({ path: path.join(out, "interruption-before-reopen.png") });
				await editor.reload();
				await expect(editor.getByRole("status")).toContainText("Recording stopped unexpectedly", {
					timeout: 60000,
				});
				await editor.getByText("Why it stopped", { exact: true }).click();
				await editor.screenshot({ path: path.join(out, "interruption-after-reopen.png") });
				report.persistentInterruption = { visible: true, survivedReload: true };
			}
			const session = await editor.evaluate(() => window.electronAPI.getCurrentRecordingSession());
			const current = await editor.evaluate(() => window.electronAPI.getCurrentVideoPath());
			const nativeHistory = await app.evaluate(() => globalThis.__overnightCapture);
			const lastStop = completedStopSince(nativeHistory, stopResponses);
			if (!killedHelper) assertCleanNativeStop(lastStop?.result);
			else if (lastStop?.result?.success !== true)
				throw new Error("Expected helper-crash recovery did not return a durable native Stop");
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
				if (opt["export-mode"] === "sources") await exportSourcesGui(editor);
				else if (opt.export !== "false") await exportGui(editor, `${phase}-export`);
				if (opt.fixture === "detailed") {
					const countedProbe = JSON.parse(
						execFileSync(
							"/opt/homebrew/bin/ffprobe",
							[
								"-v",
								"error",
								"-count_packets",
								"-show_format",
								"-show_streams",
								"-of",
								"json",
								source,
							],
							{ encoding: "utf8" },
						),
					);
					report.qualityMetrics = summarizeVideoProbe(countedProbe);
					const packetProbe = JSON.parse(
						execFileSync(
							"/opt/homebrew/bin/ffprobe",
							[
								"-v",
								"error",
								"-select_streams",
								"v:0",
								"-show_streams",
								"-show_packets",
								"-show_entries",
								"packet=stream_index,pts_time,dts_time,duration_time",
								"-of",
								"json",
								source,
							],
							{ encoding: "utf8", maxBuffer: 128_000_000 },
						),
					);
					await fsp.writeFile(path.join(out, "screen-packets.json"), JSON.stringify(packetProbe));
					report.packetCadence = analyzePacketCadence(packetProbe);
					if (
						opt["export-mode"] === "sources" &&
						opt.quality === "high" &&
						!report.packetCadence.lockedFrameGrid
					)
						throw new Error(
							`Actual High source has ${report.packetCadence.violations.length} non-60fps packet intervals`,
						);
				}
				if (opt["review-smoke"] === "true") await reviewSmoke(editor);
			}
		}
	}
	report.host.freeMemoryAtEnd = os.freemem();
	report.host.loadAtEnd = os.loadavg();
	report.host.installedCaptureAtEnd = installedCaptureContext();
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
	if (
		app &&
		(process.env.OPENSCREEN_CAPTURE_DIAGNOSTICS === "1" || opt["export-mode"] === "sources")
	) {
		const diagnosticPath = path.join(out, "native-diagnostic.json");
		try {
			// Adapt only the native file picker; the app's real diagnostic serializer
			// supplies the helper output before its recording service is destroyed.
			await app.evaluate(({ dialog }, filePath) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath });
			}, diagnosticPath);
			const page = app
				.windows()
				.find((window) => /\bwindowType=(hud-overlay|editor)\b/.test(window.url()));
			report.nativeDiagnostic = page
				? await page.evaluate(
						(error) => window.electronAPI.saveDiagnostic({ error }),
						report.error ?? "Owned all-source capture timing diagnostic",
					)
				: { success: false, error: "No live owned renderer for diagnostic capture" };
			if (report.nativeDiagnostic.success && fs.existsSync(diagnosticPath)) {
				report.nativeWarningEvents = nativeWarningEventsFromDiagnostic(
					JSON.parse(fs.readFileSync(diagnosticPath, "utf8")),
				);
				report.nativeWarningAudit = {
					method:
						"Real diagnostic serializer after all capture/export timings; production env unchanged",
					source: diagnosticPath,
				};
			}
		} catch (error) {
			report.nativeDiagnostic = { success: false, error: String(error) };
		}
	}
	if (app)
		report.nativeCaptureHistory = await app
			.evaluate(() => globalThis.__overnightCapture)
			.catch(() => []);
	if (app)
		report.sourceExportHistory = await app
			.evaluate(() => globalThis.__sourceExportHistory)
			.catch(() => []);
	if (app)
		report.nativeFailureHistory = await app
			.evaluate(() => globalThis.__nativeFailureHistory)
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
	if (launchServicesBrowser) {
		try {
			await Promise.race([
				(async () => {
					const session = await launchServicesBrowser.newBrowserCDPSession();
					await session.send("Browser.close");
				})(),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Owned Chrome close timed out")), 5000),
				),
			]);
		} catch {
			// Chrome may disconnect before the close response; owned PID cleanup follows.
		}
	}
	if (fixture)
		await Promise.race([
			fixture.close(),
			new Promise((resolve) => setTimeout(resolve, 5000)),
		]).catch((error) => log.write(`Fixture close unavailable: ${error.message}\n`));
	const findOwnedChrome = () =>
		ownedChromeProcessPids(
			execFileSync("/bin/ps", ["-axo", "pid,ppid,args"], { encoding: "utf8" }),
			path.join(runRoot, "chrome-profile"),
			process.pid,
			opt["fixture-launch"] === "launchservices",
		);
	const cleanup = { before: findOwnedChrome(), term: [], kill: [] };
	for (const pid of cleanup.before) {
		try {
			process.kill(pid, "SIGTERM");
			cleanup.term.push(pid);
		} catch {
			/* Process may exit between probes. */
		}
	}
	const cleanupDeadline = performance.now() + 2000;
	while (findOwnedChrome().length && performance.now() < cleanupDeadline)
		await new Promise((resolve) => setTimeout(resolve, 100));
	for (const pid of findOwnedChrome()) {
		try {
			process.kill(pid, "SIGKILL");
			cleanup.kill.push(pid);
		} catch {
			/* Only a revalidated private profile is selected. */
		}
	}
	if (cleanup.kill.length) await new Promise((resolve) => setTimeout(resolve, 300));
	cleanup.after = findOwnedChrome();
	await fsp.writeFile(path.join(out, "chrome-cleanup.json"), JSON.stringify(cleanup, null, 2));
	if (cleanup.after.length) process.exitCode = 1;
	await new Promise((resolve) => log.end(resolve));
	console.log(
		JSON.stringify({ event: "report", path: path.join(out, "report.json"), status: report.status }),
	);
	// Playwright may retain an already-disconnected inspector after a failed
	// launch. Owned apps and durable writes are closed before ending this driver.
	process.exit(process.exitCode ?? 0);
}
