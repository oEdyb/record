#!/usr/bin/env node
// Real recorder UI checks on an existing task-owned private profile. No installed app.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createOwnedCutOperations,
	executeProfileCli,
	matchSourceCopy,
	verifySelectedQuality,
} from "./source-quality-profile-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron: electron, expect } = require("@playwright/test");
const measured = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (measured.status !== "passed" || !measured.runRoot?.startsWith("/tmp/klippt-source-profile-"))
	throw new Error("Use a successful owned four-source profile");
const projectId = measured.sourceExportHistory.at(-1)?.document?.project?.id;
if (!projectId) throw new Error("No durable measured project identity");
const userData = path.join(measured.runRoot, "user-data");
const out = path.join(path.dirname(path.resolve(process.argv[2])), "ui-smoke-final");
await fsp.mkdir(out, { recursive: true });
const env = {
	...process.env,
	ELECTRON_USER_DATA_DIR: userData,
	OPENSCREEN_AGENT_CLI: "1",
	TMPDIR: path.join(measured.runRoot, "tmp"),
	HEADLESS: "false",
	LANG: "en_US.UTF-8",
	LC_ALL: "en_US.UTF-8",
};
const proof = {
	measurementSource: path.resolve(process.argv[2]),
	userData,
	projectId,
	consoleErrors: [],
	checks: [],
};
let app;
function digest(file) {
	const hash = crypto.createHash("sha256"),
		fd = fs.openSync(file, "r");
	const buffer = Buffer.alloc(1024 * 1024);
	try {
		for (;;) {
			const count = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (!count) break;
			hash.update(buffer.subarray(0, count));
		}
		return hash.digest("hex");
	} finally {
		fs.closeSync(fd);
	}
}
async function cli(args, label) {
	let stdout;
	try {
		({ stdout } = await executeProfileCli(
			"/Users/olle/.local/bin/klippt",
			["agent", ...args, "--json"],
			{
				env,
				encoding: "utf8",
				timeout: 60_000,
				maxBuffer: 10_000_000,
			},
		));
	} catch (error) {
		stdout = error.stdout;
		if (!stdout) throw error;
	}
	const result = JSON.parse(stdout);
	fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(result, null, 2));
	if (result.status !== "completed") throw new Error(JSON.stringify(result));
	return result.data;
}
async function ownedCutExport(editor) {
	const originalPath = path.join(userData, "projects", `${projectId}.klippt`);
	const beforeHash = digest(originalPath);
	const cloned = await cli(
		["clone", "--project", originalPath, "--title", "Owned current-source cut verification"],
		"cuts-clone",
	);
	if (
		cloned.project_id === projectId ||
		!cloned.path.startsWith(path.join(userData, "projects") + path.sep)
	)
		throw new Error("CLI clone escaped its private project boundary");
	await cli(["open", "--project_id", cloned.project_id], "cuts-open");
	const inspected = await cli(["inspect", "--project", cloned.path], "cuts-before");
	const operations = createOwnedCutOperations(inspected.clips[0]);
	const operationsPath = path.join(out, "cuts-operations.json");
	fs.writeFileSync(operationsPath, JSON.stringify(operations, null, 2));
	const planned = await cli(
		["plan", "--project_id", cloned.project_id, "--input", operationsPath],
		"cuts-plan",
	);
	if (planned.introduced?.counts?.error !== 0) throw new Error("Owned cut plan introduced errors");
	const candidate = await cli(["inspect", "--project", planned.candidatePath], "cuts-candidate");
	if (candidate.id !== cloned.project_id || candidate.counts.trims !== 2)
		throw new Error("Owned cut candidate does not contain the two requested trims");
	const requestId = `source-quality-cuts-${crypto.randomUUID()}`;
	try {
		await cli(
			[
				"apply",
				"--project_id",
				cloned.project_id,
				"--plan_id",
				planned.planId,
				"--request_id",
				requestId,
			],
			"cuts-apply",
		);
	} catch (error) {
		// A committed mutation is never repeated for evidence. Read its original receipt.
		try {
			await cli(
				["receipt", "--project_id", cloned.project_id, "--request_id", requestId],
				"cuts-recovery-receipt",
			);
		} catch {
			/* The original error and durable envelope remain the failure evidence. */
		}
		throw error;
	}
	await app.evaluate(({ ipcMain, dialog: native }, directory) => {
		const handler = ipcMain._invokeHandlers.get("native-bridge:invoke");
		ipcMain._invokeHandlers.set("native-bridge:invoke", async (...args) => {
			const result = await handler(...args);
			if (args[1]?.action === "document.exportSources")
				globalThis.__cutSourceExport = { result, document: args[1].payload.document };
			return result;
		});
		native.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
	}, out);
	const dialog = await saveDialog(editor);
	await dialog.getByRole("button", { name: "Separate takes", exact: true }).click();
	await dialog.getByRole("button", { name: "Export sources…", exact: true }).click();
	await expect(dialog.getByText("Sources exported", { exact: true })).toBeVisible({
		timeout: 60_000,
	});
	const exported = await app.evaluate(() => globalThis.__cutSourceExport);
	if (!exported?.result?.data?.directory) throw new Error("No current cut source-export receipt");
	const manifest = JSON.parse(fs.readFileSync(exported.result.data.manifestPath, "utf8"));
	const hashPairs = fs
		.readdirSync(exported.result.data.directory)
		.filter((name) => /\.(mp4|mov|m4a|webm|wav)$/i.test(name))
		.map((name) => {
			const media = path.join(exported.result.data.directory, name),
				sha256 = digest(media);
			const original = matchSourceCopy(
				name,
				sha256,
				manifest,
				exported.document,
				measured.sourceExport.originalsBefore,
			);
			if (digest(original.path) !== sha256)
				throw new Error("Owned cut export changed original media");
			return { exported: media, original: original.path, sha256 };
		});
	if (hashPairs.length < 4 || digest(originalPath) !== beforeHash)
		throw new Error("Owned cuts changed the original project or lost source tracks");
	proof.cutExport = {
		originalPath,
		originalProjectSha256: beforeHash,
		cloned,
		operations,
		requestId,
		...exported,
		hashPairs,
	};
}
async function windowFor(kind) {
	await expect
		.poll(
			() =>
				app
					.windows()
					.find((page) => page.url().includes(`windowType=${kind}`))
					?.url(),
			{ timeout: 60_000 },
		)
		.toContain(`windowType=${kind}`);
	const page = app.windows().find((page) => page.url().includes(`windowType=${kind}`));
	await page.waitForLoadState("domcontentloaded");
	return page;
}
async function launch() {
	app = await electron.launch({
		args: [root, "--no-sandbox", "--lang=en-US", `--user-data-dir=${userData}`],
		env,
	});
	app.on("window", (page) =>
		page.on("console", (message) => {
			if (message.type() === "error")
				proof.consoleErrors.push({ url: page.url(), text: message.text() });
		}),
	);
	const hud = await windowFor("hud-overlay");
	await expect(hud.getByTestId("launch-record-button")).toBeVisible();
	await hud.getByTestId("launch-device-settings-button").click();
	const quality = await hud.getByTestId("hud-recording-quality").innerText();
	await expect(hud.getByTestId("hud-recording-quality")).toHaveText(
		measured.options.quality === "standard" ? "Standard" : "High",
	);
	const prefs = await hud.evaluate(() => window.electronAPI.getRecordingPrefs());
	verifySelectedQuality(quality, prefs.recordingQuality, measured.options.quality);
	proof.checks.push({
		qualityRememberedAcrossRestart: quality,
		persistedQuality: prefs.recordingQuality,
	});
	await hud
		.getByRole("button", { name: /Done|Close/, exact: true })
		.last()
		.click();
	await cli(["open", "--project_id", projectId], "open-existing-owned-project");
	const editor = await windowFor("editor");
	await expect(editor.getByRole("button", { name: "Save video", exact: true })).toBeEnabled({
		timeout: 60_000,
	});
	return editor;
}
async function saveDialog(editor) {
	await editor.getByRole("button", { name: "Save video", exact: true }).click();
	await expect(editor.getByRole("button", { name: "Separate takes", exact: true })).toBeVisible();
	return editor.getByRole("dialog");
}
try {
	let editor = await launch();
	let dialog = await saveDialog(editor);
	await expect(dialog.getByRole("button", { name: "Separate takes", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	proof.checks.push({ separateTakesDefault: true });
	await dialog.getByRole("button", { name: "One video", exact: true }).click();
	await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
	dialog = await saveDialog(editor);
	await expect(dialog.getByRole("button", { name: "One video", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await app.evaluate(({ dialog: native }) => {
		globalThis.__smokeSavePickerCalls = 0;
		native.showSaveDialog = async () => {
			globalThis.__smokeSavePickerCalls++;
			return { canceled: true, filePath: undefined };
		};
	});
	await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
	await expect.poll(() => app.evaluate(() => globalThis.__smokeSavePickerCalls)).toBe(1);
	await expect(dialog.getByRole("button", { name: "Export MP4", exact: true })).toBeEnabled();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	proof.checks.push({ oneVideoRememberedAcrossReopen: true, canceledOneVideoSave: true });
	await app.close();
	app = undefined;
	editor = await launch();
	dialog = await saveDialog(editor);
	await expect(dialog.getByRole("button", { name: "One video", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	proof.checks.push({ oneVideoRememberedAcrossRestart: true });
	await dialog.getByRole("button", { name: "Separate takes", exact: true }).click();
	await app.evaluate(({ dialog: native }) => {
		globalThis.__smokeFolderCalls = 0;
		native.showOpenDialog = async () => {
			globalThis.__smokeFolderCalls++;
			return new Promise((resolve) => {
				globalThis.__smokeFolderRelease = resolve;
			});
		};
	});
	await dialog.getByRole("button", { name: "Export sources…", exact: true }).click();
	await expect.poll(() => app.evaluate(() => globalThis.__smokeFolderCalls)).toBe(1);
	await expect(
		editor.getByRole("button", { name: "Record", exact: true, includeHidden: true }),
	).toBeDisabled();
	await expect(
		editor.getByRole("button", { name: "Recordings", exact: true, includeHidden: true }),
	).toBeDisabled();
	await app.evaluate(({ BrowserWindow, Menu }) => {
		const review = BrowserWindow.getAllWindows().find((window) =>
			window.webContents.getURL().includes("windowType=editor"),
		);
		for (const id of ["recording-new", "recording-library"]) {
			const item = Menu.getApplicationMenu().getMenuItemById(id);
			item.click(item, review, {});
		}
	});
	await expect(dialog.getByText("Copying original files…", { exact: true })).toBeVisible();
	const windowsDuringPicker = await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().map((window) => ({
			url: window.webContents.getURL(),
			visible: window.isVisible(),
		})),
	);
	expect(
		windowsDuringPicker.some(
			(window) => window.url.includes("windowType=hud-overlay") && window.visible,
		),
	).toBe(false);
	proof.checks.push({
		sourcesPickerBlocksRecordAndOpen: true,
		method:
			"Actual toolbar disabled state and native accelerator menu callbacks while only the native picker is held",
		windowsDuringPicker,
	});
	await app.evaluate(() => globalThis.__smokeFolderRelease({ canceled: true, filePaths: [] }));
	await expect(dialog.getByRole("button", { name: "Export sources…", exact: true })).toBeEnabled();
	await app.evaluate(({ dialog: native }, directory) => {
		native.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
	}, out);
	await dialog.getByRole("button", { name: "Export sources…", exact: true }).click();
	await expect(dialog.getByText("Sources exported", { exact: true })).toBeVisible({
		timeout: 60_000,
	});
	proof.checks.push({ sourcesCanceledThenRetried: true });
	await editor.screenshot({ path: path.join(out, "source-dialog-desktop.png") });
	await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
	const seek = editor.getByRole("slider", { name: "Seek video", exact: true });
	await editor.getByRole("button", { name: "Play / Pause", exact: true }).click();
	await expect
		.poll(async () => Number(await seek.inputValue()), { timeout: 10_000 })
		.toBeGreaterThan(0.2);
	await editor.getByRole("button", { name: "Play / Pause", exact: true }).click();
	const playedToSec = Number(await seek.inputValue());
	await seek.press("End");
	await seek.press("ArrowLeft");
	proof.checks.push({
		reviewPlaybackAdvancedToSec: playedToSec,
		tailSeekSec: Number(await seek.inputValue()),
	});
	await editor.screenshot({ path: path.join(out, "review-tail.png") });
	await editor.screenshot({ path: path.join(out, "review-desktop.png") });
	await app.evaluate(({ BrowserWindow }) => {
		const review = BrowserWindow.getAllWindows().find((window) =>
			window.webContents.getURL().includes("windowType=editor"),
		);
		if (review.isMaximized()) review.unmaximize();
		review.setMinimumSize(400, 400);
		review.setContentSize(400, 800);
	});
	await expect.poll(() => editor.evaluate(() => innerWidth)).toBe(400);
	await editor.screenshot({ path: path.join(out, "review-narrow-400px.png") });
	proof.narrow = await editor.evaluate(() => ({
		width: innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(proof.narrow.scrollWidth).toBe(400);
	dialog = await saveDialog(editor);
	await expect(dialog.getByRole("button", { name: "Separate takes", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await editor.screenshot({ path: path.join(out, "source-dialog-narrow-400px.png") });
	await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
	if (measured.qualityMetrics?.durationSec >= 119.5) await ownedCutExport(editor);
	proof.status = "passed";
} catch (error) {
	proof.status = "failed";
	proof.error = String(error.stack ?? error);
	process.exitCode = 1;
	if (app)
		for (const [index, page] of app.windows().entries()) {
			await page
				.screenshot({ path: path.join(out, `failure-${index}.png`), timeout: 5000 })
				.catch((error) => {
					proof.screenshotError = error.message;
				});
			await fsp.writeFile(
				path.join(out, `failure-${index}.txt`),
				await page
					.locator("body")
					.innerText()
					.catch(() => page.url()),
			);
		}
} finally {
	await fsp.writeFile(path.join(out, "report.json"), JSON.stringify(proof, null, 2));
	if (app) {
		const child = app.process();
		await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 5000))]).catch(
			() => undefined,
		);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	console.log(JSON.stringify({ event: "ui-smoke", status: proof.status, out, error: proof.error }));
	process.exit(process.exitCode ?? 0);
}
