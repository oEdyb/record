import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { _electron, chromium } from "@playwright/test";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitForFreshDevToolsPort(file, previous, child) {
	for (let i = 0; i < 200; i++) {
		if (child.exitCode !== null || child.signalCode !== null)
			throw new Error(`Packaged app exited ${child.exitCode ?? child.signalCode}`);
		const current = await readFile(file, "utf8").catch(() => null);
		if (current && current !== previous) {
			const [port, browser] = current.split("\n");
			if (
				/^\d+$/.test(port) &&
				Number(port) > 0 &&
				Number(port) <= 65535 &&
				browser?.startsWith("/devtools/browser/")
			)
				return port;
		}
		await delay(100);
	}
	throw new Error("Packaged renderer debugger did not start; fuses remain unchanged");
}

export function recordingTestTarget(root, env = process.env) {
	const executablePath = env.KLIPPT_TEST_EXECUTABLE;
	return executablePath
		? { executablePath: path.resolve(executablePath), args: [] }
		: { executablePath: path.join(root, "node_modules/electron/dist/electron"), args: [root] };
}

async function kwinWindow(title, action, pid, directory, attempt = 0) {
	assert(process.env.AGENT_LAB_RUNTIME, "Compositor operations require a private desktop");
	const tag = `klippt-test-${randomUUID()}`;
	const source = path.join(directory, `${tag}.js`);
	await writeFile(
		source,
		`const w=workspace.stackingOrder.find(w=>w.caption===${JSON.stringify(title)} && w.pid===${pid});
 if(w){ ${action === "maximize" ? "w.setMaximize(true,true);" : action === "unmaximize" ? "w.setMaximize(false,false);" : ""}
 console.log(${JSON.stringify(tag + " ")}+JSON.stringify({bounds:{x:w.frameGeometry.x,y:w.frameGeometry.y,width:w.frameGeometry.width,height:w.frameGeometry.height},visible:!w.minimized && !w.hidden,maximized:w.maximizeMode===3}));
 }else console.log(${JSON.stringify(tag + " null")});`,
	);
	const dbus = (args) =>
		execFileSync("qdbus6", ["org.kde.KWin", ...args], { encoding: "utf8" }).trim();
	const id = dbus(["/Scripting", "loadScript", source, tag]);
	try {
		try {
			dbus([`/Scripting/Script${id}`, "org.kde.kwin.Script.run"]);
		} catch (error) {
			if (attempt >= 4 || !String(error.stdout ?? error.message).includes("UnknownObject"))
				throw error;
			await delay(100);
			return await kwinWindow(title, action, pid, directory, attempt + 1);
		}
		for (let i = 0; i < 40; i++) {
			const journal = spawnSync(
				"journalctl",
				[
					"--user",
					"-u",
					`agent-lab-${path.basename(process.env.AGENT_LAB_RUNTIME)}.service`,
					"-n",
					"100",
					"--grep",
					`^${tag} `,
					"--no-pager",
					"-o",
					"json",
				],
				{ encoding: "utf8" },
			);
			if (journal.error) throw journal.error;
			// journalctl returns 1 when the requested tag has not arrived yet.
			if (journal.status !== 0 && !(journal.status === 1 && !journal.stdout && !journal.stderr))
				throw new Error(`Private KWin journal failed: ${journal.stderr}`);
			const message = journal.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line).MESSAGE)
				.find((m) => typeof m === "string" && m.startsWith(tag + " "));
			if (message) {
				const result = JSON.parse(message.slice(tag.length + 1));
				if (action === "isVisible") return !!result?.visible;
				assert(result, `Missing private native window ${title}`);
				return action === "getBounds" ? result.bounds : result.maximized;
			}
			await delay(50);
		}
		if (attempt < 4) {
			console.warn(`Private KWin reply missing; retrying ${title} ${action} (${attempt + 1}/4)`);
			return await kwinWindow(title, action, pid, directory, attempt + 1);
		}
		throw new Error("Private compositor did not report window state after five requests");
	} finally {
		dbus(["/Scripting", "unloadScript", tag]);
	}
}

export async function launchRecordingTestApp(root, args, env) {
	const target = recordingTestTarget(root, env);
	if (!env.KLIPPT_TEST_EXECUTABLE) {
		const app = await _electron.launch({ ...target, args: [...target.args, ...args], env });
		const log = createWriteStream(path.join(env.KLIPPT_WINDOW_TEST_DIR, "main-process.log"), {
			flags: "a",
		});
		app.process().stdout?.pipe(log, { end: false });
		app.process().stderr?.pipe(log, { end: false });
		app.process().once("exit", () => log.end());
		app.nativeWindow = (title, action) =>
			app.evaluate(
				({ BrowserWindow }, { title, action }) => {
					const kind = title === "Klippt Camera" ? "camera-preview" : "hud-overlay";
					const w = BrowserWindow.getAllWindows().find((w) =>
						w.webContents.getURL().includes(`windowType=${kind}`),
					);
					if (!w) throw new Error(`Missing recording window ${kind}`);
					return w[action]();
				},
				{ title, action },
			);
		app.abort = () =>
			app
				.evaluate(({ app }) => app.exit(0))
				.catch((error) => console.log("Private app closed:", error.message));
		return app;
	}
	assert(env.AGENT_LAB_RUNTIME, "Packaged tests require a private desktop");
	assert(
		env.ELECTRON_USER_DATA_DIR.startsWith(env.KLIPPT_WINDOW_TEST_DIR + path.sep),
		"Private profile required",
	);
	const clean = { ...env };
	for (const key of [
		"OPENSCREEN_FFMPEG_PATH",
		"OPENSCREEN_COMPOSITOR_VIEW_NODE",
		"OPENSCREEN_LINUX_CURSOR_HELPER_EXE",
		"ELECTRON_RUN_AS_NODE",
		"NODE_OPTIONS",
	])
		delete clean[key];
	await realpath(target.executablePath);
	const debuggerFile = path.join(env.ELECTRON_USER_DATA_DIR, "DevToolsActivePort");
	const previousDebugger = await readFile(debuggerFile, "utf8").catch(() => null);
	const child = spawn(
		target.executablePath,
		[...args, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
		{ env: clean, stdio: ["ignore", "pipe", "pipe"] },
	);
	const log = createWriteStream(path.join(env.KLIPPT_WINDOW_TEST_DIR, `packaged-${child.pid}.log`));
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	const exited = new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	let browser;
	let aborted = false;
	try {
		const port = await waitForFreshDevToolsPort(debuggerFile, previousDebugger, child);
		assert.equal(await realpath(`/proc/${child.pid}/exe`), await realpath(target.executablePath));
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		console.log("Testing installed executable", target.executablePath, "PID", child.pid);
		return {
			windows: () => browser.contexts().flatMap((context) => context.pages()),
			process: () => child,
			nativeWindow: (title, action) =>
				kwinWindow(title, action, child.pid, env.KLIPPT_WINDOW_TEST_DIR),
			abort: async () => {
				aborted = true;
				child.kill("SIGTERM");
				await exited;
			},
			close: async () => {
				if (child.exitCode === null && child.signalCode === null) {
					const page = browser.contexts().flatMap((c) => c.pages())[0];
					await page
						.evaluate(() => window.electronAPI.quitApp())
						.catch((error) => console.log("Private app closed:", error.message));
					const result = await Promise.race([exited, delay(15000).then(() => null)]);
					if (!result) {
						child.kill("SIGTERM");
						await exited;
						throw new Error("Installed app did not quit cleanly");
					}
					assert.equal(result.code, 0, "Installed app quit failed");
				}
				if (!aborted) assert.equal(child.exitCode, 0, "Installed app exited unexpectedly");
				await browser.close();
				log.end();
			},
		};
	} catch (error) {
		child.kill("SIGTERM");
		await exited;
		log.end();
		throw error;
	}
}
