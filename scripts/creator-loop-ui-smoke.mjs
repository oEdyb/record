import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const measured = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (measured.status !== "passed" || !measured.runRoot.includes("klippt-overnight-profile-"))
	throw new Error("Expected a passed, task-owned capture profile");
const userData = path.join(measured.runRoot, "user-data");
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], transitions: [], errors: [] };
let app;
async function windowFor(type) {
	let page;
	await expect
		.poll(
			() => {
				page = app.windows().find((candidate) => candidate.url().includes(`windowType=${type}`));
				return Boolean(page);
			},
			{ timeout: 30000 },
		)
		.toBe(true);
	return page;
}
async function menu(page, channel) {
	await app.evaluate(
		({ BrowserWindow }, { url, channel }) => {
			BrowserWindow.getAllWindows()
				.find((win) => win.webContents.getURL() === url)
				.webContents.send(channel);
		},
		{ url: page.url(), channel },
	);
}
async function size(width) {
	await app.evaluate(({ BrowserWindow }, width) => {
		const win = BrowserWindow.getAllWindows().find((win) =>
			win.webContents.getURL().includes("windowType=editor"),
		);
		if (win.isMaximized()) win.unmaximize();
		win.setMinimumSize(400, 400);
		win.setContentSize(width, 800);
	}, width);
}
try {
	app = await electron.launch({
		args: [root, "--no-sandbox", `--user-data-dir=${userData}`],
		env: {
			...process.env,
			ELECTRON_USER_DATA_DIR: userData,
			TMPDIR: path.join(measured.runRoot, "tmp"),
			HEADLESS: "false",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
		},
	});
	app.on("window", (page) => page.on("pageerror", (error) => report.errors.push(error.message)));
	let hud = await windowFor("hud-overlay");
	await hud.getByTestId("launch-open-studio-button").click();
	const editor = await windowFor("editor");
	const record = editor.locator("header").getByRole("button", { name: "Record", exact: true });
	await expect(record).toBeEnabled({ timeout: 30000 });
	await expect(editor.getByRole("button", { name: "Save video", exact: true })).toBeEnabled();
	for (const width of [1200, 400]) {
		await size(width);
		await expect.poll(() => editor.evaluate(() => innerWidth)).toBe(width);
		await editor.screenshot({ path: path.join(out, `review-${width}.png`) });
		await editor.getByRole("button", { name: "Recordings", exact: true }).click();
		const dialog = editor.getByRole("dialog", { name: "Recordings" });
		await expect(dialog.getByRole("searchbox")).toBeFocused();
		await expect(dialog.getByRole("status")).toHaveCount(0);
		await expect
			.poll(() =>
				dialog.evaluate(
					(element) =>
						element.getAnimations().filter((animation) => animation.playState === "running").length,
				),
			)
			.toBe(0);
		await editor.screenshot({ path: path.join(out, `library-${width}.png`) });
		await dialog.getByRole("searchbox").fill("No recording matches this owned query");
		await editor.screenshot({ path: path.join(out, `library-empty-${width}.png`) });
		await dialog.getByRole("searchbox").fill("");
		await dialog.getByRole("searchbox").press("Meta+n");
		await expect(dialog).toBeVisible();
		await menu(editor, "menu-new-project");
		await menu(editor, "menu-save-project");
		await expect(dialog).toBeVisible();
		await dialog.getByRole("searchbox").press("ArrowDown");
		await expect
			.poll(() => editor.evaluate(() => document.activeElement?.textContent))
			.toMatch(/Recording/);
		await editor.keyboard.press("Enter");
		await expect(dialog).toHaveCount(0);
	}
	report.checks.push(
		"Review/library at 1200 and 400 pixels; search focus, ArrowDown and Enter open recording",
	);
	await size(1200);
	await app.evaluate(({ ipcMain }) => {
		const original = ipcMain._invokeHandlers.get("native-bridge:invoke");
		globalThis.__creatorBridge = original;
		globalThis.__creatorListMode = "loading";
		ipcMain._invokeHandlers.set("native-bridge:invoke", async (...args) => {
			if (args[1]?.action === "document.listProjects") {
				if (globalThis.__creatorListMode === "loading")
					await new Promise((resolve) => {
						globalThis.__releaseList = resolve;
					});
				if (globalThis.__creatorListMode === "error") throw new Error("Owned library failure test");
			}
			return original(...args);
		});
	});
	await editor.getByRole("button", { name: "Recordings", exact: true }).click();
	await expect(editor.getByRole("status")).toContainText("Loading");
	await editor.screenshot({ path: path.join(out, "library-loading.png") });
	await size(400);
	await editor.screenshot({ path: path.join(out, "library-loading-400.png") });
	await size(1200);
	await app.evaluate(() => {
		globalThis.__creatorListMode = "error";
		globalThis.__releaseList();
	});
	await expect(editor.getByRole("alert")).toContainText("Could not load recordings");
	await editor.screenshot({ path: path.join(out, "library-error.png") });
	await size(400);
	await editor.screenshot({ path: path.join(out, "library-error-400.png") });
	await size(1200);
	await editor.keyboard.press("Escape");
	await app.evaluate(({ ipcMain }) =>
		ipcMain._invokeHandlers.set("native-bridge:invoke", globalThis.__creatorBridge),
	);
	report.checks.push("Library loading and failed refresh suppress stale selectable rows");
	await app.evaluate(({ ipcMain }) => {
		globalThis.__creatorStartCount = 0;
		globalThis.__creatorStartOriginal = ipcMain._invokeHandlers.get("start-new-recording");
		ipcMain._invokeHandlers.set("start-new-recording", async () => {
			globalThis.__creatorStartCount++;
			await new Promise((resolve) => {
				globalThis.__releaseStart = resolve;
			});
			return { success: false, error: "Owned navigation recovery test" };
		});
	});
	await record.click();
	await expect.poll(() => app.evaluate(() => globalThis.__creatorStartCount)).toBe(1);
	await expect(record).toBeDisabled();
	await menu(editor, "menu-new-project");
	await menu(editor, "menu-new-project");
	await menu(editor, "menu-save-project");
	await menu(editor, "menu-load-project");
	await expect(editor.getByRole("dialog")).toHaveCount(0);
	await expect.poll(() => app.evaluate(() => globalThis.__creatorStartCount)).toBe(1);
	await editor.screenshot({ path: path.join(out, "review-opening.png") });
	await size(400);
	await editor.screenshot({ path: path.join(out, "review-opening-400.png") });
	await size(1200);
	await app.evaluate(() => globalThis.__releaseStart());
	await expect(record).toBeEnabled();
	await expect(editor.getByText("Owned navigation recovery test")).toBeVisible();
	await app.evaluate(({ ipcMain }) =>
		ipcMain._invokeHandlers.set("start-new-recording", globalThis.__creatorStartOriginal),
	);
	report.checks.push(
		"Repeated Record/Save/Recordings commands stay blocked during pending navigation; failure unlocks controls",
	);
	for (let index = 0; index < 3; index++) {
		const began = performance.now();
		await record.click();
		hud = await windowFor("hud-overlay");
		await expect(hud.getByTestId("launch-record-button")).toBeVisible();
		await expect(hud.getByTestId("launch-record-button")).toBeEnabled();
		await expect(hud.locator('[data-recording-layout="compact"]')).toBeVisible();
		const toRecorderMs = performance.now() - began;
		if (index === 0) await hud.screenshot({ path: path.join(out, "recorder-ready.png") });
		if (index === 2) {
			await hud.emulateMedia({ reducedMotion: "reduce" });
			await hud.getByTestId("hud-recording-size-button").click();
			const expanded = hud.locator('[data-recording-layout="full"]');
			await expect(expanded).toBeVisible();
			expect(await expanded.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe(
				"0s",
			);
			await hud.screenshot({ path: path.join(out, "recorder-expanded-reduced-motion.png") });
		}
		const returning = performance.now();
		if (index === 1) {
			// Escape destroys this HUD. Playwright may lose the key-up target after
			// the successful key-down; verify the closed HUD and visible review below.
			await hud.keyboard.press("Escape").catch((error) => {
				if (!hud.isClosed()) throw error;
			});
			await expect.poll(() => hud.isClosed()).toBe(true);
		} else await hud.getByTestId("launch-open-studio-button").click();
		await expect
			.poll(() =>
				app.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()
						.find((win) => win.webContents.getURL().includes("windowType=editor"))
						?.isVisible(),
				),
			)
			.toBe(true);
		await expect(record).toBeEnabled();
		report.transitions.push({ toRecorderMs, toReviewMs: performance.now() - returning });
	}
	expect(report.errors).toEqual([]);
	report.status = "passed";
} catch (error) {
	report.status = "failed";
	report.error = String(error.stack ?? error);
	process.exitCode = 1;
} finally {
	fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
	await app?.close();
	console.log(JSON.stringify(report));
}
