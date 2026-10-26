import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { build } from "esbuild";

function preloadFixture() {
	const { ipcRenderer } = require("electron");
	let api;
	let dockListener;
	let pointerListener;
	window.__nativePointerProof = { suppressedDomEvents: 0, deliveredProbes: 0 };
	for (const type of [
		"pointermove",
		"pointerover",
		"pointerout",
		"pointerenter",
		"pointerleave",
		"mousemove",
		"mouseover",
		"mouseout",
		"mouseenter",
		"mouseleave",
	]) {
		window.addEventListener(
			type,
			(event) => {
				window.__nativePointerProof.suppressedDomEvents++;
				event.stopImmediatePropagation();
			},
			true,
		);
	}
	ipcRenderer.on("fixture-probe", (_event, point) => {
		window.__nativePointerProof.deliveredProbes++;
		window.__nativePointerProof.lastPoint = point;
		pointerListener?.(point);
	});
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		get: () => api,
		set(value) {
			api = value;
			api.onHudDockChanged = (callback) => {
				dockListener = callback;
				window.__nativePointerProof.dockSubscribed = true;
				return () => {
					dockListener = undefined;
				};
			};
			api.setHudDock = (side) => dockListener?.(side);
			api.onHudPointerCheck = (callback) => {
				pointerListener = callback;
				window.__nativePointerProof.pointerSubscribed = true;
				return () => {
					pointerListener = undefined;
				};
			};
			api.setHudOverlayIgnoreMouseEvents = (ignore) => ipcRenderer.send("fixture-ignore", ignore);
			api.getPlatform = () => "darwin";
		},
	});
}

async function nativeFixture(config, createHudPointerWatch, hudPointerProbe, settleMs) {
	const { app, BrowserWindow, ipcMain, screen } = require("electron");
	const fs = require("node:fs/promises");
	const path = require("node:path");
	app.setName("Klippt Native Pointer Fixture");
	app.setPath("userData", path.join(config.run, "profile"));
	const report = {
		scope: "isolated native window + current HUD renderer; DOM pointer events suppressed",
		stages: [],
		probes: [],
		ignoreChanges: [],
		lifecycle: [],
		ignoreRequests: [],
		rendererMessages: [],
		cursorReads: 0,
	};
	let win;
	let watch;
	let ignored;
	let origin;
	const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	function assert(condition, message) {
		if (!condition) throw Error(message);
	}
	function stationary() {
		const point = screen.getCursorScreenPoint();
		assert(
			!report.cursorMoved && point.x === origin.x && point.y === origin.y,
			"Real cursor moved; proof is invalid. Keep the pointer stationary during this fixture.",
		);
	}
	function setIgnore(ignore) {
		if (ignored === ignore) return;
		win.setIgnoreMouseEvents(ignore, { forward: true });
		ignored = ignore;
		report.ignoreChanges.push({ at: Date.now(), ignore });
	}
	function readState() {
		const bar = document.querySelector("[data-recording-layout]");
		const grip = document.querySelector("[data-hud-grip]");
		const tab = document.querySelector('[data-testid="hud-dock-tab"]');
		const rect = (grip ?? tab)?.getBoundingClientRect();
		const point = window.__nativePointerProof?.lastPoint;
		const hit = point ? document.elementFromPoint(point.x, point.y) : null;
		return {
			ready: !!bar && !!tab && !!rect,
			tucked: bar?.getAttribute("data-tucked"),
			rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
			proof: window.__nativePointerProof,
			hit: hit?.outerHTML.slice(0, 600),
			interactiveHit: !!hit?.closest("[data-hud-interactive='true']"),
		};
	}
	async function waitFor(predicate, message, timeout = 5000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			stationary();
			const state = await win.webContents.executeJavaScript(`(${readState.toString()})()`);
			if (predicate(state)) return state;
			await delay(40);
		}
		throw Error(message);
	}
	async function stage(name, predicate, message) {
		const immediate = await waitFor(predicate, message);
		const at = Date.now();
		if (name === "expanded-0" || name === "transparent-0") {
			const frames = [];
			while (Date.now() - at < settleMs) {
				const capturedAt = Date.now();
				const frame = await win.webContents.capturePage();
				const file = `${name}-frame-${String(frames.length).padStart(2, "0")}.png`;
				await fs.writeFile(path.join(config.run, file), frame.toPNG());
				frames.push({ file, capturedAt, elapsedMs: capturedAt - at });
				await delay(45);
			}
			report.motionFrames ??= {};
			report.motionFrames[name] = frames;
		} else await delay(settleMs);
		const state = await waitFor(predicate, `${message} after settling`);
		report.stages.push({
			name,
			at,
			immediate,
			settledAt: Date.now(),
			state,
			ignored,
			bounds: win.getContentBounds(),
		});
		const image = await win.webContents.capturePage();
		await fs.writeFile(path.join(config.run, `${name}.png`), image.toPNG());
		return state;
	}
	try {
		await app.whenReady();
		origin = screen.getCursorScreenPoint();
		report.cursor = origin;
		win = new BrowserWindow({
			width: 940,
			height: 600,
			x: origin.x + 100,
			y: origin.y + 100,
			frame: false,
			type: "panel",
			alwaysOnTop: true,
			transparent: true,
			backgroundColor: "#00000000",
			hasShadow: false,
			show: false,
			skipTaskbar: true,
			enableLargerThanScreen: true,
			webPreferences: {
				preload: path.join(config.run, "preload.cjs"),
				contextIsolation: false,
				nodeIntegration: false,
				sandbox: false,
				backgroundThrottling: false,
			},
		});
		win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
			callback(false),
		);
		win.webContents.session.setPermissionCheckHandler(() => false);
		ipcMain.on("fixture-ignore", (event, ignore) => {
			if (event.sender.id === win.webContents.id && typeof ignore === "boolean") {
				report.ignoreRequests.push({ at: Date.now(), ignore });
				setIgnore(ignore);
			}
		});
		win.webContents.on("console-message", (event) =>
			report.rendererMessages.push({ message: event.message, level: event.level }),
		);
		setIgnore(true);
		watch = createHudPointerWatch({
			platform: process.platform,
			isVisible: () => !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
			isDragging: () => false,
			readPoint: () => {
				report.cursorReads++;
				const cursor = screen.getCursorScreenPoint();
				if (cursor.x !== origin.x || cursor.y !== origin.y) report.cursorMoved = true;
				return hudPointerProbe(cursor, win.getContentBounds());
			},
			onOutside: () => setIgnore(true),
			onProbe: (point) => {
				report.probes.push({ at: Date.now(), point });
				win.webContents.send("fixture-probe", point);
			},
		});
		win.on("show", () => {
			report.lifecycle.push({
				event: "show",
				visible: win.isVisible(),
				minimized: win.isMinimized(),
				at: Date.now(),
			});
			watch.start();
		});
		win.on("hide", () => {
			report.lifecycle.push({ event: "hide", visible: win.isVisible(), at: Date.now() });
		});
		win.on("closed", () => watch.stop());
		watch.start();
		await win.loadURL(config.url);
		win.showInactive();
		await waitFor(
			(state) => state.proof?.dockSubscribed && state.proof?.pointerSubscribed,
			"HUD did not subscribe to fixture dock and native pointer events",
		);
		await win.webContents.executeJavaScript('window.electronAPI.setHudDock("top")');
		await stage(
			"initial-collapsed",
			(state) => state.ready && state.tucked === "top",
			"HUD did not collapse",
		);
		await delay(700);
		const collapsed = await waitFor(
			(state) => state.ready && state.tucked === "top",
			"HUD did not settle",
		);
		const rect = collapsed.rect;
		const target = {
			x: Math.round(origin.x - rect.x - rect.width / 2),
			y: Math.round(origin.y - rect.y - 10),
		};
		for (let cycle = 0; cycle < 5; cycle++) {
			stationary();
			setIgnore(true);
			win.setPosition(target.x, target.y);
			await stage(
				`expanded-${cycle}`,
				(state) => state.ready && state.tucked === null && ignored === false,
				"Stationary native probe failed to expand the click-through HUD",
			);
			await delay(900);
			await waitFor((state) => state.tucked === null, "HUD collapsed under the stationary cursor");
			win.setPosition(origin.x - 10, origin.y - 10);
			await stage(
				`transparent-${cycle}`,
				(state) => state.tucked === "top" && ignored === true,
				"Transparent renderer area failed to restore click-through",
			);
			win.setPosition(target.x + 1100, target.y);
			await stage(
				`collapsed-${cycle}`,
				(state) => state.tucked === "top" && ignored === true,
				"Moving the fixture away did not collapse and restore click-through",
			);
			await delay(700);
		}
		win.setPosition(origin.x - 10, origin.y - 10);
		await delay(200);
		report.lifecycle.push({ event: "before-hide", visible: win.isVisible(), at: Date.now() });
		const probeCount = report.probes.length;
		const cursorReads = report.cursorReads;
		win.hide();
		await delay(200);
		report.lifecycle.push({ event: "after-hide", visible: win.isVisible(), at: Date.now() });
		assert(report.probes.length === probeCount, "Hidden fixture continued probing");
		assert(report.cursorReads === cursorReads, "Hidden fixture continued reading the cursor");
		win.showInactive();
		report.lifecycle.push({
			event: "after-showInactive",
			visible: win.isVisible(),
			at: Date.now(),
		});
		await delay(160);
		assert(report.probes.length > probeCount, "Reshow failed to restart native probes");
		stationary();
		report.passed = true;
	} catch (error) {
		report.passed = false;
		report.error = String(error?.stack ?? error);
	} finally {
		watch?.stop();
		if (win && !win.isDestroyed()) {
			report.finalState = await win.webContents
				.executeJavaScript(`(${readState.toString()})()`)
				.catch(String);
		}
		await fs.writeFile(path.join(config.run, "proof.json"), JSON.stringify(report, null, 2));
		if (win && !win.isDestroyed()) win.destroy();
		app.exit(report.passed ? 0 : 1);
	}
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prepareOnly = process.argv.includes("--prepare-only");
const output = path.resolve(
	process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
		"artifacts/hud-native-pointer/latest",
);
const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
if (process.platform !== "darwin")
	throw Error("This isolated native fixture currently requires macOS");
if (!new URL(base).hostname.match(/^(127\.0\.0\.1|localhost)$/)) {
	throw Error("E2E_BASE_URL must point to the local development server");
}
if (!prepareOnly) {
	const response = await fetch(base);
	if (!response.ok) throw Error(`Development server returned ${response.status}`);
}
await fs.mkdir(output, { recursive: true });
const run = await fs.mkdtemp(path.join(output, "fixture-"));
await fs.writeFile(path.join(run, "preload.cjs"), `(${preloadFixture.toString()})()`);
await build({
	stdin: {
		contents: `import { createHudPointerWatch } from "./electron/hudPointerWatch.ts";\nimport { hudPointerProbe } from "./electron/hudInputPolicy.ts";\nimport { HUD_DOCK_SETTLE_MS } from "./src/components/launch/useHudDockInteraction.ts";\n(${nativeFixture.toString()})(${JSON.stringify({ run, url: `${base}/?windowType=hud-overlay&browser` })}, createHudPointerWatch, hudPointerProbe, HUD_DOCK_SETTLE_MS + 80);`,
		resolveDir: root,
		sourcefile: "hud-native-pointer-fixture.ts",
	},
	outfile: path.join(run, "main.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	external: ["electron"],
});
if (prepareOnly) {
	console.log(`Prepared isolated fixture without launching: ${run}`);
} else {
	const childEnv = { ...process.env };
	delete childEnv.ELECTRON_RUN_AS_NODE;
	const child = spawn(electron, [path.join(run, "main.cjs")], { env: childEnv, stdio: "inherit" });
	const timeout = setTimeout(() => child.kill("SIGTERM"), 45_000);
	const stop = () => child.kill("SIGTERM");
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (exitCode) => resolve(exitCode ?? 1));
	});
	clearTimeout(timeout);
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	console.log(`Native pointer proof: ${path.join(run, "proof.json")}`);
	process.exitCode = code;
}
