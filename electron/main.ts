import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain as electronIpcMain,
	Menu,
	nativeImage,
	net,
	powerMonitor,
	screen,
	session,
	shell,
	systemPreferences,
	Tray,
} from "electron";
import { APP_DISPLAY_NAME } from "../src/lib/brand";
import { PRODUCT_SURFACE } from "../src/lib/productSurface";
import type { ShortcutsConfig } from "../src/lib/shortcuts";
import { AgentServer } from "./agent/agentServer";
import {
	blockedFromInstalling,
	checkForSelfUpdate,
	downloadSelfUpdate,
	installSelfUpdate,
} from "./auto-updater";
import { ensureAlignerModel } from "./cleanCut/alignerModel";
import { claudeCliModel, findClaudeCli } from "./cleanCut/claudeCliModel";
import { registerCleanCutIpc } from "./cleanCut/ipc";
import { CleanCutService } from "./cleanCut/service";
import { parseCliArgs } from "./cli/args";
import { runCli } from "./cli/cliMain";
import { COMPACT_REVIEW_MIN_SIZE, fitCompactReviewBounds } from "./compactReviewGeometry";
import { isDiagnosticModeEnabled, mainLogBuffer } from "./diagnostics/main-log-buffer";
import {
	loadAndRegisterGlobalShortcuts,
	registerGlobalShortcuts,
	unregisterAllGlobalShortcuts,
} from "./globalShortcut";
import { mainT, setMainLocale } from "./i18n";
import {
	classifyInstall,
	type InstallChannel,
	platformOwnsUpdates,
	probeInstall,
} from "./install-channel";
import {
	getSelectedDesktopSource,
	getSelectedSourceAspectRatio,
	isNativeMacCaptureRunning,
	listTranscriptClips,
	registerIpcHandlers,
	requestLinuxRecordingControls,
	resolveApprovedRendererMediaPath,
	stopNativeMacCaptureForQuit,
	stopTakeWithoutPill,
	studioSetup,
	studioTake,
} from "./ipc/handlers";
import {
	createTrustedRendererIpcMain,
	isTrustedDisplayMediaRequest,
	isTrustedPermissionCheck,
	isTrustedPermissionRequest,
} from "./ipc/trustedRendererIpc";
import { installKlipptProtocol } from "./localMediaProtocol";
import { installMainProcessErrorGuards } from "./main-process-errors";
import { resolveFfmpeg } from "./media/audioPeaks";
import { NiriCaptureWindowGuard } from "./niriCaptureWindowGuard";
import { activateNiriHud } from "./niriHudFocus";
import { createQuitCaptureGuard } from "./recording/quitCaptureGuard";
import {
	canDispatchRecordingReviewMenu,
	recordingReviewFileMenu,
} from "./recording/recordingReviewFileMenu";
import { appendRecordStartTiming, RecordStartTimeline } from "./recording/recordStartTimeline";
import { recordingsDirectory } from "./recordingPaths";
import { installWebContentsSecurityGuards, type TrustedRendererConfig } from "./security";
import { ensureModels, isModelOnDisk, modelPaths } from "./stt/modelManager";
import { parseStudioCommand, registerStudioIpc } from "./studio/ipc";
import { moveStudioOffCapture, returnStudioTo } from "./studio/niriStudioPlacement";
import { StudioController } from "./studio/studioController";
import { registerTranscriptIpc, sendTranscriptSnapshot } from "./transcript/ipc";
import { LiveTranscriptService } from "./transcript/liveTranscript";
import {
	ParakeetProcess,
	parakeetModelId,
	resolveParakeetBinaryPath,
} from "./transcript/parakeetProcess";
import { checkLatestRelease } from "./update-checker";
import {
	ASSET_BASE_DIR,
	closeWithoutAnimation,
	createCameraPreviewWindow,
	createCountdownOverlayWindow,
	createEditorWindow,
	createHudOverlayWindow,
	createNotesWindow,
	createSourceSelectorWindow,
	createStudioWindow,
	createTranscriptWindow,
	isPointOverPrivateRecordingUi,
	setCameraPreviewCaptureHidden,
} from "./windows";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CLI mode: `openscreen export|record|info|help ...` runs headless without
// HUD/tray/menu. Parsed before any GUI side effects; see electron/cli/.
const cliCommand = parseCliArgs(process.argv, app.isPackaged ? 1 : 2);

// Use Screen & System Audio Recording permissions instead of the CoreAudio Tap API on macOS.
// Tap needs NSAudioCaptureUsageDescription in the parent app's Info.plist, which breaks when
// running from a terminal/IDE during dev.
if (process.platform === "darwin") {
	app.commandLine.appendSwitch("disable-features", "MacCatapLoopbackAudioForScreenShare");
	// The webcam MediaRecorder is the only Chromium-side video encoder on macOS; the screen
	// is captured and encoded natively through VideoToolbox by the ScreenCaptureKit helper.
	// With hardware encoding enabled, Chromium's VEA H.264 path shares that VideoToolbox
	// engine and, once the screen encoder is busy, drops webcam frames ("Too many frames are
	// queued up" in video_track_recorder.cc): a 4K/30 camera delivered 44-59 of 180 frames
	// beside a live screen recording. Software H.264 kept 179-180 at about two cores.
	// See technical-documentation/engineering/webcam-encoder-contention.md.
	app.commandLine.appendSwitch("disable-accelerated-video-encode");
}

// Wayland support for screen capture and window management on Wayland compositors.
if (process.platform === "linux") {
	const isWayland =
		process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY !== undefined;
	if (isWayland) {
		app.commandLine.appendSwitch("ozone-platform", "wayland");
		// Enable WebRTCPipeWireCapturer for screen capture on Wayland
		app.commandLine.appendSwitch("enable-features", "WaylandWindowDrag,WebRTCPipeWireCapturer");
		// Chromium's Wayland Ozone backend can't use Vulkan. When it tries, the WebRTC
		// PipeWire capturer fails to import DMA-BUF frames into EGL (EGL_BAD_MATCH), the
		// stream renegotiates, and screen recording yields no usable frames. Force the
		// GL/EGL path so DMA-BUF import works. (Chromium itself logs this suggestion:
		// "'--ozone-platform=wayland' is not compatible with Vulkan ... disabling Vulkan".)
		app.commandLine.appendSwitch("disable-features", "Vulkan");
	}
}

installMainProcessErrorGuards();

export const RECORDINGS_DIR = recordingsDirectory(app.getPath("userData"));

async function ensureRecordingsDir() {
	try {
		await fs.mkdir(RECORDINGS_DIR, { recursive: true });
		console.log("RECORDINGS_DIR:", RECORDINGS_DIR);
		console.log("User Data Path:", app.getPath("userData"));
	} catch (error) {
		console.error("Failed to create recordings directory:", error);
	}
}

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── bootstrap.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..");

// Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

const trustedRendererConfig: TrustedRendererConfig = {
	devServerUrl: VITE_DEV_SERVER_URL,
};
const ipcMain = createTrustedRendererIpcMain(electronIpcMain, trustedRendererConfig);
app.enableSandbox();
installWebContentsSecurityGuards(app, trustedRendererConfig);

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
	? path.join(process.env.APP_ROOT, "public")
	: RENDERER_DIST;

// Window references
let mainWindow: BrowserWindow | null = null;
const readyEditorWindows = new WeakSet<BrowserWindow>();
let sourceSelectorWindow: BrowserWindow | null = null;
let countdownOverlayWindow: BrowserWindow | null = null;
let notesWindow: BrowserWindow | null = null;
let transcriptWindow: BrowserWindow | null = null;
let studio: StudioController | null = null;
let quittingForStudio = false;
let liveTranscript: LiveTranscriptService | null = null;
let tray: Tray | null = null;
let selectedSourceName = "";
const isMac = process.platform === "darwin";
const trayIconSize = isMac ? 16 : 24;

// Tray Icons
const defaultTrayIcon = isMac
	? nativeImage.createFromPath(
			path.join(process.env.VITE_PUBLIC || RENDERER_DIST, "klippt-trayTemplate.png"),
		)
	: getTrayIcon("klippt-tray.png", trayIconSize);
if (isMac) defaultTrayIcon.setTemplateImage(true);
const recordingTrayIcon = getTrayIcon("rec-button.png", trayIconSize);

function createWindow() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		return;
	}

	mainWindow = createHudOverlayWindow();
	quitCaptureGuard.protectWindow(mainWindow);
	if (isMac || process.platform === "linux") createCameraPreviewWindow();
}

function showMainWindow() {
	if (requestLinuxRecordingControls()) return;
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
		if (mainWindow.webContents.getURL().includes("windowType=hud-overlay"))
			void activateNiriHud(process.pid).catch((error: unknown) =>
				console.warn("[hud] activation failed:", error),
			);
		return;
	}

	createWindow();
}

// CLI runs skip the single-instance lock so `openscreen export/record` works
// while the GUI app is open (they share nothing but the recordings directory).
const hasSingleInstanceLock = cliCommand ? false : app.requestSingleInstanceLock();

if (cliCommand) {
	runCli(cliCommand);
} else if (hasSingleInstanceLock) {
	app.on("second-instance", (_event, argv) => {
		if (argv.includes("--recorder-pause-continue")) {
			toggleRecordingPauseFromShortcut();
			return;
		}
		if (argv.includes("--recorder-stop")) {
			mainWindow?.webContents.send("stop-recording-from-tray");
			return;
		}
		showMainWindow();
	});
} else {
	app.quit();
}

function isEditorWindow(window: BrowserWindow) {
	return window.webContents.getURL().includes("windowType=editor");
}

function sendEditorMenuAction(
	channel: "menu-load-project" | "menu-save-project" | "menu-save-project-as" | "menu-new-project",
) {
	let targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;
	if (
		!canDispatchRecordingReviewMenu(channel, {
			recordingOnly: PRODUCT_SURFACE.recordingOnly,
			isRecording,
			targetIsReview: Boolean(
				targetWindow && !targetWindow.isDestroyed() && isEditorWindow(targetWindow),
			),
		})
	)
		return;

	if (!targetWindow || targetWindow.isDestroyed() || !isEditorWindow(targetWindow)) {
		createEditorWindowWrapper();
		targetWindow = mainWindow;
		if (!targetWindow || targetWindow.isDestroyed()) return;

		if (!readyEditorWindows.has(targetWindow)) {
			targetWindow.webContents.once("did-finish-load", () => {
				if (!targetWindow || targetWindow.isDestroyed()) return;
				targetWindow.webContents.send(channel);
			});
		} else {
			targetWindow.webContents.send(channel);
		}
		return;
	}

	targetWindow.webContents.send(channel);
}

function setupApplicationMenu() {
	const isMac = process.platform === "darwin";
	const template: Electron.MenuItemConstructorOptions[] = [];

	if (isMac) {
		template.push({
			label: app.name,
			submenu: [
				{
					role: "about",
					label: mainT("common", "actions.about") || `About ${APP_DISPLAY_NAME}`,
				},
				{ type: "separator" },
				{
					role: "services",
					label: mainT("common", "actions.services") || "Services",
				},
				{ type: "separator" },
				{
					role: "hide",
					label: mainT("common", "actions.hide") || `Hide ${APP_DISPLAY_NAME}`,
				},
				{
					role: "hideOthers",
					label: mainT("common", "actions.hideOthers") || "Hide Others",
				},
				{
					role: "unhide",
					label: mainT("common", "actions.unhide") || "Show All",
				},
				{ type: "separator" },
				{ role: "quit", label: mainT("common", "actions.quit") || "Quit" },
			],
		});
	}

	template.push(
		{
			label: mainT("common", "actions.file") || "File",
			submenu: [
				...(PRODUCT_SURFACE.recordingOnly
					? recordingReviewFileMenu(sendEditorMenuAction)
					: [
							{
								label: mainT("dialogs", "unsavedChanges.newProject") || "New Project",
								accelerator: "CmdOrCtrl+N",
								click: () => sendEditorMenuAction("menu-new-project"),
							},
							{ type: "separator" as const },
							{
								label: mainT("dialogs", "unsavedChanges.loadProject") || "Load Project…",
								accelerator: "CmdOrCtrl+O",
								click: () => sendEditorMenuAction("menu-load-project"),
							},
							{
								label: mainT("dialogs", "unsavedChanges.saveProject") || "Save Project…",
								accelerator: "CmdOrCtrl+S",
								click: () => sendEditorMenuAction("menu-save-project"),
							},
							{
								label: mainT("dialogs", "unsavedChanges.saveProjectAs") || "Save Project As…",
								accelerator: "CmdOrCtrl+Shift+S",
								click: () => sendEditorMenuAction("menu-save-project-as"),
							},
						]),
				...(isMac
					? []
					: [
							{ type: "separator" as const },
							{
								role: "quit" as const,
								label: mainT("common", "actions.quit") || "Quit",
							},
						]),
			],
		},
		{
			label: mainT("common", "actions.edit") || "Edit",
			submenu: [
				{ role: "undo", label: mainT("common", "actions.undo") || "Undo" },
				{ role: "redo", label: mainT("common", "actions.redo") || "Redo" },
				{ type: "separator" },
				{ role: "cut", label: mainT("common", "actions.cut") || "Cut" },
				{ role: "copy", label: mainT("common", "actions.copy") || "Copy" },
				{ role: "paste", label: mainT("common", "actions.paste") || "Paste" },
				{
					role: "selectAll",
					label: mainT("common", "actions.selectAll") || "Select All",
				},
			],
		},
		{
			label: mainT("common", "actions.view") || "View",
			submenu: [
				{
					role: "reload",
					label: mainT("common", "actions.reload") || "Reload",
				},
				{
					role: "forceReload",
					label: mainT("common", "actions.forceReload") || "Force Reload",
				},
				{
					role: "toggleDevTools",
					label: mainT("common", "actions.toggleDevTools") || "Toggle Developer Tools",
				},
				{ type: "separator" },
				{
					role: "resetZoom",
					label: mainT("common", "actions.actualSize") || "Actual Size",
				},
				{
					role: "zoomIn",
					label: mainT("common", "actions.zoomIn") || "Zoom In",
				},
				{
					role: "zoomOut",
					label: mainT("common", "actions.zoomOut") || "Zoom Out",
				},
				{ type: "separator" },
				{
					role: "togglefullscreen",
					label: mainT("common", "actions.toggleFullScreen") || "Toggle Full Screen",
				},
			],
		},
		{
			label: mainT("common", "actions.window") || "Window",
			submenu: isMac
				? [
						{
							role: "minimize",
							label: mainT("common", "actions.minimize") || "Minimize",
						},
						{ role: "zoom" },
						{ type: "separator" },
						{ role: "front" },
					]
				: [
						{
							role: "minimize",
							label: mainT("common", "actions.minimize") || "Minimize",
						},
						{
							role: "close",
							label: mainT("common", "actions.close") || "Close",
						},
					],
		},
	);

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

function createTray() {
	tray = new Tray(defaultTrayIcon);
	tray.on("click", () => {
		showMainWindow();
	});
	tray.on("double-click", () => {
		showMainWindow();
	});
}

function getTrayIcon(filename: string, size: number) {
	return nativeImage
		.createFromPath(path.join(process.env.VITE_PUBLIC || RENDERER_DIST, filename))
		.resize({
			width: size,
			height: size,
			quality: "best",
		});
}

let updateCheckInFlight = false;
let installChannel: InstallChannel | null = null;
/** Aborted on quit so a pending check cannot outlive the app and pop a dialog on the way out —
 *  or reject into `main-process-errors`, which re-throws and would take the process with it. */
let updateCheckAbort: AbortController | null = null;

function getInstallChannel(): InstallChannel {
	if (installChannel === null) installChannel = classifyInstall(probeInstall());
	return installChannel;
}

/** Mirrors the flag that already drives the tray icon. An update must never interrupt a take —
 *  and on Windows it physically cannot, because the capture helpers spawn from inside the
 *  install directory and NSIS cannot overwrite a running .exe. */
let isRecording = false;

function toggleRecordingPauseFromShortcut() {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send("hud-toggle-recording-pause");
}

const globalShortcutHandlers = {
	openApp: showMainWindow,
	toggleRecordingPause: toggleRecordingPauseFromShortcut,
};

async function downloadAndInstall(latestVersion: string) {
	const downloaded = await downloadSelfUpdate();
	if (downloaded.kind === "failed") {
		await dialog.showMessageBox({
			type: "error",
			title: app.name,
			// Not `updates.failed`: the CHECK succeeded — that is how we got here — and telling
			// the user we could not check for updates sends them looking in the wrong place.
			message: mainT("common", "updates.downloadFailed"),
			detail: downloaded.error.message,
		});
		return;
	}

	const blocked = blockedFromInstalling({
		recording: isRecording,
		// macOS-only API; absent elsewhere, and irrelevant there.
		inApplicationsFolder:
			process.platform === "darwin" ? (app.isInApplicationsFolder?.() ?? true) : true,
		platform: process.platform,
	});
	if (blocked) {
		await dialog.showMessageBox({
			type: "info",
			title: app.name,
			message: mainT(
				"common",
				blocked === "recording" ? "updates.blockedRecording" : "updates.blockedLocation",
			),
		});
		return;
	}

	const restart = await dialog.showMessageBox({
		type: "info",
		title: app.name,
		message: mainT("common", "updates.readyToInstall", { latestVersion }),
		buttons: [
			mainT("common", "actions.restartNow") || "Restart Now",
			mainT("common", "actions.cancel") || "Cancel",
		],
		defaultId: 0,
		cancelId: 1,
	});
	if (restart.response === 0) await installSelfUpdate();
}

async function checkForUpdates() {
	if (updateCheckInFlight) return;
	updateCheckInFlight = true;
	updateCheckAbort = new AbortController();
	const signal = AbortSignal.any([updateCheckAbort.signal, AbortSignal.timeout(10_000)]);
	try {
		const result = await checkLatestRelease({
			currentVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			fetchLatest: (url, init) => net.fetch(url, init),
			signal,
		});
		if (result.kind === "current") {
			await dialog.showMessageBox({
				type: "info",
				title: app.name,
				message: mainT("common", "updates.current", {
					currentVersion: result.currentVersion,
				}),
			});
			return;
		}

		// An install we built can replace itself; everything else — dev builds, an unclassified
		// payload, and every macOS install predating Developer ID signing, which Squirrel can
		// never update — can only be pointed at the download page. Ask the updater first so the
		// buttons offered match what this install can actually do.
		const selfUpdate = await checkForSelfUpdate(getInstallChannel());
		const canSelfUpdate = selfUpdate.kind === "downloaded";
		if (selfUpdate.kind === "failed") {
			// A release published before the update feeds existed has no latest*.yml. Not worth a
			// dialog — the download page below still works — but it must not vanish silently.
			console.warn("[updates] self-update unavailable, falling back to the release page", {
				channel: getInstallChannel(),
				error: selfUpdate.error.message,
			});
		}

		const choice = await dialog.showMessageBox({
			type: "info",
			title: app.name,
			message: mainT("common", "updates.available", {
				currentVersion: result.currentVersion,
				latestVersion: result.latestVersion,
			}),
			buttons: [
				canSelfUpdate
					? mainT("common", "actions.downloadUpdate") || "Download Update"
					: mainT("common", "actions.viewRelease") || "View Release",
				mainT("common", "actions.cancel") || "Cancel",
			],
			defaultId: 0,
			cancelId: 1,
		});
		if (choice.response !== 0) return;
		if (!canSelfUpdate) {
			await shell.openExternal(result.releaseUrl);
			return;
		}
		await downloadAndInstall(result.latestVersion);
	} catch (error) {
		// Quitting is not a failure, and the app is already on its way out — there is nothing
		// left to show the dialog on.
		if (signal.aborted && updateCheckAbort?.signal.aborted) return;
		await dialog.showMessageBox({
			type: "error",
			title: app.name,
			message: mainT("common", "updates.failed"),
			detail: error instanceof Error ? error.message : String(error),
		});
	} finally {
		updateCheckInFlight = false;
		updateCheckAbort = null;
	}
}

function updateTrayMenu(recording: boolean = false) {
	if (!tray) return;
	const trayIcon = recording ? recordingTrayIcon : defaultTrayIcon;
	const trayToolTip = recording
		? mainT("common", "actions.recordingStatus", {
				source: selectedSourceName,
			}) || `Recording: ${selectedSourceName}`
		: APP_DISPLAY_NAME;
	const menuTemplate = recording
		? [
				{
					label: mainT("common", "actions.stopRecording") || "Stop Recording",
					click: () => {
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send("stop-recording-from-tray");
						}
					},
				},
			]
		: [
				{
					label: mainT("common", "actions.startRecording"),
					click: () => {
						showMainWindow();
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send("hud-start-recording");
						}
					},
				},
				{
					label: mainT("common", "actions.showRecorder"),
					click: () => {
						showMainWindow();
					},
				},
				{ type: "separator" as const },
				// Omitted entirely where a package manager owns the update (Microsoft Store,
				// Flathub, Snap, Nix): there the app is already kept current, and offering a
				// GitHub download walks the user into a second, parallel installation.
				...(platformOwnsUpdates(getInstallChannel())
					? []
					: [
							{
								label: mainT("common", "actions.checkForUpdates") || "Check for Updates",
								click: () => {
									// Not `void`: an unhandled rejection here is re-thrown by
									// main-process-errors and would kill the main process.
									checkForUpdates().catch((error) => {
										console.error("[updates] check failed", error);
									});
								},
							},
						]),
				{ type: "separator" as const },
				{
					label: mainT("common", "actions.quit") || "Quit",
					click: () => {
						app.quit();
					},
				},
			];
	tray.setImage(trayIcon);
	tray.setToolTip(trayToolTip);
	tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

let editorHasUnsavedChanges = false;
let isForceClosing = false;
let isCloseConfirmInFlight = false;
let workspaceTransition: { target: "editor" | "hud"; window: BrowserWindow } | null = null;
let editorWindow: BrowserWindow | null = null;

ipcMain.on("set-has-unsaved-changes", (_, hasChanges: boolean) => {
	editorHasUnsavedChanges = hasChanges;
});

// Quit requested from the editor's in-app File menu. Mirrors the native
// menu's role:"quit" so the unsaved-changes close flow still runs.
ipcMain.on("app-quit", () => {
	app.quit();
});

function forceCloseEditorWindow(windowToClose: BrowserWindow | null) {
	if (!windowToClose || windowToClose.isDestroyed()) return;

	isForceClosing = true;
	setImmediate(() => {
		try {
			if (!windowToClose.isDestroyed()) {
				windowToClose.close();
			}
		} finally {
			isForceClosing = false;
		}
	});
}

/** Where a finished recording's small review player opens: the recorder's display. */
function compactReviewBoundsNear(window: BrowserWindow | null) {
	const display =
		window && !window.isDestroyed()
			? screen.getDisplayMatching(window.getBounds())
			: screen.getPrimaryDisplay();
	const anchor = window && !window.isDestroyed() ? window.getBounds() : display.workArea;
	return fitCompactReviewBounds(
		display.workArea,
		getSelectedSourceAspectRatio(display),
		undefined,
		anchor.x + anchor.width / 2,
	);
}

const compactReviewWindows = new WeakSet<BrowserWindow>();
/** A review that took the Studio's place keeps the Studio's frame instead of shrinking to fit. */
const reviewsInStudioFrame = new WeakSet<BrowserWindow>();

/** Tells review whether it is the small player, so Expand appears only then. */
function setReviewWindowCompact(window: BrowserWindow, compact: boolean) {
	if (compact) compactReviewWindows.add(window);
	else compactReviewWindows.delete(window);
	if (!window.isDestroyed()) window.webContents.send("review-window-compact-changed", compact);
}

// Once review knows the recording's shape, the small player takes exactly that
// shape plus its bars, so the video fills it with no padding.
ipcMain.handle(
	"fit-review-window",
	(event, request: { aspectRatio?: number; chromeHeight?: number }) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window || window.isDestroyed() || !compactReviewWindows.has(window)) return false;
		if (window.isFullScreen() || window.isMaximized()) return false;
		if (reviewsInStudioFrame.has(window)) return false;
		const current = window.getBounds();
		const display = screen.getDisplayMatching(current);
		// A visible player eases into its new shape instead of jumping.
		window.setBounds(
			fitCompactReviewBounds(
				display.workArea,
				request?.aspectRatio,
				request?.chromeHeight,
				current.x + current.width / 2,
			),
			window.isVisible(),
		);
		return true;
	},
);

ipcMain.handle("is-review-window-compact", (event) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	return Boolean(window && compactReviewWindows.has(window));
});

function createEditorWindowWrapper(
	options: { compactReview?: boolean; bounds?: Electron.Rectangle } = {},
) {
	if (workspaceTransition?.target === "editor" && !workspaceTransition.window.isDestroyed()) {
		return;
	}
	const compactBounds = options.compactReview
		? (options.bounds ?? compactReviewBoundsNear(mainWindow))
		: undefined;
	if (editorWindow && !editorWindow.isDestroyed()) {
		const previousWindow = mainWindow;
		mainWindow = editorWindow;
		if (options.bounds) reviewsInStudioFrame.add(editorWindow);
		else reviewsInStudioFrame.delete(editorWindow);
		// A review the user put in native fullscreen stays there.
		if (compactBounds && !editorWindow.isFullScreen()) {
			if (editorWindow.isMaximized()) editorWindow.unmaximize();
			editorWindow.setMinimumSize(COMPACT_REVIEW_MIN_SIZE.width, COMPACT_REVIEW_MIN_SIZE.height);
			editorWindow.setBounds(compactBounds);
			setReviewWindowCompact(editorWindow, true);
		} else if (!compactBounds && compactReviewWindows.has(editorWindow)) {
			// Anything other than a finished recording opens the full workspace.
			editorWindow.setMinimumSize(800, 600);
			editorWindow.maximize();
		}
		editorWindow.show();
		editorWindow.focus();
		editorWindow.webContents.send("recording-workspace-returned");
		if (previousWindow && previousWindow !== editorWindow && !previousWindow.isDestroyed()) {
			isForceClosing = true;
			closeWithoutAnimation(previousWindow);
			isForceClosing = false;
		}
		return;
	}
	const previousWindow = mainWindow;
	const nextEditorWindow = createEditorWindow({}, { compactBounds });
	adoptEditorWindow(nextEditorWindow, Boolean(compactBounds));
	if (options.bounds) reviewsInStudioFrame.add(nextEditorWindow);
	workspaceTransition = { target: "editor", window: nextEditorWindow };
	mainWindow = nextEditorWindow;
	editorHasUnsavedChanges = false;

	// Keep the old workspace visible until a cold editor has painted its first
	// frame. Later recording round-trips reuse this editor and skip the cold path.
	nextEditorWindow.once("ready-to-show", () => {
		if (workspaceTransition?.window === nextEditorWindow) workspaceTransition = null;
		if (!previousWindow || previousWindow.isDestroyed()) return;
		isForceClosing = true;
		closeWithoutAnimation(previousWindow);
		isForceClosing = false;
	});
}

/**
 * Loads the review hidden while the first take records, so Stop shows a warm
 * window instead of building one. It loads no project until Electron shows it.
 */
function prewarmReviewWindow() {
	if ((editorWindow && !editorWindow.isDestroyed()) || workspaceTransition) return;
	const compactBounds = compactReviewBoundsNear(mainWindow);
	const win = createEditorWindow({ prewarm: "1" }, { compactBounds, hidden: true });
	adoptEditorWindow(win, true);
}

let reviewPrewarmTimer: NodeJS.Timeout | null = null;
function scheduleReviewPrewarm(recording: boolean) {
	if (reviewPrewarmTimer) clearTimeout(reviewPrewarmTimer);
	reviewPrewarmTimer = null;
	if (!recording) return;
	// Let the capture start settle before loading a renderer next to it.
	reviewPrewarmTimer = setTimeout(() => {
		reviewPrewarmTimer = null;
		if (isRecording) prewarmReviewWindow();
	}, 2_000);
}

function adoptEditorWindow(nextEditorWindow: BrowserWindow, compact: boolean) {
	editorWindow = nextEditorWindow;
	if (compact) compactReviewWindows.add(nextEditorWindow);
	nextEditorWindow.on("maximize", () => setReviewWindowCompact(nextEditorWindow, false));
	nextEditorWindow.on("enter-full-screen", () => setReviewWindowCompact(nextEditorWindow, false));
	nextEditorWindow.webContents.once("did-finish-load", () => {
		readyEditorWindows.add(nextEditorWindow);
	});
	nextEditorWindow.once("closed", () => {
		if (workspaceTransition?.window === nextEditorWindow) workspaceTransition = null;
		if (editorWindow === nextEditorWindow) editorWindow = null;
	});

	nextEditorWindow.on("close", (event) => {
		if (isForceClosing || !editorHasUnsavedChanges || isCloseConfirmInFlight) return;

		event.preventDefault();
		isCloseConfirmInFlight = true;

		const windowToClose = nextEditorWindow;
		if (!windowToClose || windowToClose.isDestroyed()) return;

		// Ask renderer to show the in-app close dialog.
		windowToClose.webContents.send("request-close-confirm");

		ipcMain.once("close-confirm-response", (event, choice: "save" | "discard" | "cancel") => {
			if (event.sender.id !== windowToClose?.webContents.id) return;
			isCloseConfirmInFlight = false;
			if (!windowToClose || windowToClose.isDestroyed()) return;

			if (choice === "save") {
				// Save first, then close when the renderer reports done.
				windowToClose.webContents.send("request-save-before-close");
				ipcMain.once("save-before-close-done", (event, shouldClose: boolean) => {
					if (event.sender.id !== windowToClose?.webContents.id) return;
					if (!shouldClose) return;
					forceCloseEditorWindow(windowToClose);
				});
			} else if (choice === "discard") {
				forceCloseEditorWindow(windowToClose);
			}
			// "cancel": flag reset, window stays open
		});
	});
}

function createSourceSelectorWindowWrapper() {
	sourceSelectorWindow = createSourceSelectorWindow();
	sourceSelectorWindow.on("closed", () => {
		sourceSelectorWindow = null;
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("source-selector-closed");
		}
	});
	return sourceSelectorWindow;
}

function createTranscriptWindowWrapper() {
	transcriptWindow = createTranscriptWindow();
	transcriptWindow.on("closed", () => {
		transcriptWindow = null;
	});
	return transcriptWindow;
}

function createNotesWindowWrapper() {
	{
		notesWindow = createNotesWindow();
		notesWindow.on("closed", () => {
			notesWindow = null;
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("notes-window-closed");
			}
		});
		return notesWindow;
	}
}

function createCountdownOverlayWindowWrapper() {
	if (countdownOverlayWindow && !countdownOverlayWindow.isDestroyed()) {
		return countdownOverlayWindow;
	}

	countdownOverlayWindow = createCountdownOverlayWindow();
	countdownOverlayWindow.on("closed", () => {
		countdownOverlayWindow = null;
	});
	return countdownOverlayWindow;
}

// Closing every window quits the app (tray goes too). The in-app "Return to Recorder"
// button covers the editor-to-HUD round-trip, so closing the last window means "I'm done".
// CLI mode owns its own lifecycle (see electron/cli/cliMain.ts).
if (!cliCommand) {
	app.on("window-all-closed", () => {
		app.quit();
	});
}

app.on("activate", () => {
	if (cliCommand) return;
	// On macOS, re-open a window when the dock icon is clicked and none are open.
	const hasVisibleWindow = BrowserWindow.getAllWindows().some((window) => {
		if (window.isDestroyed() || !window.isVisible()) {
			return false;
		}

		const url = window.webContents.getURL();
		const isCountdownOverlayWindow = url.includes("windowType=countdown-overlay");
		return !isCountdownOverlayWindow;
	});
	if (!hasVisibleWindow) {
		showMainWindow();
	}
});

const quitCaptureGuard = createQuitCaptureGuard({
	isCaptureRunning: isNativeMacCaptureRunning,
	stopCapture: stopNativeMacCaptureForQuit,
	quit: () => app.quit(),
});

app.on("before-quit", (event) => {
	// A check started seconds ago must not settle after the app is gone and try to open a
	// dialog on a quitting app.
	updateCheckAbort?.abort();
	liveTranscript?.stop();
	quittingForStudio = true;
	quitCaptureGuard.beforeQuit(event);
});

let agentServer: AgentServer | null = null;
let agentTranscriber: ParakeetProcess | null = null;

/**
 * The local agent socket: lets an agent on this machine review clean cuts and drive the open
 * windows (electron/agent/agentServer.ts). Unix only; KLIPPT_AGENT_SOCKET=off disables it.
 */
function startAgentServer(sttModelsDir: string) {
	if (process.platform === "win32" || process.env.KLIPPT_AGENT_SOCKET === "off") return;
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	const socketPath =
		process.env.KLIPPT_AGENT_SOCKET ||
		(runtimeDir
			? path.join(runtimeDir, "klippt", "agent.sock")
			: path.join(app.getPath("userData"), "agent.sock"));
	const server = new AgentServer({
		socketPath,
		outDir: path.join(app.getPath("temp"), "klippt-agent"),
		windows: () => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()),
		reviewWindow: () => (editorWindow && !editorWindow.isDestroyed() ? editorWindow : null),
		openStudio: () => studio?.open(),
		studioState: () => studio?.snapshot() ?? null,
		studioCommand: (raw) => {
			const command = parseStudioCommand(raw);
			if (!command || !studio) return false;
			studio.command(command);
			return true;
		},
		ffmpegPath: () => resolveFfmpeg(),
		transcriber: async () => {
			if (agentTranscriber?.running) return agentTranscriber;
			const binaryPath = resolveParakeetBinaryPath();
			if (!binaryPath) throw new Error("No speech helper on this machine.");
			await ensureModels({ baseDir: sttModelsDir, only: [parakeetModelId()] });
			agentTranscriber = new ParakeetProcess({
				binaryPath,
				modelDir: modelPaths(sttModelsDir)[parakeetModelId()],
				startTimeoutMs: 10 * 60_000,
			});
			return agentTranscriber;
		},
		version: app.getVersion(),
	});
	ipcMain.on("agent-reply", (_event, reply) => server.receiveReply(reply ?? {}));
	server.start().then(
		() => {
			agentServer = server;
			console.log(`[agent] listening on ${socketPath}`);
		},
		(error) => console.warn("[agent] socket unavailable:", error),
	);
}

app.on("will-quit", () => {
	agentServer?.stop();
	agentTranscriber?.stop();
	unregisterAllGlobalShortcuts();
});

const appReady = !cliCommand && hasSingleInstanceLock ? app.whenReady() : null;

appReady?.then(async () => {
	const startup = new RecordStartTimeline(Date.now, [
		{ stage: "process-start", atMs: process.getCreationTime() ?? Date.now() },
	]);
	startup.mark("app-ready");
	powerMonitor.on("shutdown", () => quitCaptureGuard.systemPoweringOff());
	installKlipptProtocol({
		rendererDist: RENDERER_DIST,
		resourceRoot: ASSET_BASE_DIR,
		resolveMediaPath: resolveApprovedRendererMediaPath,
		allowedCorsOrigins: VITE_DEV_SERVER_URL ? [new URL(VITE_DEV_SERVER_URL).origin] : [],
	});
	if (isDiagnosticModeEnabled()) {
		mainLogBuffer.install();
		console.info("[diagnostic] OPENSCREEN_DIAGNOSTIC=1, capturing console.* into ring buffer");
	}

	// Force "regular" activation policy so the Dock icon appears. The HUD overlay
	// (transparent, frameless, skipTaskbar) is the first window, and AppKit would
	// otherwise classify us as an accessory app.
	if (process.platform === "darwin") {
		app.dock?.show();
		if (!app.isPackaged) {
			const developmentIcon = nativeImage.createFromPath(
				path.join(process.env.APP_ROOT, "icons", "icons", "png", "512x512.png"),
			);
			if (!developmentIcon.isEmpty()) app.dock?.setIcon(developmentIcon);
		}
	}

	session.defaultSession.setPermissionCheckHandler(
		(webContents, permission, requestingOrigin, details) => {
			const allowed = [
				"media",
				"audioCapture",
				"microphone",
				"videoCapture",
				"camera",
				"screen",
				"display-capture",
			];
			return (
				allowed.includes(permission) &&
				isTrustedPermissionCheck(webContents, requestingOrigin, details, trustedRendererConfig)
			);
		},
	);

	session.defaultSession.setPermissionRequestHandler(
		(webContents, permission, callback, details) => {
			const allowed = [
				"media",
				"audioCapture",
				"microphone",
				"videoCapture",
				"camera",
				"screen",
				"display-capture",
			];
			callback(
				allowed.includes(permission) &&
					isTrustedPermissionRequest(webContents, details, trustedRendererConfig),
			);
		},
	);

	session.defaultSession.setDisplayMediaRequestHandler(
		(request, callback) => {
			const source = getSelectedDesktopSource();
			// ponytail: diagnostic for the 0-byte screen-recording bug. Log what
			// we're handing to the renderer so we can see if the source is stale
			// or the handler is returning an empty payload.
			console.info(
				`[display-media] videoRequested=${request.videoRequested} ` +
					`audioRequested=${request.audioRequested} ` +
					`source=${source ? `${source.id} (${source.name})` : "(none)"}`,
			);
			if (
				!isTrustedDisplayMediaRequest(request, trustedRendererConfig) ||
				!request.videoRequested ||
				!source
			) {
				callback({});
				return;
			}

			callback({
				video: source,
				...(request.audioRequested && process.platform === "win32" ? { audio: "loopback" } : {}),
			});
		},
		{ useSystemPicker: false },
	);

	// ponytail: forward renderer console.warn/error to main-process stdout so
	// recorder diagnostics (which fire in the renderer) show up next to the
	// main-process logs in `npm run dev` output. Without this, the
	// `[recorder:...]` lines from recorderHandle.ts are only visible in
	// DevTools. One-time wire; no per-message cost beyond a single IPC hop.
	const logChannels = ["log", "warn", "error"] as const;
	for (const channel of logChannels) {
		ipcMain.on(`renderer-console-${channel}`, (_event, ...args) => {
			const text = args
				.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
				.join(" ");
			const stream = channel === "error" ? process.stderr : process.stdout;
			stream.write(`[renderer:${channel}] ${text}\n`);
		});
	}

	// Request mic permission now. Screen Recording is requested lazily from the
	// source-picker action so its prompt isn't hidden behind the selector window.
	//
	// NOT awaited, on purpose. `askForMediaAccess` resolves only once the user
	// answers the modal TCC prompt, and `createWindow()` is 70 lines below this in
	// the same async block — so on a Mac where the microphone is still
	// `not-determined` (every first run, and every fresh dev machine) the app
	// showed a permission dialog with NO window behind it and created the HUD only
	// after it was dismissed. Nothing between here and `createWindow()` needs the
	// answer: the recorder re-checks the status when the user actually arms the mic.
	if (process.platform === "darwin") {
		const micStatus = systemPreferences.getMediaAccessStatus("microphone");
		if (micStatus !== "granted") {
			systemPreferences
				.askForMediaAccess("microphone")
				.then((granted) => console.info(`[permissions] microphone granted=${granted}`))
				.catch((error) => console.warn("[permissions] microphone request failed:", error));
		}
	}

	ipcMain.on("hud-overlay-close", () => {
		app.quit();
	});
	ipcMain.handle("set-locale", (_, locale: string) => {
		setMainLocale(locale);
		setupApplicationMenu();
		updateTrayMenu();
	});

	ipcMain.handle("update-global-shortcuts", (_, shortcuts: ShortcutsConfig) => {
		const success = registerGlobalShortcuts(shortcuts, globalShortcutHandlers);
		return { success };
	});

	createTray();
	updateTrayMenu();
	setupApplicationMenu();
	await ensureRecordingsDir();

	function currentHudWindow() {
		return mainWindow &&
			!mainWindow.isDestroyed() &&
			mainWindow.webContents.getURL().includes("windowType=hud-overlay")
			? mainWindow
			: null;
	}

	function switchToHudWrapper() {
		if (workspaceTransition?.target === "hud" && !workspaceTransition.window.isDestroyed()) {
			return;
		}
		if (
			mainWindow &&
			!mainWindow.isDestroyed() &&
			mainWindow.webContents.getURL().includes("windowType=hud-overlay")
		) {
			mainWindow.show();
			mainWindow.focus();
			return;
		}
		const previousWindow = mainWindow;
		const hudWindow = createHudOverlayWindow({ returnToReview: true });
		quitCaptureGuard.protectWindow(hudWindow);
		if (isMac || process.platform === "linux") createCameraPreviewWindow();
		workspaceTransition = { target: "hud", window: hudWindow };
		mainWindow = hudWindow;
		if (!hudWindow || !previousWindow || previousWindow.isDestroyed()) return;
		// The editor stays visible while the transparent HUD loads. Close it only
		// when the HUD can paint, so Record feels like one workspace changing shape
		// instead of one app disappearing before another appears.
		hudWindow.once("ready-to-show", () => {
			if (workspaceTransition?.window === hudWindow) workspaceTransition = null;
			if (previousWindow.isDestroyed()) return;
			if (previousWindow === editorWindow) {
				previousWindow.hide();
			} else {
				isForceClosing = true;
				previousWindow.close();
				isForceClosing = false;
			}
		});
		hudWindow.once("closed", () => {
			if (workspaceTransition?.window === hudWindow) workspaceTransition = null;
		});
	}

	const interruptedRecordingCheck = registerIpcHandlers(
		// A stopped take shown in the Studio stays there; Finish opens this review later.
		(options) => {
			if (options?.compactReview && studio?.keepsReview()) return;
			createEditorWindowWrapper(options);
		},
		createSourceSelectorWindowWrapper,
		createCountdownOverlayWindowWrapper,
		createNotesWindowWrapper,
		() => mainWindow,
		() => sourceSelectorWindow,
		() => notesWindow,
		() => countdownOverlayWindow,
		(recording: boolean, sourceName: string) => {
			selectedSourceName = sourceName;
			isRecording = recording;
			studio?.sync();
			scheduleReviewPrewarm(recording);
			if (!tray) createTray();
			updateTrayMenu(recording);
			if (!recording && !(process.platform === "linux" && studio?.ownsControls())) {
				showMainWindow();
			}
		},
		switchToHudWrapper,
		(point) =>
			isPointOverPrivateRecordingUi(
				point,
				[notesWindow, transcriptWindow, sourceSelectorWindow, countdownOverlayWindow].filter(
					(window): window is BrowserWindow => Boolean(window),
				),
			),
		{
			ipcMain,
			studioOwnsControls: () => studio?.ownsControls() ?? false,
			setCameraPreviewCaptureHidden,
			beforeCapture: async (capture) => {
				await studio?.beforeCapture(capture);
			},
			onRecordingSetupChanged: () => studio?.publish(),
			onTakeEvent: (event) => {
				if (event.kind === "session-updated") {
					studio?.sessionUpdated({
						recordingId: event.session.createdAt,
						clips: event.session.clips ?? [],
					});
					return;
				}
				if (event.kind === "stored")
					studio?.stored({
						recordingId: event.session.createdAt,
						clips: event.session.clips ?? [],
					});
				studio?.sync();
				if (!liveTranscript) return;
				// Resuming: the recording gets the CPU back before its first frame.
				if (event.kind === "resuming") return liveTranscript.interrupt();
				if (event.kind === "stored") {
					liveTranscript.rememberStoppedTake({
						recordingId: event.session.createdAt,
						clips: (event.session.clips ?? []).flatMap((clip) =>
							!clip.removed && clip.microphoneAudioPath
								? [
										{
											index: clip.index,
											microphoneAudioPath: clip.microphoneAudioPath,
											durationMs: clip.durationMs,
										},
									]
								: [],
						),
						live: false,
					});
				}
				liveTranscript.refreshAfterClip()?.catch((error: unknown) => {
					console.warn("[transcript] automatic pass failed:", error);
				});
			},
		},
	);

	const sttModelsDir = path.join(app.getPath("userData"), "stt-models");
	liveTranscript = new LiveTranscriptService({
		listClips: listTranscriptClips,
		ffmpegPath: () => resolveFfmpeg(),
		helperPath: () => resolveParakeetBinaryPath(),
		ensureModel: async (onProgress) => {
			await ensureModels({
				baseDir: sttModelsDir,
				only: [parakeetModelId()],
				onProgress: (event) => onProgress(event.downloadedBytes, event.totalBytes),
			});
			return modelPaths(sttModelsDir)[parakeetModelId()];
		},
		modelReady: () =>
			resolveParakeetBinaryPath() !== null && isModelOnDisk(sttModelsDir, parakeetModelId()),
		tempDir: path.join(app.getPath("temp"), "klippt-transcript"),
		cacheDir: path.join(app.getPath("userData"), "transcripts"),
		onSnapshot: (snapshot) => {
			sendTranscriptSnapshot(transcriptWindow, snapshot);
			studio?.publish();
		},
	});
	registerTranscriptIpc(ipcMain, {
		service: liveTranscript,
		openWindow: createTranscriptWindowWrapper,
		getWindow: () => transcriptWindow,
	});
	const studioCaptureGuard = new NiriCaptureWindowGuard("Klippt Studio", () => studio?.revoke());
	studio = new StudioController({
		take: studioTake,
		setup: studioSetup,
		openReview: (from) => createEditorWindowWrapper({ compactReview: true, bounds: from }),
		transcript: () =>
			liveTranscript?.snapshot() ?? {
				recordingId: null,
				clips: [],
				status: "idle",
				progress: null,
				download: null,
				error: null,
				updatedAt: 0,
			},
		// Only the recording HUD is the pill; after Finish the main window is the review.
		getPill: () => currentHudWindow(),
		ensurePill: () => {
			if (currentHudWindow()) return;
			switchToHudWrapper();
			const hud = currentHudWindow();
			// The new pill shows itself once it can paint; the Studio then takes over again.
			hud?.once("ready-to-show", () => setImmediate(() => studio?.open()));
		},
		createWindow: (near) => createStudioWindow(near),
		sendToPill: (channel, payload) => currentHudWindow()?.webContents.send(channel, payload),
		// macOS keeps protected windows out of capture; on Linux only niri can confirm it.
		outsideCapture: (nodeId) =>
			process.platform === "darwin" ? Promise.resolve(true) : studioCaptureGuard.begin(nodeId),
		endCaptureCheck: () => studioCaptureGuard.end(),
		moveOffCapture: (nodeId) =>
			process.platform === "linux" ? moveStudioOffCapture(nodeId) : Promise.resolve(null),
		returnTo: returnStudioTo,
		waitForUnmap: () => new Promise((resolve) => setTimeout(resolve, 150)),
		quitting: () => quittingForStudio,
	});
	registerStudioIpc(ipcMain, studio);
	// The pill runs the take; if its page dies nothing can pause or stop it any more.
	// Save what was recorded and open the review, as Stop would.
	app.on("render-process-gone", (_event, contents, details) => {
		if (details.reason === "clean-exit" || !mainWindow || mainWindow.isDestroyed()) return;
		if (contents !== mainWindow.webContents) return;
		if (!contents.getURL().includes("windowType=hud-overlay")) return;
		console.error("[hud] the recording pill crashed:", details.reason, details.exitCode);
		void stopTakeWithoutPill().then((saved) => {
			if (saved) createEditorWindowWrapper({ compactReview: true });
		});
	});

	let cleanCutReceiver: Electron.WebContents | null = null;
	let alignerDir: Promise<string | null> | null = null;
	const claudeCli = findClaudeCli();
	const cleanCut = new CleanCutService({
		ffmpegPath: () => resolveFfmpeg(),
		transcriber: async () => {
			const binaryPath = resolveParakeetBinaryPath();
			if (!binaryPath)
				throw new Error(
					process.platform === "linux"
						? "Clean cut's speech helper is missing from this build."
						: "Clean cut needs an Apple Silicon Mac on macOS 14 or newer.",
				);
			await ensureModels({ baseDir: sttModelsDir, only: [parakeetModelId()] });
			return new ParakeetProcess({
				binaryPath,
				modelDir: modelPaths(sttModelsDir)[parakeetModelId()],
				startTimeoutMs: 10 * 60_000,
			});
		},
		alignerModels: async () => {
			if (process.platform !== "darwin") return null;
			alignerDir ??= ensureAlignerModel(sttModelsDir).catch((error) => {
				console.warn("[clean-cut] aligner unavailable, cutting on recognizer times:", error);
				alignerDir = null;
				return null;
			});
			return alignerDir;
		},
		model: () =>
			claudeCli
				? claudeCliModel({
						binary: claudeCli,
						cacheDir:
							process.env.KLIPPT_CLEAN_CUT_REPLY_CACHE ??
							path.join(app.getPath("userData"), "clean-cut", "replies"),
						cacheOnly: process.env.KLIPPT_CLEAN_CUT_CACHE_ONLY === "1",
					})
				: null,
		tempDir: path.join(app.getPath("temp"), "klippt-clean-cut"),
		cacheDir: path.join(app.getPath("userData"), "clean-cut"),
		onSnapshot: (snapshot) => {
			if (cleanCutReceiver && !cleanCutReceiver.isDestroyed())
				cleanCutReceiver.send("clean-cut-snapshot", snapshot);
		},
	});
	registerCleanCutIpc(ipcMain, {
		service: cleanCut,
		resolveApprovedPath: resolveApprovedRendererMediaPath,
		setReceiver: (receiver) => {
			cleanCutReceiver = receiver;
		},
	});

	startAgentServer(sttModelsDir);

	startup.mark("handlers-registered");
	const shortcutsReady = loadAndRegisterGlobalShortcuts(globalShortcutHandlers);

	// --bench=<query>: run the export bench instead of the app. Opens the real
	// editor window (same webPreferences, same preload) pointed at the bench
	// entry, and quits when it reports back. See src/bench/runBench.ts.
	const benchArg = process.argv.find((a) => a.startsWith("--bench="));
	if (benchArg) {
		await shortcutsReady;
		ipcMain.handle("bench:finished", () => {
			// Let the reply reach the renderer before the process goes away.
			setTimeout(() => app.exit(0), 100);
		});
		const query = Object.fromEntries(new URLSearchParams(benchArg.slice("--bench=".length)));
		mainWindow = createEditorWindow({ ...query, windowType: "bench" });
		return;
	}

	// The IPC handlers above are registered synchronously, so the HUD can load now.
	// Export-journal recovery, the temp-directory sweep and the interrupted-recording
	// scan only decide whether the editor replaces the HUD, so they run behind it.
	createWindow();
	startup.mark("hud-created");
	mainWindow?.once("ready-to-show", () => {
		startup.mark("hud-ready-to-show");
		void appendRecordStartTiming(
			path.join(app.getPath("userData"), "diagnostics", "startup-timing.jsonl"),
			{
				recordedAt: new Date().toISOString(),
				success: true,
				action: "launch",
				steps: startup.steps(),
			},
		).catch(() => undefined);
	});

	const recoveredInterruptedRecording = await interruptedRecordingCheck.catch((error) => {
		console.warn("[startup] interrupted-recording check failed:", error);
		return false;
	});
	await shortcutsReady;
	if (recoveredInterruptedRecording) {
		createEditorWindowWrapper();
	}
});
