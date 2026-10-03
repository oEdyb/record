// Headless CLI mode: boots Electron without HUD/tray/menu, drives a hidden
// renderer window (windowType=cli-export | cli-record) that reuses the app's
// existing export and recording pipelines, and reports progress on stdio.

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	ipcMain as electronIpcMain,
	session,
	systemPreferences,
} from "electron";
import type {
	CliDoneResult,
	CliProgressEvent,
	CliRequest,
	CliSourcesResult,
} from "../../src/lib/cliContracts";
import { formatExportEta } from "../../src/lib/exporter/mp4ExportSettings";
import {
	approveReadableRendererMediaPath,
	consumeCurrentRecordingSession,
	getSelectedDesktopSource,
	registerIpcHandlers,
	resolveApprovedRendererMediaPath,
	resolveApprovedVideoPath,
} from "../ipc/handlers";
import {
	createTrustedRendererIpcMain,
	isTrustedDisplayMediaRequest,
	isTrustedPermissionCheck,
	isTrustedPermissionRequest,
} from "../ipc/trustedRendererIpc";
import { installKlipptProtocol } from "../localMediaProtocol";
import { getSttManager, registerSttIpc } from "../stt";
import { ASSET_BASE_DIR, ASSET_BASE_URL_ARG } from "../windows";
import { CLI_USAGE, type CliCommand } from "./args";
import { finalizeCliResult } from "./cliCompletion";
import { flushCliOutput } from "./cliOutputFlush";
import { runInfoCommand, runPackCommand } from "./projectCommands";
import { createCliSttSourceResolver } from "./sttSourceApproval";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const RENDERER_DIST = path.join(__dirname, "..", "dist");
const TRUSTED_RENDERER_CONFIG = {
	devServerUrl: VITE_DEV_SERVER_URL,
};
const ipcMain = createTrustedRendererIpcMain(electronIpcMain, TRUSTED_RENDERER_CONFIG);

interface CliOutput {
	json: boolean;
	event(event: string, data?: Record<string, unknown>): void;
	info(message: string): void;
	error(message: string): void;
	progress(p: CliProgressEvent): void;
}

// stdout/stderr may be a closed pipe (`openscreen export | head`); writes must
// never take the process down — Electron would show a GUI error dialog.
function safeWrite(stream: NodeJS.WriteStream, text: string): void {
	try {
		stream.write(text);
	} catch {
		// EPIPE or closed stream; drop the output.
	}
}

function createOutput(json: boolean): CliOutput {
	const isTty = process.stdout.isTTY === true;
	let progressLineActive = false;
	let lastProgressText = "";
	const clearProgressLine = () => {
		if (progressLineActive) {
			safeWrite(process.stdout, "\n");
			progressLineActive = false;
		}
	};
	return {
		json,
		event(event, data = {}) {
			if (json) {
				safeWrite(process.stdout, `${JSON.stringify({ event, ...data })}\n`);
			}
		},
		info(message) {
			if (json) return;
			clearProgressLine();
			safeWrite(process.stdout, `${message}\n`);
		},
		error(message) {
			clearProgressLine();
			if (json) {
				safeWrite(process.stdout, `${JSON.stringify({ event: "error", message })}\n`);
			} else {
				safeWrite(process.stderr, `Error: ${message}\n`);
			}
		},
		progress(p) {
			if (json) {
				safeWrite(process.stdout, `${JSON.stringify({ event: "progress", ...p })}\n`);
				return;
			}
			const frames =
				p.currentFrame !== undefined && p.totalFrames
					? ` frame ${p.currentFrame}/${p.totalFrames}`
					: "";
			const eta =
				p.estimatedTimeRemaining !== undefined && Number.isFinite(p.estimatedTimeRemaining)
					? ` ETA ${formatExportEta(p.estimatedTimeRemaining)}`
					: "";
			const phase = p.phase ? ` [${p.phase}]` : "";
			const text = `Exporting ${Math.round(p.percentage)}%${frames}${eta}${phase}`;
			if (isTty) {
				if (text === lastProgressText) return;
				lastProgressText = text;
				safeWrite(process.stdout, `\r\x1b[2K${text}`);
				progressLineActive = true;
			} else {
				// Piped/non-TTY consumers get one line per whole-percent (or phase) change.
				const coarse = `${Math.round(p.percentage)}%${phase}`;
				if (coarse === lastProgressText) return;
				lastProgressText = coarse;
				safeWrite(process.stdout, `${text}\n`);
			}
		},
	};
}

function loadRunnerWindow(windowType: string): BrowserWindow {
	const win = new BrowserWindow({
		width: 1280,
		height: 720,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(`${VITE_DEV_SERVER_URL}?windowType=${windowType}`);
	} else {
		win.loadURL(`klippt://app/index.html?windowType=${encodeURIComponent(windowType)}`);
	}
	return win;
}

async function registerAppHandlersForCli(cliWindowRef: () => BrowserWindow | null): Promise<void> {
	// The recording/export pipelines are driven through the same IPC surface the
	// GUI uses. Window-management callbacks become no-ops; "switch-to-editor"
	// (fired by the recorder hook after it stores a finished session) is handled
	// by the runner itself, so an inert factory is enough.
	const noop = () => {
		// Intentionally empty: CLI mode has no HUD/tray/editor windows to manage.
	};
	const notAvailable = () => {
		throw new Error("Window not available in CLI mode");
	};
	await registerIpcHandlers(
		noop, // createEditorWindow: recording finished; runner drives completion
		notAvailable, // createSourceSelectorWindow
		notAvailable, // createCountdownOverlayWindow
		notAvailable, // createNotesWindow
		cliWindowRef,
		() => null,
		() => null,
		() => null,
		noop, // onRecordingStateChange: no tray to update
		noop, // switchToHud
		undefined,
		// A CLI invocation must not claim or replace an interrupted GUI session.
		// The GUI will restore that journal on its next normal launch.
		{
			restoreInterruptedRecording: false,
			enableCleanVoiceJobs: false,
			ipcMain,
		},
	);
}

function printSources(output: CliOutput, sources: CliSourcesResult): void {
	if (output.json) {
		// The "done" event already carries the payload; nothing extra to print.
		return;
	}
	const lines: string[] = [];
	lines.push("Displays:");
	for (const display of sources.displays) {
		lines.push(`  ${display.index}  ${display.name} (${display.id})`);
	}
	lines.push("Windows:");
	if (sources.windows.length === 0) {
		lines.push("  (none)");
	}
	for (const win of sources.windows) {
		lines.push(`  - ${win.name}`);
	}
	lines.push("Microphones:");
	if (sources.microphoneLabelsUnavailable) {
		lines.push("  (labels unavailable — grant microphone permission to see device names)");
	} else if (sources.microphones.length === 0) {
		lines.push("  (none)");
	}
	for (const mic of sources.microphones) {
		lines.push(`  - ${mic.label}`);
	}
	output.info(lines.join("\n"));
}

function setupRecordStopSignals(stop: (reason: string) => void): void {
	// SIGINT covers Ctrl+C everywhere; SIGTERM never fires on Windows, where
	// stdin "stop" or --duration are the graceful alternatives (see docs/cli.md).
	process.on("SIGINT", () => stop("SIGINT"));
	process.on("SIGTERM", () => stop("SIGTERM"));
	try {
		// Touching process.stdin can throw on Windows GUI-subsystem builds when
		// spawned with stdio "ignore"; signals and --duration still work then.
		const rl = readline.createInterface({ input: process.stdin });
		rl.on("line", (line) => {
			const trimmed = line.trim().toLowerCase();
			if (trimmed === "stop" || trimmed === "q" || trimmed === "quit") {
				stop("stdin");
			}
		});
		rl.on("close", () => {
			// stdin EOF is not a stop signal: agents may spawn the CLI with
			// stdin closed and stop it via SIGINT/--duration instead.
		});
	} catch {
		// stdin unavailable; signals and --duration still work.
	}
}

function setupExportCancelSignals(cancel: (reason: string) => void): void {
	process.on("SIGINT", () => cancel("SIGINT"));
	process.on("SIGTERM", () => cancel("SIGTERM"));
}

/** Both file-only commands write through the same EPIPE-safe stdout writer. */
const writeStdout = (text: string) => safeWrite(process.stdout, text);
/** Agent progress/planned envelopes and diagnostics; never mixed into stdout. */
const writeStderr = (text: string) => safeWrite(process.stderr, text);

export function runCli(command: CliCommand): void {
	if (command.kind === "help") {
		safeWrite(process.stdout, CLI_USAGE);
		app.exit(0);
		return;
	}
	if (command.kind === "error") {
		safeWrite(process.stderr, `Error: ${command.message}\n\n${CLI_USAGE}`);
		app.exit(2);
		return;
	}
	if (command.kind === "agent") {
		for (const level of ["log", "info", "debug"] as const) {
			console[level] = console.error.bind(console);
		}
		process.stdout.on("error", () => {
			// A closed consumer pipe must not open Electron's crash dialog.
		});
		process.stderr.on("error", () => {
			// Diagnostics may also be connected to a closed pipe.
		});
		void import("./agentMain")
			.then(({ runAgentCommand }) =>
				runAgentCommand(command, writeStdout, {
					err: writeStderr,
					brokerSocketPath: path.join(app.getPath("userData"), "agent-cli", "agent.sock"),
					projectsDirectory: path.join(app.getPath("userData"), "projects"),
					previewLaunch: {
						executable: process.execPath,
						args: app.isPackaged ? [] : [app.getAppPath()],
					},
				}),
			)
			.then(async (code) => {
				await flushCliOutput(process.stdout, process.stderr);
				app.exit(code);
			})
			.catch(async (error: unknown) => {
				safeWrite(process.stderr, `${String(error)}\n`);
				await flushCliOutput(process.stdout, process.stderr);
				app.exit(7);
			});
		return;
	}

	const output = createOutput(command.json === true);
	const exitAfterSpeechShutdown = (code: number) => {
		if (command.kind !== "captions") {
			app.exit(code);
			return;
		}
		void getSttManager()
			.shutdown()
			.catch((error) => output.error(`Could not release speech model: ${String(error)}`))
			.finally(() => app.exit(code));
	};

	// stdout belongs to the CLI protocol (NDJSON / progress); reroute the app's
	// own console chatter (e.g. "[native-sck] starting…") to stderr.
	const stringifyArg = (value: unknown): string => {
		if (typeof value === "string") return value;
		if (value instanceof Error) return value.stack ?? value.message;
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return String(value);
		}
	};
	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		console[level] = (...args: unknown[]) => {
			safeWrite(process.stderr, `${args.map(stringifyArg).join(" ")}\n`);
		};
	}

	// A consumer closing the pipe (`openscreen export | head`) must not crash the
	// process, and main-process exceptions must never surface as Electron's GUI
	// error dialog — report on stderr and exit non-zero instead.
	const ignoreStreamError = () => {
		// Intentionally empty: EPIPE from a closed consumer is not an error here.
	};
	process.stdout.on("error", ignoreStreamError);
	process.stderr.on("error", ignoreStreamError);
	process.on("uncaughtException", (error) => {
		safeWrite(process.stderr, `Fatal: ${error?.stack ?? String(error)}\n`);
		exitAfterSpeechShutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		safeWrite(
			process.stderr,
			`Fatal (unhandled rejection): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
		);
		exitAfterSpeechShutdown(1);
	});

	// Set once cli-done has been received; suppresses the window-all-closed
	// failure path during the normal teardown race after a successful run.
	let finished = false;

	// GPU may be unavailable in CI/servers; let Chromium fall back to SwiftShader
	// so the WebGL-based export renderer still works.
	app.commandLine.appendSwitch("enable-unsafe-swiftshader");

	// Never show the dock icon for CLI runs.
	if (process.platform === "darwin") {
		app.dock?.hide();
	}

	app.on("window-all-closed", () => {
		// Completion is signalled via cli-done; a vanished window is a failure
		// only while the run is still in flight.
		if (finished) return;
		output.error("Renderer window closed unexpectedly");
		exitAfterSpeechShutdown(1);
	});

	void app
		.whenReady()
		.then(async () => {
			installKlipptProtocol({
				rendererDist: RENDERER_DIST,
				resourceRoot: ASSET_BASE_DIR,
				resolveMediaPath: resolveApprovedRendererMediaPath,
				allowedCorsOrigins: VITE_DEV_SERVER_URL ? [new URL(VITE_DEV_SERVER_URL).origin] : [],
			});
			if (command.kind === "info") {
				const code = await runInfoCommand(command.projectPath, command.json === true, writeStdout);
				app.exit(code);
				return;
			}

			if (command.kind === "pack") {
				const code = await runPackCommand(
					command.projectPath,
					command.outDir,
					command.json === true,
					writeStdout,
				);
				app.exit(code);
				return;
			}

			await fs.mkdir(path.join(app.getPath("userData"), "recordings"), {
				recursive: true,
			});

			// Media/screen permissions for the renderer (mic metering, future browser
			// capture paths). Mirrors the GUI allowlist.
			const allowed = [
				"media",
				"audioCapture",
				"microphone",
				"videoCapture",
				"camera",
				"screen",
				"display-capture",
			];
			session.defaultSession.setPermissionCheckHandler(
				(webContents, permission, requestingOrigin, details) =>
					allowed.includes(permission) &&
					isTrustedPermissionCheck(webContents, requestingOrigin, details, TRUSTED_RENDERER_CONFIG),
			);
			session.defaultSession.setPermissionRequestHandler(
				(webContents, permission, callback, details) =>
					callback(
						allowed.includes(permission) &&
							isTrustedPermissionRequest(webContents, details, TRUSTED_RENDERER_CONFIG),
					),
			);

			// Browser-pipeline recording fallback (e.g. Linux, missing native helper)
			// resolves the pre-selected source exactly like the GUI does.
			session.defaultSession.setDisplayMediaRequestHandler(
				(request, callback) => {
					const source = getSelectedDesktopSource();
					if (
						!isTrustedDisplayMediaRequest(request, TRUSTED_RENDERER_CONFIG) ||
						!request.videoRequested ||
						!source
					) {
						callback({});
						return;
					}
					callback({
						video: source,
						...(request.audioRequested && process.platform === "win32"
							? { audio: "loopback" as const }
							: {}),
					});
				},
				{ useSystemPicker: false },
			);

			if (command.kind === "record" && command.mic && process.platform === "darwin") {
				const micStatus = systemPreferences.getMediaAccessStatus("microphone");
				if (micStatus !== "granted") {
					await systemPreferences.askForMediaAccess("microphone");
				}
			}

			if (command.kind === "export" && command.previewReference) {
				const { verifyAgentPreviewReference } = await import("./agentPreview");
				command.previewReference.verifiedDocumentHash = await verifyAgentPreviewReference(
					command.projectPath,
					command.previewReference,
				);
			}

			let cliWindow: BrowserWindow | null = null;
			let exportCancellationPending = false;
			await registerAppHandlersForCli(() => cliWindow);
			if (
				command.kind === "export" &&
				command.audioPath &&
				!(await approveReadableRendererMediaPath(command.audioPath))
			) {
				throw new Error(`Voiceover file is missing or unsupported: ${command.audioPath}`);
			}

			// Speech-to-text backs the captions command; registered by the GUI boot
			// path (main.ts) rather than registerIpcHandlers.
			registerSttIpc(
				ipcMain,
				createCliSttSourceResolver(
					path.join(app.getPath("userData"), "recordings"),
					resolveApprovedVideoPath,
				),
			);

			// Registered by the GUI boot path (main.ts) rather than registerIpcHandlers;
			// the renderer's i18n init invokes it unconditionally.
			ipcMain.handle("set-locale", () => {
				// Locale only affects GUI menus/tray, which do not exist in CLI mode.
			});
			ipcMain.handle("update-global-shortcuts", () => ({ success: false }));

			const request: CliRequest = command;
			ipcMain.handle("cli-get-request", (event) => {
				// The renderer subscribes before it asks for the request. Re-send a
				// startup cancellation here because did-finish-load can occur before
				// React mounts the runner and attaches its listener.
				if (command.kind === "export" && exportCancellationPending) {
					event.sender.send("cli-cancel-export");
				}
				return request;
			});
			ipcMain.on("cli-log", (_event, level: string, message: string) => {
				if (level === "error") {
					output.error(message);
				} else {
					output.info(message);
					output.event("log", { message });
				}
			});
			ipcMain.on("cli-progress", (_event, progress: CliProgressEvent) => {
				output.progress(progress);
			});

			ipcMain.handle("cli-done", async (_event, incomingResult: CliDoneResult) => {
				if (finished) return;
				finished = true;
				const result = await finalizeCliResult(command, incomingResult, {
					consumeRecordingSession: consumeCurrentRecordingSession,
				});

				if (result.success) {
					for (const warning of result.warnings ?? []) {
						output.info(`Warning: ${warning}`);
						output.event("warning", { message: warning });
					}
					if (command.kind === "sources" && result.sources) {
						printSources(output, result.sources);
					} else if (command.kind === "captions") {
						output.info(
							`Added ${result.captionCount ?? 0} caption annotation(s) → ${result.projectPath}`,
						);
					} else if (command.kind === "export") {
						output.info(`Exported ${result.format ?? ""} → ${result.outputPath}`);
					} else {
						output.info(`Recording saved → ${result.screenVideoPath}`);
						if (result.cursorDataPath) output.info(`Cursor data → ${result.cursorDataPath}`);
						if (result.projectPath) output.info(`Project → ${result.projectPath}`);
					}
					output.event("done", { ...result });
				} else {
					output.error(result.error ?? "Unknown failure");
					output.event("done", { ...result });
				}
				if (command.kind === "captions") {
					await getSttManager()
						.shutdown()
						.catch((error) => output.error(`Could not release speech model: ${String(error)}`));
				}

				// Give the renderer a beat to resolve the invoke before exiting.
				setTimeout(() => app.exit(result.success ? 0 : 1), 50);
			});

			if (command.kind === "record") {
				const stop = (reason: string) => {
					output.info(`Stopping recording (${reason})…`);
					output.event("stopping", { reason });
					cliWindow?.webContents.send("cli-stop-recording");
				};
				setupRecordStopSignals(stop);
			} else if (command.kind === "export") {
				setupExportCancelSignals((reason) => {
					output.info(`Cancelling export (${reason})…`);
					output.event("cancelling", { reason });
					exportCancellationPending = true;
					if (cliWindow && !cliWindow.isDestroyed()) {
						cliWindow.webContents.send("cli-cancel-export");
					}
				});
			} else if (command.kind === "captions") {
				let stopping = false;
				const stopCaptions = (signal: "SIGINT" | "SIGTERM", exitCode: number) => {
					if (stopping) return;
					stopping = true;
					output.info(`Cancelling captions (${signal})…`);
					output.event("cancelling", { reason: signal });
					const manager = getSttManager();
					manager.cancel();
					void manager
						.shutdown()
						.catch((error) => output.error(`Could not release speech model: ${String(error)}`))
						.finally(() => app.exit(exitCode));
				};
				process.on("SIGINT", () => stopCaptions("SIGINT", 130));
				process.on("SIGTERM", () => stopCaptions("SIGTERM", 143));
			}

			const windowType = {
				export: "cli-export",
				record: "cli-record",
				sources: "cli-sources",
				captions: "cli-captions",
			}[command.kind];
			cliWindow = loadRunnerWindow(windowType);
			if (command.kind === "export") {
				cliWindow.webContents.once("did-finish-load", () => {
					if (exportCancellationPending && cliWindow && !cliWindow.isDestroyed()) {
						cliWindow.webContents.send("cli-cancel-export");
					}
				});
			}

			// Surface renderer console errors/warnings on stderr — the hidden window
			// has no other way to show what went wrong (toasts are invisible).
			cliWindow.webContents.on("console-message", (details) => {
				if (details.level === "error" || details.level === "warning") {
					safeWrite(process.stderr, `[renderer] ${details.message}\n`);
				}
			});

			cliWindow.webContents.on("did-fail-load", (_e, code, description) => {
				output.error(`Failed to load runner window: ${description} (${code})`);
				app.exit(1);
			});
			cliWindow.webContents.on("render-process-gone", (_e, details) => {
				output.error(`Renderer crashed: ${details.reason}`);
				app.exit(1);
			});

			output.event("started", { command: command.kind });
		})
		.catch((error) => {
			output.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
			exitAfterSpeechShutdown(1);
		});
}
