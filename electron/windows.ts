import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain as electronIpcMain, MessageChannelMain, screen } from "electron";
import { APP_DISPLAY_NAME } from "../src/lib/brand";
import {
	type CameraPreviewPoint,
	type CameraPreviewSize,
	COMPACT_CAMERA_PREVIEW_SIZE,
	clampCameraPreviewPosition,
	clampCameraPreviewSize,
	defaultCameraPreviewPosition,
	expandedCameraPreviewBounds,
	resizedCameraPreviewSize,
} from "./cameraPreviewGeometry";
import { COMPACT_REVIEW_MIN_SIZE, type WindowBounds } from "./compactReviewGeometry";
import {
	clampHudDragPosition,
	DEFAULT_HUD_PILL_SIZE,
	type HudDockSide,
	hudBoundsAtEdge,
	hudDockPush,
	hudPulledOffEdge,
	initialHudBounds,
	openDisplaySides,
	pillCenterOf,
	resizeHudAroundPill,
} from "./hudDragGeometry";
import {
	hudPointerProbe,
	shouldShowHudInactive,
	shouldStartHudClickThrough,
} from "./hudInputPolicy";
import { createHudPointerWatch } from "./hudPointerWatch";
import { createTrustedRendererIpcMain } from "./ipc/trustedRendererIpc";
import { LINUX_HUD_INITIAL_SIZE, linuxHudWindowSize } from "./linuxHudGeometry";
import { NiriCaptureWindowGuard } from "./niriCaptureWindowGuard";
import {
	localRectanglesContainScreenPoint,
	normalizePrivateUiRectangles,
	type PrivateUiPoint,
	type PrivateUiRectangle,
	rectangleContainsScreenPoint,
	rectanglesContainScreenPoint,
} from "./privateRecordingUi";
import { LinuxCaptureConcealment } from "./recording/linuxCaptureConcealment";

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
 * NOTE: this leaves our windows capturable by other recorders on macOS 26;
 * ScreenCaptureKit ignores `sharingType` anyway. Our own display capture keeps
 * them out with an `SCContentFilter` that excludes the whole Klippt process
 * (`addNativeMacDisplayPrivacyExclusions`), which also covers windows opened
 * later, such as the Studio.
 */
const CONTENT_PROTECTION_BREAKS_DISPLAY = (() => {
	if (process.platform !== "darwin") return false;
	// getSystemVersion() reports the *macOS* version on darwin, not the Darwin
	// kernel version: measured "26.5.0" here where `os.release()` is "25.5.0".
	// So the affected major is 26, and the check must not be fed os.release().
	const macOSMajor = Number.parseInt(process.getSystemVersion().split(".")[0] ?? "", 10);
	return Number.isFinite(macOSMajor) && macOSMajor >= 26;
})();

/**
 * Linux has no content protection, so Notes and Transcript are concealed for the
 * moments the HUD is (see `setCameraPreviewCaptureHidden` and `LinuxRecordingHud`).
 */
const utilityWindowConcealment = new LinuxCaptureConcealment(process.platform);

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
/** The Studio gets its own camera relay port from the same producer; it never opens the camera. */
let studioWindow: BrowserWindow | null = null;
let cameraPreviewReady = false;
let cameraPreviewVisible = false;
let cameraPreviewCaptureHidden = false;
let cameraPreviewOutsideCapture = false;
let cameraPreviewCaptureGeneration = 0;
const cameraPreviewGuard = new NiriCaptureWindowGuard("Klippt Camera", () => {
	cameraPreviewOutsideCapture = false;
	applyCameraPreviewVisibility();
});
let hudRendererReady = false;
let cameraPreviewRendererReady = false;
let cameraPreviewPortsConnected = false;
let cameraPreviewExpanded = false;
// Where the compact monitor sat before it was expanded, restored on collapse.
let cameraPreviewCompactPosition: CameraPreviewPoint | null = null;
// The user's chosen compact size; Expand grows past it and Collapse returns to it.
let cameraPreviewCompactSize: CameraPreviewSize = { ...COMPACT_CAMERA_PREVIEW_SIZE };
// Window size when the current grip drag began; deltas are total pointer travel.
let cameraPreviewResizeOrigin: CameraPreviewSize | null = null;
let hudDirectionExclusionRectangles: PrivateUiRectangle[] = [];

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
	if (process.platform !== "linux" || !hudOverlayWindow) return;
	const size = linuxHudWindowSize(hudDirectionExclusionRectangles);
	if (!size) return;
	const [width, height] = hudOverlayWindow.getSize();
	if (width !== size.width || height !== size.height) {
		// Wayland owns global position. Resizing from local content must not run
		// the screen-coordinate pill clamping used by macOS and Windows.
		hudOverlayWindow.setSize(size.width, size.height);
	}
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

function connectStudioCameraRelay() {
	if (
		!hudRendererReady ||
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!studioWindow ||
		studioWindow.isDestroyed()
	)
		return;
	const { port1, port2 } = new MessageChannelMain();
	hudOverlayWindow.webContents.postMessage(
		"camera-preview-port",
		{ role: "producer", consumer: "studio" },
		[port1],
	);
	studioWindow.webContents.postMessage(
		"camera-preview-port",
		{ role: "consumer", consumer: "studio" },
		[port2],
	);
}

function isStudioSender(senderId: number): boolean {
	return Boolean(
		studioWindow && !studioWindow.isDestroyed() && studioWindow.webContents.id === senderId,
	);
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
	if (isStudioSender(senderId)) return connectStudioCameraRelay();
	if (isHudSender(senderId)) hudRendererReady = true;
	else if (isCameraPreviewSender(senderId)) cameraPreviewRendererReady = true;
	else return;
	cameraPreviewPortsConnected = false;
	connectCameraPreviewRenderers();
	// A remounted pill drops every port it produced for; the Studio needs a fresh one too.
	if (isHudSender(senderId)) connectStudioCameraRelay();
});

function placeCameraPreview(position?: CameraPreviewPoint): CameraPreviewPoint | null {
	if (!cameraPreviewWindow || cameraPreviewWindow.isDestroyed()) return null;
	const display = position ? screen.getDisplayNearestPoint(position) : screen.getPrimaryDisplay();
	const [width, height] = cameraPreviewWindow.getSize();
	const size = { width, height };
	const nextPosition = position
		? clampCameraPreviewPosition(position, size, display.workArea)
		: defaultCameraPreviewPosition(display.workArea, size);
	cameraPreviewWindow.setPosition(nextPosition.x, nextPosition.y, false);
	return nextPosition;
}

function applyCameraPreviewVisibility() {
	if (!cameraPreviewWindow || cameraPreviewWindow.isDestroyed() || !cameraPreviewReady) return;
	if (cameraPreviewVisible && (!cameraPreviewCaptureHidden || cameraPreviewOutsideCapture)) {
		cameraPreviewWindow.showInactive();
	} else {
		cameraPreviewWindow.hide();
	}
}

export async function setCameraPreviewCaptureHidden(
	hidden: boolean,
	pipeWireNodeId?: number,
): Promise<void> {
	if (process.platform !== "linux") return;
	utilityWindowConcealment.setConcealed(hidden);
	const generation = ++cameraPreviewCaptureGeneration;
	cameraPreviewCaptureHidden = hidden;
	cameraPreviewOutsideCapture = false;
	if (hidden && cameraPreviewVisible && cameraPreviewReady && cameraPreviewWindow?.isVisible()) {
		const allowed = await cameraPreviewGuard.begin(pipeWireNodeId);
		if (generation !== cameraPreviewCaptureGeneration) return;
		cameraPreviewOutsideCapture = allowed;
		if (!allowed) cameraPreviewGuard.end();
		if (allowed && cameraPreviewVisible && cameraPreviewWindow?.isVisible()) return;
		if (allowed) cameraPreviewGuard.invalidate();
	} else cameraPreviewGuard.end();
	applyCameraPreviewVisibility();
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
	cameraPreviewWindow.setSize(
		cameraPreviewCompactSize.width,
		cameraPreviewCompactSize.height,
		false,
	);
	placeCameraPreview(cameraPreviewCompactPosition ?? undefined);
	cameraPreviewCompactPosition = null;
}

function cameraPreviewWorkArea() {
	if (!cameraPreviewWindow || cameraPreviewWindow.isDestroyed()) return null;
	return screen.getDisplayMatching(cameraPreviewWindow.getBounds()).workArea;
}

/** Applies a compact size, keeps the top-left corner, and reports the applied size. */
function applyCameraPreviewCompactSize(width: number) {
	if (!cameraPreviewWindow || cameraPreviewWindow.isDestroyed()) return;
	const workArea = cameraPreviewWorkArea();
	if (!workArea) return;
	cameraPreviewCompactSize = clampCameraPreviewSize(width, workArea);
	if (cameraPreviewExpanded) return;
	const [x, y] = cameraPreviewWindow.getPosition();
	cameraPreviewWindow.setSize(
		cameraPreviewCompactSize.width,
		cameraPreviewCompactSize.height,
		false,
	);
	const appliedPosition = placeCameraPreview({ x, y });
	if (appliedPosition) {
		cameraPreviewWindow.webContents.send("camera-preview-position-changed", appliedPosition);
	}
}

ipcMain.on("camera-preview-set-size", (event, size: CameraPreviewSize) => {
	if (
		!isCameraPreviewSender(event.sender.id) ||
		!size ||
		typeof size.width !== "number" ||
		!Number.isFinite(size.width)
	) {
		return;
	}
	applyCameraPreviewCompactSize(size.width);
	cameraPreviewWindow?.webContents.send("camera-preview-size-changed", cameraPreviewCompactSize);
});

ipcMain.on("camera-preview-resize-start", (event) => {
	if (!isCameraPreviewSender(event.sender.id) || !cameraPreviewWindow) return;
	if (cameraPreviewWindow.isDestroyed() || cameraPreviewExpanded) return;
	const [width, height] = cameraPreviewWindow.getSize();
	cameraPreviewResizeOrigin = { width, height };
});

ipcMain.on("camera-preview-resize-to", (event, deltaX: number, deltaY: number) => {
	if (
		!isCameraPreviewSender(event.sender.id) ||
		!cameraPreviewResizeOrigin ||
		!Number.isFinite(deltaX) ||
		!Number.isFinite(deltaY)
	) {
		return;
	}
	const workArea = cameraPreviewWorkArea();
	if (!workArea) return;
	const next = resizedCameraPreviewSize(
		cameraPreviewResizeOrigin,
		{ x: deltaX, y: deltaY },
		workArea,
	);
	applyCameraPreviewCompactSize(next.width);
});

ipcMain.on("camera-preview-resize-end", (event) => {
	if (!isCameraPreviewSender(event.sender.id)) return;
	if (!cameraPreviewResizeOrigin) return;
	cameraPreviewResizeOrigin = null;
	cameraPreviewWindow?.webContents.send("camera-preview-size-changed", cameraPreviewCompactSize);
});

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
// Size of the painted pill, reported by the renderer. Only the pill must stay on
// the display; the transparent window around it may reach past the edges.
let hudPillSize = { ...DEFAULT_HUD_PILL_SIZE };
// The edge the pill is tucked into as a tab. The window does not move to tuck or
// untuck: the pill already touches that edge, and the renderer slides it in and out.
let hudDockSide: HudDockSide | null = null;
// The edge the current drag is shoving the pill past; it tucks in there on release.
let hudDockPushSide: HudDockSide | null = null;

function sendHudDock() {
	if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) return;
	hudOverlayWindow.webContents.send("hud-overlay-dock-changed", hudDockSide);
}

/** The display under the painted pill, which may sit far from the window's centre. */
function displayUnderPill(pillCenter: { x: number; y: number }) {
	return screen.getDisplayNearestPoint({
		x: Math.round(pillCenter.x),
		y: Math.round(pillCenter.y),
	});
}

// The renderer tucks the pill back in on launch and slides it out on a click on the
// tab or when a take starts capturing. Tucking first sets the pill against that edge.
ipcMain.on("hud-overlay-set-dock", (event, side: unknown) => {
	if (!isHudSender(event.sender.id)) return;
	const win = hudOverlayWindow;
	if ((side === "left" || side === "right" || side === "top") && win && !win.isDestroyed()) {
		const bounds = win.getBounds();
		const center = pillCenterOf(bounds, bounds, hudPillSize);
		const display = displayUnderPill(center);
		const others = screen
			.getAllDisplays()
			.filter((other) => other.id !== display.id)
			.map((other) => other.bounds);
		// A restored edge another display now continues past stays untucked.
		if (openDisplaySides(display.bounds, others).has(side)) {
			if (hudDockSide !== side && process.platform !== "linux")
				win.setBounds(hudBoundsAtEdge(center, bounds, hudPillSize, display.workArea, side));
			hudDockSide = side;
		}
	} else if (side === null) {
		hudDockSide = null;
	}
	// Always answered, so a reloaded renderer learns where the pill stands.
	sendHudDock();
});

ipcMain.on("hud-overlay-hide", () => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		// Wayland has no unminimize request; hide/show remaps the toplevel.
		if (process.platform === "linux") hudOverlayWindow.hide();
		else hudOverlayWindow.minimize();
	}
});

const hudIgnoredMouseEvents = new WeakMap<BrowserWindow, boolean>();

function setHudIgnoreMouseEvents(win: BrowserWindow, ignore: boolean) {
	// Electron 44 supports ignored input on Wayland, but forwarding is only
	// supported on macOS/Windows. Ignoring Linux input would lose all re-entry.
	const effectiveIgnore = process.platform === "linux" ? false : ignore;
	if (hudIgnoredMouseEvents.get(win) === effectiveIgnore) return;
	if (process.platform === "linux") win.setIgnoreMouseEvents(false);
	else win.setIgnoreMouseEvents(effectiveIgnore, { forward: true });
	hudIgnoredMouseEvents.set(win, effectiveIgnore);
}

ipcMain.on("hud-overlay-ignore-mouse-events", (event, ignore: unknown) => {
	if (!isHudSender(event.sender.id) || typeof ignore !== "boolean") return;
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		setHudIgnoreMouseEvents(hudOverlayWindow, ignore);
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
	hudDockPushSide = null;
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
	const pillCenter = pillCenterOf({ x, y }, { width, height }, hudPillSize);
	const display = displayUnderPill(pillCenter);
	// Pulled well away from its edge, a tucked pill comes untucked and drags freely.
	if (hudDockSide && hudPulledOffEdge(pillCenter, hudPillSize, display.workArea, hudDockSide)) {
		hudDockSide = null;
		sendHudDock();
	}
	// Tucked, it slides only along its edge.
	const next = hudDockSide
		? hudBoundsAtEdge(pillCenter, { width, height }, hudPillSize, display.workArea, hudDockSide)
		: clampHudDragPosition({ x, y }, { width, height }, hudPillSize, display.workArea);
	if (!hudDockSide) {
		const others = screen
			.getAllDisplays()
			.filter((other) => other.id !== display.id)
			.map((other) => other.bounds);
		hudDockPushSide = hudDockPush(
			{ x, y },
			{ width, height },
			hudPillSize,
			display.workArea,
			openDisplaySides(display.bounds, others),
		);
	}

	hudOverlayWindow.setPosition(next.x, next.y, false);
});

ipcMain.on("hud-overlay-drag-end", () => {
	hudDragOrigin = null;
	if (hudDockPushSide) {
		hudDockSide = hudDockPushSide;
		sendHudDock();
	}
	hudDockPushSide = null;
});

// The HUD window can reach onto a neighbouring display, where Chromium's
// window.screen would describe the wrong one. The renderer places its panels
// against the work area of the display under the pill, which main tells it.
let hudWorkAreaSignature = "";
function sendHudWorkArea(win: BrowserWindow) {
	if (win.isDestroyed()) return;
	const bounds = win.getBounds();
	const { workArea } = screen.getDisplayNearestPoint({
		x: Math.round(bounds.x + bounds.width / 2),
		y: Math.round(bounds.y + bounds.height / 2),
	});
	const signature = `${workArea.x},${workArea.y},${workArea.width},${workArea.height}`;
	if (signature === hudWorkAreaSignature) return;
	hudWorkAreaSignature = signature;
	win.webContents.send("hud-overlay-work-area", workArea);
}

/** Moves or resizes the HUD so its pill stays where it was and on the display. */
function placeHudAroundPill(win: BrowserWindow, size: { width: number; height: number }) {
	if (process.platform === "linux") return;
	const bounds = win.getBounds();
	const pillCenter = pillCenterOf(bounds, bounds, hudPillSize);
	const { workArea } = displayUnderPill(pillCenter);
	const next = hudDockSide
		? hudBoundsAtEdge(pillCenter, size, hudPillSize, workArea, hudDockSide)
		: resizeHudAroundPill(bounds, size, hudPillSize, workArea);
	if (
		next.x === bounds.x &&
		next.y === bounds.y &&
		next.width === bounds.width &&
		next.height === bounds.height
	) {
		return;
	}
	win.setBounds(next);
}

// Resize the HUD around its pill. The pill sits at the window's centre, so a
// resize keeps that centre still and only the transparent margins change.
//
// Applied in one shot rather than tweened. The renderer reserves space for
// everything that can float beside the bar, so a resize only ever accompanies a
// discrete content change that snaps anyway.
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

	placeHudAroundPill(hudOverlayWindow, {
		width: Math.max(1, Math.round(width)),
		height: Math.max(1, Math.round(height)),
	});
});

// The painted pill changes size without the window doing so (minimize, expand,
// Record, tucking into an edge). It grows and shrinks from its left end, so the
// renderer also says how far its centre sits from the window's. A pill that grows at a screen edge is
// pulled back onto the display.
ipcMain.on(
	"hud-overlay-set-pill-size",
	(event, width: number, height: number, offsetX = 0, offsetY = 0) => {
		if (
			!isHudSender(event.sender.id) ||
			!Number.isFinite(width) ||
			!Number.isFinite(height) ||
			!Number.isFinite(offsetX) ||
			!Number.isFinite(offsetY)
		) {
			return;
		}
		hudPillSize = {
			width: Math.max(1, Math.round(width)),
			height: Math.max(1, Math.round(height)),
			offsetX: Math.round(offsetX),
			offsetY: Math.round(offsetY),
		};
		if (!hudOverlayWindow || hudOverlayWindow.isDestroyed() || hudDragOrigin) return;
		const [currentWidth, currentHeight] = hudOverlayWindow.getSize();
		placeHudAroundPill(hudOverlayWindow, { width: currentWidth, height: currentHeight });
	},
);

/**
 * Frameless transparent HUD overlay, always-on-top, with its pill centred near
 * the bottom of the primary display. Follows the user across macOS Spaces so it isn't lost on switch.
 */
export function createHudOverlayWindow(
	options: { returnToReview?: boolean; hidden?: boolean } = {},
): BrowserWindow {
	const primaryDisplay = screen.getPrimaryDisplay();
	const { workArea } = primaryDisplay;

	// Close to what the renderer asks for on its very first measurement (the bar
	// plus the menu room reserved on both sides of it), so the HUD doesn't visibly
	// resize itself the instant it becomes visible. See
	// src/components/launch/hudGeometry.ts.
	hudPillSize = { ...DEFAULT_HUD_PILL_SIZE };
	hudDockSide = null;
	const {
		x,
		y,
		width: windowWidth,
		height: windowHeight,
	} = initialHudBounds(
		process.platform === "linux" ? LINUX_HUD_INITIAL_SIZE : { width: 940, height: 1400 },
		hudPillSize,
		workArea,
	);

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
		// The menu room around the pill may reach past the display, so a pill
		// dragged to the top edge is not stopped by macOS keeping the window's
		// top below the menu bar. Only the pill itself is kept on screen.
		enableLargerThanScreen: true,
		alwaysOnTop: true,
		skipTaskbar: true,
		hasShadow: false,
		show: false, // shown via ready-to-show to avoid black rectangle flash
		// A panel floats above other apps' fullscreen Spaces; the camera monitor
		// already relies on the same type, and the pill must follow the user there.
		...(process.platform === "darwin" ? { type: "panel" as const } : {}),
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
		setHudIgnoreMouseEvents(win, true);
	}

	// Windows starts interactive until the renderer or cursor probe supplies the
	// first input decision. Native cursor probes can restore interaction even if
	// Windows' forwarded-movement hook is unavailable.

	// Keep the recording controls out of the recording (see applyContentProtection).
	applyContentProtection(win, "HUD");

	// Follow the user across macOS Spaces, else the HUD stays pinned to the Space
	// it was first opened on.
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		win.setAlwaysOnTop(true, "floating");
	}

	const pointerWatch = createHudPointerWatch({
		platform: process.platform,
		isVisible: () => !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
		isDragging: () => hudDragOrigin !== null,
		readPoint: () => hudPointerProbe(screen.getCursorScreenPoint(), win.getContentBounds()),
		onProbe: (point) => win.webContents.send("hud-overlay-pointer-check", point),
		onOutside: () => setHudIgnoreMouseEvents(win, true),
	});
	if (!HEADLESS) pointerWatch.start();

	// Show only once painted to avoid the black rectangle flash when a transparent
	// window is shown before its first paint.
	win.once("ready-to-show", () => {
		applyContentProtection(win, "HUD");
		if (HEADLESS || options.hidden) return;
		if (shouldShowHudInactive(process.platform)) win.showInactive();
		else win.show();
	});

	// The renderer listens to the mic for its idle level line only while the pill
	// is on screen, so tell it when the pill is minimized, hidden or back.
	const sendHudVisible = (visible: boolean) => {
		if (visible && !HEADLESS) pointerWatch.start();
		if (!win.isDestroyed()) win.webContents.send("hud-visibility-changed", visible);
	};
	win.on("minimize", () => sendHudVisible(false));
	win.on("hide", () => sendHudVisible(false));
	win.on("restore", () => sendHudVisible(true));
	win.on("show", () => sendHudVisible(true));

	win.on("move", () => sendHudWorkArea(win));
	const resendHudWorkArea = () => {
		hudWorkAreaSignature = "";
		sendHudWorkArea(win);
	};
	screen.on("display-metrics-changed", resendHudWorkArea);
	screen.on("display-added", resendHudWorkArea);
	screen.on("display-removed", resendHudWorkArea);

	win.webContents.on("did-finish-load", () => {
		// The page may load after the window was shown or minimized, or in a
		// headless run where it is never shown; send where it actually stands.
		sendHudVisible(win.isVisible() && !win.isMinimized());
		resendHudWorkArea();
		hudRendererReady = true;
		cameraPreviewPortsConnected = false;
		connectCameraPreviewRenderers();
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	hudOverlayWindow = win;

	win.on("closed", () => {
		pointerWatch.stop();
		screen.off("display-metrics-changed", resendHudWorkArea);
		screen.off("display-added", resendHudWorkArea);
		screen.off("display-removed", resendHudWorkArea);
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

	cameraPreviewCompactSize = { ...COMPACT_CAMERA_PREVIEW_SIZE };
	cameraPreviewResizeOrigin = null;
	const initialPosition = defaultCameraPreviewPosition(
		screen.getPrimaryDisplay().workArea,
		cameraPreviewCompactSize,
	);
	const win = new BrowserWindow({
		title: `${APP_DISPLAY_NAME} Camera`,
		...cameraPreviewCompactSize,
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

	win.on("page-title-updated", (event) => event.preventDefault());
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
		cameraPreviewGuard.invalidate();
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
		cameraPreviewGuard.end();
		cameraPreviewOutsideCapture = false;
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

function closeCameraPreviewWindow() {
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
	options: { compactBounds?: WindowBounds; hidden?: boolean } = {},
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
		if (!HEADLESS && !options.hidden) win.show();
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

const TRANSCRIPT_WINDOW_DEFAULT_SIZE = { width: 440, height: 600 } as const;
const TRANSCRIPT_WINDOW_MIN_SIZE = { width: 300, height: 220 } as const;

/**
 * Read-only transcript of the current take. Same floating dark card as Notes, kept
 * out of capture; the text is never written into the project.
 */
export function createTranscriptWindow(): BrowserWindow {
	const win = new BrowserWindow({
		...TRANSCRIPT_WINDOW_DEFAULT_SIZE,
		minWidth: TRANSCRIPT_WINDOW_MIN_SIZE.width,
		minHeight: TRANSCRIPT_WINDOW_MIN_SIZE.height,
		title: `${APP_DISPLAY_NAME} — Transcript`,
		frame: false,
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
	if (process.platform !== "darwin") win.setAutoHideMenuBar(true);
	applyContentProtection(win, "Transcript");
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		win.setAlwaysOnTop(true, "floating");
	}
	win.once("closed", utilityWindowConcealment.track(win));
	win.once("ready-to-show", () => {
		applyContentProtection(win, "Transcript");
		if (utilityWindowConcealment.mayShow(win)) win.show();
	});
	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=transcript");
	} else {
		win.loadURL("klippt://app/index.html?windowType=transcript");
	}
	return win;
}

/**
 * The full-size recording view: replay, transcript and controls in one window, used
 * instead of the pill. Titled exactly "Klippt Studio" so the niri capture guard can find
 * it; the title never follows the page.
 */
export function createStudioWindow(near?: { x: number; y: number }): BrowserWindow {
	const display = near ? screen.getDisplayNearestPoint(near) : screen.getPrimaryDisplay();
	const area = display.workArea;
	const width = Math.round(Math.min(area.width, Math.max(960, area.width * 0.86)));
	const height = Math.round(Math.min(area.height, Math.max(640, area.height * 0.86)));
	const win = new BrowserWindow({
		title: `${APP_DISPLAY_NAME} Studio`,
		width,
		height,
		x: Math.round(area.x + (area.width - width) / 2),
		y: Math.round(area.y + (area.height - height) / 2),
		minWidth: 660,
		minHeight: 560,
		// The Mac keeps its own window buttons over the Studio's title strip.
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } }
			: { frame: false }),
		backgroundColor: "#111114",
		resizable: true,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});
	win.on("page-title-updated", (event) => event.preventDefault());
	if (process.platform !== "darwin") win.setAutoHideMenuBar(true);
	applyContentProtection(win, "Studio");
	studioWindow = win;
	win.on("closed", () => {
		if (studioWindow === win) studioWindow = null;
	});
	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=studio");
	} else {
		win.loadURL("klippt://app/index.html?windowType=studio");
	}
	return win;
}

const NOTES_WINDOW_DEFAULT_SIZE = { width: 320, height: 420 } as const;
const NOTES_WINDOW_MIN_SIZE = { width: 220, height: 140 } as const;

interface NotesWindowBounds {
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
function clampNotesWindowBounds(
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
	win.once("closed", utilityWindowConcealment.track(win));
	win.once("ready-to-show", () => {
		applyContentProtection(win, "Notes");
		if (utilityWindowConcealment.mayShow(win)) win.show();
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?showNotes=true");
	} else {
		win.loadURL("klippt://app/index.html?showNotes=true");
	}

	return win;
}
