import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain as electronIpcMain, MessageChannelMain, screen } from "electron";
import { APP_DISPLAY_NAME } from "../src/lib/brand";
import {
	type CameraPreviewPoint,
	clampCameraPreviewPosition,
	defaultCameraPreviewPosition,
	expandedCameraPreviewBounds,
} from "./cameraPreviewGeometry";
import { COMPACT_REVIEW_MIN_SIZE, type WindowBounds } from "./compactReviewGeometry";
import { clampHudDragPosition } from "./hudDragGeometry";
import { shouldShowHudInactive, shouldStartHudClickThrough } from "./hudInputPolicy";
import { createTrustedRendererIpcMain } from "./ipc/trustedRendererIpc";
import {
	localRectanglesContainScreenPoint,
	normalizePrivateUiRectangles,
	type PrivateUiPoint,
	type PrivateUiRectangle,
	rectangleContainsScreenPoint,
	rectanglesContainScreenPoint,
} from "./privateRecordingUi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const HEADLESS = process.env["HEADLESS"] === "true";
const ipcMain = createTrustedRendererIpcMain(electronIpcMain, {
	devServerUrl: VITE_DEV_SERVER_URL,
});

// The HUD and Notes windows are excluded from every screen/window capture (WGC on Windows uses
// the same SetWindowDisplayAffinity this sets), so the recording controls never end up baked into
// the recorded video.
//
// The side effect is that they are equally invisible to an *agent's* screenshots, and the HUD is
// what opens the editor — which makes a whole slice of the app unreachable from automation. Hence
// this escape hatch, for testing only. It warns on every window it skips, because a recording made
// while it is set WILL contain the HUD.
const CONTENT_PROTECTION_DISABLED = process.env["OPENSCREEN_DISABLE_CONTENT_PROTECTION"] === "1";

// Forces protection back on where it is auto-disabled below, so the macOS
// regression can be re-tested against a future Electron without editing code.
const CONTENT_PROTECTION_FORCED = process.env["OPENSCREEN_FORCE_CONTENT_PROTECTION"] === "1";

/**
 * macOS 26 (Darwin 25) never displays a window that has had
 * `setContentProtection(true)` applied to it.
 *
 * Not "excludes it from captures" — which is the documented behaviour and the
 * whole point — but never paints it for the user either. Confirmed on Darwin
 * 25.5 / Electron 41.2.1 with the HUD: tray icon present, renderer alive and
 * painting (React mounted, no console errors), `ready-to-show` fired, `show()`
 * called, window at valid on-screen coordinates on the main display — and
 * nothing on screen. `showMainWindow()` from the tray and the global shortcut
 * were equally inert, because the window was already "visible" as far as
 * Electron was concerned. Unsetting protection makes it appear instantly; the
 * ordering of protect-vs-show makes no difference, so it is the call itself.
 *
 * `setContentProtection` maps to `NSWindow.sharingType = NSWindowSharingNone`,
 * a path Electron has repeatedly churned on (electron/electron#45990, and
 * PR #46886 reverting a macOS content-protection refactor).
 *
 * Gated on the Darwin major version rather than `darwin` wholesale: the
 * breakage is only *confirmed* on 25.x, and silently dropping protection on
 * older macOS — where it may well work — would be a privacy regression made on
 * no evidence.
 *
 * NOTE: this leaves the HUD capturable on macOS 26. Apple already made that
 * partly true regardless — ScreenCaptureKit ignores `sharingType`, so any
 * SCK-based recorder (including *ours*, see
 * `electron/native/screencapturekit/`) captures these windows anyway. The
 * durable fix is to exclude our own windows via `SCContentFilter`'s
 * `excludingWindows:`, which that helper currently passes as `[]`.
 */
const CONTENT_PROTECTION_BREAKS_DISPLAY = (() => {
	if (process.platform !== "darwin") return false;
	// getSystemVersion() reports the *macOS* version on darwin, not the Darwin
	// kernel version: measured "26.5.0" here where `os.release()` is "25.5.0".
	// So the affected major is 26, and the check must not be fed os.release().
	const macOSMajor = Number.parseInt(process.getSystemVersion().split(".")[0] ?? "", 10);
	return Number.isFinite(macOSMajor) && macOSMajor >= 26;
})();

function applyContentProtection(win: BrowserWindow, label: string) {
	if (CONTENT_PROTECTION_DISABLED) {
		console.warn(
			`[content-protection] OFF for the ${label} window ` +
				"(OPENSCREEN_DISABLE_CONTENT_PROTECTION=1) — it will appear in screen captures, " +
				"including recordings. Unset it for anything but automated testing.",
		);
		return;
	}
	if (CONTENT_PROTECTION_BREAKS_DISPLAY && !CONTENT_PROTECTION_FORCED) {
		console.warn(
			`[content-protection] OFF for the ${label} window — macOS ` +
				`${process.getSystemVersion()} never displays a content-protected window, so ` +
				"enabling it would make this window permanently invisible. It may therefore appear " +
				"in screen captures. Set OPENSCREEN_FORCE_CONTENT_PROTECTION=1 to re-test.",
		);
		return;
	}
	win.setContentProtection(true);
}

// Asset base URL for renderer (wallpapers, etc.). Packaged: extraResources copies
// public/wallpapers to resources/wallpapers. Unpackaged: <appRoot>/public/.
export const ASSET_BASE_DIR = process.defaultApp
	? path.join(__dirname, "..", "public")
	: process.resourcesPath;
export const ASSET_BASE_URL_ARG = "--asset-base-url=klippt://app/__resources__/";

let hudOverlayWindow: BrowserWindow | null = null;
let cameraPreviewWindow: BrowserWindow | null = null;
let cameraPreviewReady = false;
let cameraPreviewVisible = false;
let hudRendererReady = false;
let cameraPreviewRendererReady = false;
let cameraPreviewPortsConnected = false;
let cameraPreviewExpanded = false;
// Where the compact monitor sat before it was expanded, restored on collapse.
let cameraPreviewCompactPosition: CameraPreviewPoint | null = null;
let hudDirectionExclusionRectangles: PrivateUiRectangle[] = [];

const CAMERA_PREVIEW_SIZE = { width: 312, height: 186 } as const;

function isHudSender(senderId: number) {
	return Boolean(
		hudOverlayWindow &&
			!hudOverlayWindow.isDestroyed() &&
			hudOverlayWindow.webContents.id === senderId,
	);
}

ipcMain.on("hud-overlay-set-direction-exclusion-rects", (event, rectangles: unknown) => {
	if (!isHudSender(event.sender.id)) return;
	hudDirectionExclusionRectangles = normalizePrivateUiRectangles(rectangles);
});

/** True only for painted private surfaces, not the HUD's large transparent backing window. */
export function isPointOverPrivateRecordingUi(
	point: PrivateUiPoint,
	additionalPrivateWindows: BrowserWindow[] = [],
) {
	if (
		hudOverlayWindow &&
		!hudOverlayWindow.isDestroyed() &&
		hudOverlayWindow.isVisible() &&
		localRectanglesContainScreenPoint(
			point,
			hudOverlayWindow.getContentBounds(),
			hudDirectionExclusionRectangles,
		)
	) {
		return true;
	}

	if (
		cameraPreviewVisible &&
		cameraPreviewWindow &&
		!cameraPreviewWindow.isDestroyed() &&
		cameraPreviewWindow.isVisible() &&
		rectangleContainsScreenPoint(point, cameraPreviewWindow.getContentBounds())
	) {
		return true;
	}

	return rectanglesContainScreenPoint(
		point,
		additionalPrivateWindows
			.filter((window) => !window.isDestroyed() && window.isVisible())
			.map((window) => window.getContentBounds()),
	);
}

function connectCameraPreviewRenderers() {
	if (
		cameraPreviewPortsConnected ||
		!hudRendererReady ||
		!cameraPreviewRendererReady ||
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!cameraPreviewWindow ||
		cameraPreviewWindow.isDestroyed()
	) {
		return;
	}

	const { port1, port2 } = new MessageChannelMain();
	cameraPreviewPortsConnected = true;
	hudOverlayWindow.webContents.postMessage("camera-preview-port", { role: "producer" }, [port1]);
	cameraPreviewWindow.webContents.postMessage("camera-preview-port", { role: "consumer" }, [port2]);
}

function isCameraPreviewSender(senderId: number): boolean {
	return Boolean(
		cameraPreviewWindow &&
			!cameraPreviewWindow.isDestroyed() &&
			cameraPreviewWindow.webContents.id === senderId,
	);
}

// A renderer can mount after did-finish-load delivered the first MessagePort,
// and Vite can remount either side without reloading its BrowserWindow. Let the
// mounted page request a fresh pair so the preview cannot remain on Loading.
ipcMain.on("camera-preview-request-connection", (event) => {
	const senderId = event.sender.id;
	if (isHudSender(senderId)) hudRendererReady = true;
	else if (isCameraPreviewSender(senderId)) cameraPreviewRendererReady = true;
	else return;
	cameraPreviewPortsConnected = false;
	connectCameraPreviewRenderers();
});

function placeCameraPreview(position?: CameraPreviewPoint): CameraPreviewPoint | null {
	if (!cameraPreviewWindow || cameraPreviewWindow.isDestroyed()) return null;
	const display = position ? screen.getDisplayNearestPoint(position) : screen.getPrimaryDisplay();
	const nextPosition = position
		? clampCameraPreviewPosition(position, CAMERA_PREVIEW_SIZE, display.workArea)
		: defaultCameraPreviewPosition(display.workArea, CAMERA_PREVIEW_SIZE);
	cameraPreviewWindow.setPosition(nextPosition.x, nextPosition.y, false);
	return nextPosition;
}

function applyCameraPreviewVisibility() {
	if (!cameraPreviewWindow || cameraPreviewWindow.isDestroyed() || !cameraPreviewReady) return;
	if (cameraPreviewVisible) {
		cameraPreviewWindow.showInactive();
	} else {
		cameraPreviewWindow.hide();
	}
}

function setCameraPreviewExpanded(expanded: boolean) {
	if (!cameraPreviewWindow || cameraPreviewWindow.isDestroyed()) return;
	if (expanded === cameraPreviewExpanded) return;
	cameraPreviewExpanded = expanded;
	if (expanded) {
		const [x, y] = cameraPreviewWindow.getPosition();
		cameraPreviewCompactPosition = { x, y };
		const bounds = cameraPreviewWindow.getBounds();
		const display = screen.getDisplayNearestPoint({
			x: bounds.x + Math.round(bounds.width / 2),
			y: bounds.y + Math.round(bounds.height / 2),
		});
		cameraPreviewWindow.setBounds(expandedCameraPreviewBounds(display.workArea), false);
		return;
	}
	cameraPreviewWindow.setSize(CAMERA_PREVIEW_SIZE.width, CAMERA_PREVIEW_SIZE.height, false);
	placeCameraPreview(cameraPreviewCompactPosition ?? undefined);
	cameraPreviewCompactPosition = null;
}

ipcMain.on("camera-preview-set-expanded", (event, expanded: boolean) => {
	if (!isCameraPreviewSender(event.sender.id) || typeof expanded !== "boolean") return;
	setCameraPreviewExpanded(expanded);
});

ipcMain.on("camera-preview-set-visible", (event, visible: boolean) => {
	if (!isCameraPreviewSender(event.sender.id) || typeof visible !== "boolean") return;
	cameraPreviewVisible = visible;
	applyCameraPreviewVisibility();
});

ipcMain.on("camera-preview-set-position", (event, position: CameraPreviewPoint) => {
	if (
		!isCameraPreviewSender(event.sender.id) ||
		!position ||
		typeof position.x !== "number" ||
		!Number.isFinite(position.x) ||
		typeof position.y !== "number" ||
		!Number.isFinite(position.y)
	) {
		return;
	}
	const appliedPosition = placeCameraPreview(position);
	if (appliedPosition) {
		cameraPreviewWindow?.webContents.send("camera-preview-position-changed", appliedPosition);
	}
});

// Origin the current drag gesture started from. The renderer sends the pointer's
// *total* travel since pointerdown rather than per-frame deltas, so every move is
// an absolute `origin + delta` — no rounding to accumulate, and a dropped message
// self-corrects on the next one instead of leaving the window permanently offset.
let hudDragOrigin: { x: number; y: number } | null = null;

ipcMain.on("hud-overlay-hide", () => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		hudOverlayWindow.minimize();
	}
});

ipcMain.on("hud-overlay-ignore-mouse-events", (_event, ignore: boolean) => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		hudOverlayWindow.setIgnoreMouseEvents(ignore, { forward: true });
	}
});

ipcMain.on("hud-overlay-drag-start", () => {
	if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) {
		return;
	}

	// Under Wayland this origin is a lie: Electron documents getPosition() as returning
	// [0, 0] there, because the protocol prohibits a client from introspecting or
	// setting its own global coordinates. The origin+delta scheme below therefore
	// resolves against 0 rather than the window's real position, and setPosition() is
	// itself a no-op — so dragging cannot work on Wayland by this route at all. The
	// finiteness check only keeps a garbage origin from reaching a native setter.
	const [x, y] = hudOverlayWindow.getPosition();
	hudDragOrigin = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
});

ipcMain.on("hud-overlay-drag-to", (_event, deltaX: number, deltaY: number) => {
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!hudDragOrigin ||
		!Number.isFinite(deltaX) ||
		!Number.isFinite(deltaY)
	) {
		return;
	}

	// `| 0` is load-bearing, not defensive noise. Math.round returns NEGATIVE ZERO for
	// any delta in [-0.5, 0) — routine under fractional scaling, where screenY deltas
	// are fractional. V8's IsInt32() rejects -0, so gin refuses to convert it and the
	// main process dies with "Error processing argument at index 1, conversion failure
	// from". `Number.isFinite(-0)` is true, so a finiteness check does NOT catch this;
	// `| 0` collapses -0 to 0 and pins the value to int32. (`+ 0` would not: -0 + 0 is
	// still -0, and Math.trunc preserves it too.)
	const x = Math.round(hudDragOrigin.x + deltaX) | 0;
	const y = Math.round(hudDragOrigin.y + deltaY) | 0;
	const [width, height] = hudOverlayWindow.getSize();
	const display = screen.getDisplayNearestPoint({
		x: Math.round(x + width / 2),
		y: Math.round(y + height),
	});
	const next = clampHudDragPosition({ x, y }, { width, height }, display);

	hudOverlayWindow.setPosition(next.x, next.y, false);
});

ipcMain.on("hud-overlay-drag-end", () => {
	hudDragOrigin = null;
});

// Resize the HUD to fit its rendered content. Anchored by its bottom-centre so it
// stays where the user dragged it while only growing/shrinking, which lets the
// vertical tray layout grow tall instead of scrolling inside a fixed window.
//
// Applied in one shot rather than tweened. The renderer now reserves space for
// everything that can float above the bar, so a resize only ever accompanies a
// discrete content change (orientation flip, recording controls appearing) that
// snaps anyway — tweening the window across 10 frames just meant 10 frames of the
// bar sitting at an offset that didn't match the content it was drawn with.
ipcMain.on("hud-overlay-set-size", (_event, width: number, height: number) => {
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!Number.isFinite(width) ||
		!Number.isFinite(height)
	) {
		return;
	}

	// A resize re-anchors from the window's current bounds, which would fight the
	// position an in-flight drag is applying. The renderer re-measures on release.
	if (hudDragOrigin) {
		return;
	}

	const bounds = hudOverlayWindow.getBounds();

	// Clamp to the work area of the display the HUD sits on; on a short screen the
	// vertical layout can exceed the display, where the bar's own overflow scroll takes over.
	const { workArea } = screen.getDisplayMatching(bounds);
	const nextWidth = Math.min(workArea.width, Math.max(1, Math.round(width)));
	const nextHeight = Math.min(workArea.height, Math.max(1, Math.round(height)));

	if (bounds.width === nextWidth && bounds.height === nextHeight) {
		return;
	}

	const centerX = bounds.x + bounds.width / 2;
	const bottomY = bounds.y + bounds.height;

	// Growing height keeps the bottom edge anchored (so the vertical tray grows
	// upward from where the user left it), but that alone can push the top edge
	// above the screen — e.g. switching to the tall vertical layout while sitting
	// low/mid-screen. The drag handle lives at the tray's start (top, in vertical
	// mode), so an off-screen top edge makes the HUD both invisible and
	// undraggable back into view. Clamp both axes to the display's work area so
	// the window (and its drag handle) always stays fully reachable.
	const nextX = Math.min(
		Math.max(workArea.x, Math.round(centerX - nextWidth / 2)),
		workArea.x + workArea.width - nextWidth,
	);
	const nextY = Math.min(
		Math.max(workArea.y, Math.round(bottomY - nextHeight)),
		workArea.y + workArea.height - nextHeight,
	);

	hudOverlayWindow.setBounds({
		x: nextX,
		y: nextY,
		width: nextWidth,
		height: nextHeight,
	});
});

/**
 * Frameless transparent HUD overlay, always-on-top, centred at the bottom of the
 * primary display. Follows the user across macOS Spaces so it isn't lost on switch.
 */
export function createHudOverlayWindow(options: { returnToReview?: boolean } = {}): BrowserWindow {
	const primaryDisplay = screen.getPrimaryDisplay();
	const { workArea } = primaryDisplay;

	// Close to what the renderer asks for on its very first measurement (bar plus
	// the reserved space above it), so the HUD doesn't visibly resize itself the
	// instant it becomes visible. See src/components/launch/hudGeometry.ts.
	const windowWidth = 820;
	const windowHeight = 560;

	const x = Math.floor(workArea.x + (workArea.width - windowWidth) / 2);
	const y = Math.floor(workArea.y + workArea.height - windowHeight - 5);

	const win = new BrowserWindow({
		width: windowWidth,
		height: windowHeight,
		// Min/max are intentionally loose: the renderer resizes to fit content via
		// "hud-overlay-set-size" (above), needed for the vertical tray to grow taller.
		minWidth: 120,
		minHeight: 80,
		x: x,
		y: y,
		frame: false,
		transparent: true,
		// Fully-transparent ARGB backing. Without this macOS draws the window as a
		// rounded glass panel with a border around the HUD content.
		backgroundColor: "#00000000",
		// Don't let macOS mask the window into a rounded rect; the HUD bar provides
		// its own rounding and the window itself must be invisible.
		roundedCorners: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		hasShadow: false,
		show: false, // shown via ready-to-show to avoid black rectangle flash
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});
	hudRendererReady = false;
	cameraPreviewPortsConnected = false;

	// On macOS the renderer can still receive forwarded pointer movement while
	// this window is click-through. Set the native state before the first show so
	// the transparent backing surface cannot swallow a desktop click during the
	// short gap before React mounts. Windows keeps the renderer-driven path below:
	// Electron implements forwarding there with a global low-level mouse hook.
	if (shouldStartHudClickThrough(process.platform)) {
		win.setIgnoreMouseEvents(true, { forward: true });
	}

	// Windows is deliberately not born click-through: the renderer asks for it on
	// mount over "hud-overlay-ignore-mouse-events". On Windows the `forward` option is a global
	// WH_MOUSE_LL hook, and that hook is the only way out of the state, because
	// Chromium sends no pointermove to a window it has made input-transparent — so
	// the renderer can never ask to leave it on its own. Electron latches
	// the install behind `forwarding_mouse_messages_` and retries only after a
	// setIgnoreMouseEvents(false) — the very call a dead hook prevents. One refused
	// or revoked hook (Windows drops any whose callback overruns the 300 ms
	// LowLevelHooksTimeout — on this thread, still busy booting the app) and the HUD
	// is painted, inert, forever. Asking later moves the install onto an IPC message,
	// i.e. onto a main thread that is provably pumping.

	// Keep the recording controls out of the recording (see applyContentProtection).
	applyContentProtection(win, "HUD");

	// Follow the user across macOS Spaces, else the HUD stays pinned to the Space
	// it was first opened on.
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	// Show only once painted to avoid the black rectangle flash when a transparent
	// window is shown before its first paint.
	win.once("ready-to-show", () => {
		applyContentProtection(win, "HUD");
		if (HEADLESS) return;
		if (shouldShowHudInactive(process.platform)) win.showInactive();
		else win.show();
	});

	// The renderer listens to the mic for its idle level line only while the pill
	// is on screen, so tell it when the pill is minimized, hidden or back.
	const sendHudVisible = (visible: boolean) => {
		if (!win.isDestroyed()) win.webContents.send("hud-visibility-changed", visible);
	};
	win.on("minimize", () => sendHudVisible(false));
	win.on("hide", () => sendHudVisible(false));
	win.on("restore", () => sendHudVisible(true));
	win.on("show", () => sendHudVisible(true));

	win.webContents.on("did-finish-load", () => {
		// The page may load after the window was shown or minimized, or in a
		// headless run where it is never shown; send where it actually stands.
		sendHudVisible(win.isVisible() && !win.isMinimized());
		hudRendererReady = true;
		cameraPreviewPortsConnected = false;
		connectCameraPreviewRenderers();
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	hudOverlayWindow = win;

	win.on("closed", () => {
		if (hudOverlayWindow === win) {
			hudOverlayWindow = null;
			hudDirectionExclusionRectangles = [];
			hudDragOrigin = null;
			hudRendererReady = false;
			closeCameraPreviewWindow();
		}
	});

	const query = `?windowType=hud-overlay${options.returnToReview ? "&returnToReview=true" : ""}`;
	win.loadURL((VITE_DEV_SERVER_URL || "klippt://app/index.html") + query);

	return win;
}

/**
 * Separate private webcam monitor for the recording workspace. It is never
 * composited with the screen or used as final camera-layout state.
 */
export function createCameraPreviewWindow(): BrowserWindow {
	if (cameraPreviewWindow && !cameraPreviewWindow.isDestroyed()) return cameraPreviewWindow;

	const initialPosition = defaultCameraPreviewPosition(
		screen.getPrimaryDisplay().workArea,
		CAMERA_PREVIEW_SIZE,
	);
	const win = new BrowserWindow({
		...CAMERA_PREVIEW_SIZE,
		x: initialPosition.x,
		y: initialPosition.y,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		roundedCorners: false,
		resizable: false,
		movable: true,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		focusable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		hasShadow: false,
		show: false,
		...(process.platform === "darwin" ? { type: "panel" as const } : {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	applyContentProtection(win, "camera preview");
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		win.setAlwaysOnTop(true, "floating");
	}

	cameraPreviewWindow = win;
	cameraPreviewReady = false;
	cameraPreviewVisible = false;
	cameraPreviewExpanded = false;
	cameraPreviewCompactPosition = null;
	cameraPreviewRendererReady = false;
	cameraPreviewPortsConnected = false;

	win.once("ready-to-show", () => {
		if (cameraPreviewWindow !== win || win.isDestroyed()) return;
		cameraPreviewReady = true;
		applyContentProtection(win, "camera preview");
		applyCameraPreviewVisibility();
	});

	win.webContents.on("did-finish-load", () => {
		cameraPreviewRendererReady = true;
		cameraPreviewPortsConnected = false;
		connectCameraPreviewRenderers();
	});

	win.on("moved", () => {
		if (
			cameraPreviewWindow !== win ||
			win.isDestroyed() ||
			!cameraPreviewReady ||
			!cameraPreviewVisible ||
			!win.isVisible()
		) {
			return;
		}
		const [x, y] = win.getPosition();
		win.webContents.send("camera-preview-position-changed", { x, y });
	});

	const keepPreviewOnScreen = () => {
		if (cameraPreviewWindow !== win || win.isDestroyed()) return;
		const [x, y] = win.getPosition();
		const appliedPosition = placeCameraPreview({ x, y });
		if (appliedPosition) {
			win.webContents.send("camera-preview-position-changed", appliedPosition);
		}
	};
	screen.on("display-removed", keepPreviewOnScreen);
	screen.on("display-metrics-changed", keepPreviewOnScreen);

	win.on("closed", () => {
		screen.off("display-removed", keepPreviewOnScreen);
		screen.off("display-metrics-changed", keepPreviewOnScreen);
		if (cameraPreviewWindow !== win) return;
		cameraPreviewWindow = null;
		cameraPreviewReady = false;
		cameraPreviewVisible = false;
		cameraPreviewRendererReady = false;
		cameraPreviewPortsConnected = false;
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=camera-preview");
	} else {
		win.loadURL("klippt://app/index.html?windowType=camera-preview");
	}

	return win;
}

/**
 * Closes a window with no macOS fade-and-shrink. When review replaces the pill,
 * only review should move; the pill and camera bubble just go.
 */
export function closeWithoutAnimation(win: BrowserWindow) {
	if (win.isDestroyed()) return;
	if (process.platform === "darwin") win.setOpacity(0);
	win.close();
}

export function closeCameraPreviewWindow() {
	const win = cameraPreviewWindow;
	cameraPreviewWindow = null;
	cameraPreviewReady = false;
	cameraPreviewVisible = false;
	cameraPreviewRendererReady = false;
	cameraPreviewPortsConnected = false;
	if (win) closeWithoutAnimation(win);
}

/**
 * Main editor window. Starts maximised with a hidden title bar on macOS; not
 * always-on-top and appears in the taskbar/dock.
 *
 * `query` overrides the renderer's routing params. The export bench disables
 * background throttling because it must keep rendering while headless. The normal
 * editor keeps Electron's throttling enabled so its warm, hidden window does not
 * compete with recording work.
 */
export function createEditorWindow(
	query: Record<string, string> = {},
	options: { compactBounds?: WindowBounds } = {},
): BrowserWindow {
	const isMac = process.platform === "darwin";
	const compact = options.compactBounds;

	const win = new BrowserWindow({
		...(compact ?? { width: 1200, height: 800 }),
		minWidth: compact ? COMPACT_REVIEW_MIN_SIZE.width : 800,
		minHeight: compact ? COMPACT_REVIEW_MIN_SIZE.height : 600,
		// Seamless titlebar on every platform: the app's own topbar IS the titlebar
		// (it already carries the logo, the title and a drag region). macOS keeps its
		// traffic lights, Windows/Linux get the native Window Controls Overlay — which
		// preserves Snap Layouts and the system close/maximise semantics instead of
		// re-implementing them as HTML buttons. Its colours follow the app theme via
		// the "set-titlebar-overlay" IPC (see handlers.ts).
		titleBarStyle: "hidden",
		...(isMac
			? { trafficLightPosition: { x: 18, y: 21 } }
			: { titleBarOverlay: { color: "#09090b", symbolColor: "#a1a1aa", height: 58 } }),
		transparent: false,
		resizable: true,
		alwaysOnTop: false,
		skipTaskbar: false,
		title: APP_DISPLAY_NAME,
		backgroundColor: "#09090b",
		show: false, // shown via ready-to-show to avoid white flash on first load
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: query.windowType === "bench" ? false : true,
		},
	});

	if (!compact) win.maximize();

	// The editor renders its own File/Edit/View menu bar in the custom titlebar,
	// so hide the native OS menu bar on Windows/Linux (it stays reachable via Alt).
	// macOS keeps its global menu bar.
	if (process.platform !== "darwin") {
		win.setAutoHideMenuBar(true);
	}

	// Show only once painted to avoid a white flash on cold Vite start.
	win.once("ready-to-show", () => {
		if (!HEADLESS) win.show();
	});

	// Inject dark background before any React paint so the sub-titlebar area never
	// flashes white on a cold Vite load.
	win.webContents.on("dom-ready", () => {
		// `--titlebar-inset-left` reserves room for the macOS traffic lights; on
		// Windows/Linux the topbar uses the `titlebar-area-*` env vars instead.
		win.webContents
			.insertCSS(
				`html, body, #root { background: #09090b !important; }
				 :root { --titlebar-inset-left: ${isMac ? "68px" : "0px"}; }`,
			)
			.catch(() => {
				// Best-effort cosmetic; ignore if the page is mid-teardown.
			});
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	const routing = { windowType: "editor", ...query };
	if (VITE_DEV_SERVER_URL) {
		win.loadURL(`${VITE_DEV_SERVER_URL}?${new URLSearchParams(routing).toString()}`);
	} else {
		win.loadURL(`klippt://app/index.html?${new URLSearchParams(routing).toString()}`);
	}

	return win;
}

/**
 * Floating source-selector window for picking a screen or window to record.
 * Frameless, transparent, and follows the user across macOS Spaces.
 */
export function createSourceSelectorWindow(): BrowserWindow {
	const { width, height } = screen.getPrimaryDisplay().workAreaSize;

	const win = new BrowserWindow({
		width: 680,
		height: 580,
		minHeight: 420,
		maxHeight: 680,
		x: Math.round((width - 680) / 2),
		y: Math.round((height - 580) / 2),
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		transparent: true,
		backgroundColor: "#00000000",
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	// Follow the user across macOS Spaces so the selector appears on the active
	// desktop regardless of where the HUD was opened.
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=source-selector");
	} else {
		win.loadURL("klippt://app/index.html?windowType=source-selector");
	}

	return win;
}

/**
 * Centered transparent countdown overlay that sits above the HUD during
 * recording pre-roll.
 */
export function createCountdownOverlayWindow(): BrowserWindow {
	const { workArea } = screen.getPrimaryDisplay();
	const overlayWidth = 420;
	const overlayHeight = 260;

	const win = new BrowserWindow({
		width: overlayWidth,
		height: overlayHeight,
		minWidth: overlayWidth,
		maxWidth: overlayWidth,
		minHeight: overlayHeight,
		maxHeight: overlayHeight,
		x: Math.round(workArea.x + (workArea.width - overlayWidth) / 2),
		y: Math.round(workArea.y + (workArea.height - overlayHeight) / 2),
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		focusable: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	win.setIgnoreMouseEvents(true);

	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=countdown-overlay");
	} else {
		win.loadURL("klippt://app/index.html?windowType=countdown-overlay");
	}

	return win;
}

const NOTES_WINDOW_DEFAULT_SIZE = { width: 320, height: 420 } as const;
const NOTES_WINDOW_MIN_SIZE = { width: 220, height: 140 } as const;

export interface NotesWindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

function isNotesWindowBounds(value: unknown): value is NotesWindowBounds {
	const candidate = value as Partial<NotesWindowBounds> | null;
	return Boolean(
		candidate &&
			[candidate.x, candidate.y, candidate.width, candidate.height].every(
				(entry) => typeof entry === "number" && Number.isFinite(entry),
			),
	);
}

/** Keeps a remembered notes window inside the display it is nearest to. */
export function clampNotesWindowBounds(
	bounds: NotesWindowBounds,
	workArea: { x: number; y: number; width: number; height: number },
): NotesWindowBounds {
	const width = Math.round(
		Math.min(workArea.width, Math.max(NOTES_WINDOW_MIN_SIZE.width, bounds.width)),
	);
	const height = Math.round(
		Math.min(workArea.height, Math.max(NOTES_WINDOW_MIN_SIZE.height, bounds.height)),
	);
	const position = clampCameraPreviewPosition(bounds, { width, height }, workArea);
	return { ...position, width, height };
}

let notesBoundsTimer: ReturnType<typeof setTimeout> | null = null;

function publishNotesWindowBounds(win: BrowserWindow) {
	if (notesBoundsTimer) clearTimeout(notesBoundsTimer);
	notesBoundsTimer = setTimeout(() => {
		notesBoundsTimer = null;
		if (win.isDestroyed()) return;
		win.webContents.send("notes-window-bounds-changed", win.getBounds());
	}, 250);
}

ipcMain.on("notes-window-set-bounds", (event, bounds: unknown) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win || win.isDestroyed() || !isNotesWindowBounds(bounds)) return;
	const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
	win.setBounds(clampNotesWindowBounds(bounds, display.workArea), false);
});

ipcMain.on("notes-window-close", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win && !win.isDestroyed()) win.close();
});

// Frameless, translucent notes card for gathering thoughts during a recording. It floats
// above everything, takes as little space as the user wants, and is excluded from capture.
export function createNotesWindow(): BrowserWindow {
	const win = new BrowserWindow({
		...NOTES_WINDOW_DEFAULT_SIZE,
		minWidth: NOTES_WINDOW_MIN_SIZE.width,
		minHeight: NOTES_WINDOW_MIN_SIZE.height,
		title: `${APP_DISPLAY_NAME} — Notes`,
		frame: false,
		// macOS: a frosted dark material under the card. Elsewhere a solid dark body,
		// since transparent windows need a compositor that is not guaranteed there.
		...(process.platform === "darwin"
			? {
					transparent: true,
					backgroundColor: "#00000000",
					vibrancy: "popover" as const,
					visualEffectState: "active" as const,
				}
			: { backgroundColor: "#111114" }),
		resizable: true,
		alwaysOnTop: true,
		skipTaskbar: false,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	// Match the editor: no native OS menu bar on Windows/Linux (reachable via Alt).
	if (process.platform !== "darwin") {
		win.setAutoHideMenuBar(true);
	}

	applyContentProtection(win, "Notes");
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		win.setAlwaysOnTop(true, "floating");
	}
	win.on("resize", () => publishNotesWindowBounds(win));
	win.on("move", () => publishNotesWindowBounds(win));
	win.once("ready-to-show", () => {
		applyContentProtection(win, "Notes");
		win.show();
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?showNotes=true");
	} else {
		win.loadURL("klippt://app/index.html?showNotes=true");
	}

	return win;
}
