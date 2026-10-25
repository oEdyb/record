import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { EntitlementSnapshot } from "../src/lib/entitlements/contracts";
import type { NativeLinuxRecordingRequest } from "../src/lib/nativeLinuxRecording";
import type {
	NativeMacRecordingInterruption,
	NativeMacRecordingRequest,
	NativeMacStorageStatus,
} from "../src/lib/nativeMacRecording";
import type { NativeWindowsRecordingRequest } from "../src/lib/nativeWindowsRecording";
import type {
	RecordingSession,
	RecordingWorkspaceContext,
	StoreRecordedSessionInput,
} from "../src/lib/recordingSession";
import type { ShortcutsConfig } from "../src/lib/shortcuts";
import { NATIVE_BRIDGE_CHANNEL, type NativeBridgeRequest } from "../src/native/contracts";
import type { RecordingPrefs } from "./ipc/handlers";

// Asset base URL is passed from the main process via webPreferences.additionalArguments
// (see windows.ts). Sandboxed preloads cannot import node:path / node:url, so we
// can't compute it here.
const ASSET_BASE_URL_ARG_PREFIX = "--asset-base-url=";
const assetBaseUrlArg = process.argv.find((arg) => arg.startsWith(ASSET_BASE_URL_ARG_PREFIX));
const assetBaseUrl = assetBaseUrlArg ? assetBaseUrlArg.slice(ASSET_BASE_URL_ARG_PREFIX.length) : "";

// Renderer side: process.platform is the same Node global as in the main process,
// so a synchronous read here saves the renderer's every-call IPC round-trip.
const PLATFORM = process.platform;

// MessagePort is the one Electron primitive that can move transferable preview
// frames renderer-to-renderer without copying them through the main process.
// Forward the port from the isolated preload world into the page world.
ipcRenderer.on("camera-preview-port", (event, payload: { role: "producer" | "consumer" }) => {
	window.postMessage(
		{ type: "openscreen-camera-preview-port", role: payload.role },
		"*",
		event.ports,
	);
});

contextBridge.exposeInMainWorld("electronAPI", {
	assetBaseUrl,
	getEntitlement: () => ipcRenderer.invoke("entitlement:get") as Promise<EntitlementSnapshot>,
	activateEntitlement: (licenseKey: string) =>
		ipcRenderer.invoke("entitlement:activate", licenseKey) as Promise<EntitlementSnapshot>,
	refreshEntitlement: () =>
		ipcRenderer.invoke("entitlement:refresh") as Promise<EntitlementSnapshot>,
	deactivateEntitlement: () =>
		ipcRenderer.invoke("entitlement:deactivate") as Promise<EntitlementSnapshot>,
	openEntitlementCheckout: () =>
		ipcRenderer.invoke("entitlement:checkout") as Promise<{ opened: boolean }>,
	openEntitlementManagement: () =>
		ipcRenderer.invoke("entitlement:manage") as Promise<{ opened: boolean }>,
	onEntitlementChanged: (callback: (snapshot: EntitlementSnapshot) => void) => {
		const listener = (_event: unknown, snapshot: EntitlementSnapshot) => callback(snapshot);
		ipcRenderer.on("entitlement:changed", listener);
		return () => ipcRenderer.removeListener("entitlement:changed", listener);
	},

	// --- Native export encoder -------------------------------------------------
	// The renderer composites and extracts frames but cannot spawn ffmpeg (it is
	// sandboxed, deliberately), so frames cross to main and it feeds ffmpeg's
	// stdin. Frames go one-way via send(); flow control is the caller's credit
	// window, acked on exportOnFrameAck.
	exportCapabilities: () =>
		ipcRenderer.invoke("export:capabilities") as Promise<{ encoder: string }>,
	exportStart: (req: unknown) =>
		ipcRenderer.invoke("export:start", req) as Promise<{
			sessionId: string;
			encoder: string;
			outputPath: string;
		}>,
	exportWriteFrame: (sessionId: string, frame: ArrayBuffer) => {
		// send() structured-clones, i.e. copies the frame. That is not an oversight
		// and it is not fixable here: Electron's transfer list takes MessagePort[]
		// only, and transferring an ArrayBuffer renderer->main silently drops the
		// whole message (electron#34905 - it works renderer->renderer, not to main).
		// The copy is what caps the crossing at ~390 MB/s, which is why the export
		// ships NV12 (3.0 MB/frame) rather than BGRA (7.9 MB).
		ipcRenderer.send("export:frame", sessionId, frame);
	},
	exportOnFrameAck: (cb: (sessionId: string, error: string | null) => void) => {
		const handler = (_e: unknown, sessionId: string, error: string | null) => cb(sessionId, error);
		ipcRenderer.on("export:frame-ack", handler);
		return () => ipcRenderer.off("export:frame-ack", handler);
	},
	exportFinish: (sessionId: string) =>
		ipcRenderer.invoke("export:finish", sessionId) as Promise<{ outputPath: string }>,
	exportCancel: (sessionId: string) =>
		ipcRenderer.invoke("export:cancel", sessionId) as Promise<void>,
	/** Export bench only (--bench=): tells main the run is over so it can quit. */
	benchFinished: () => ipcRenderer.invoke("bench:finished") as Promise<void>,
	/** Native (D3D) export progress — frames encoded so far, pushed at ~10 Hz max while
	 *  `compositor.export`/`compositor.exportMulti` runs. Distinct from `exportOnFrameAck`
	 *  above, which is the OLD web/CPU pipeline's per-frame ack, not a progress signal. */
	onNativeExportProgress: (cb: (frames: number) => void) => {
		const handler = (_e: unknown, frames: number) => cb(frames);
		ipcRenderer.on("export:native-progress", handler);
		return () => ipcRenderer.off("export:native-progress", handler);
	},
	onNativeExportPhase: (
		cb: (phase: import("../src/native/contracts").ExportTransactionPhase) => void,
	) => {
		const handler = (
			_e: unknown,
			phase: import("../src/native/contracts").ExportTransactionPhase,
		) => cb(phase);
		ipcRenderer.on("export:native-phase", handler);
		return () => ipcRenderer.off("export:native-phase", handler);
	},
	invokeNativeBridge: <TData>(request: NativeBridgeRequest) => {
		return ipcRenderer.invoke(NATIVE_BRIDGE_CHANNEL, request) as Promise<TData>;
	},
	hudOverlayHide: () => {
		ipcRenderer.send("hud-overlay-hide");
	},
	hudOverlayClose: () => {
		ipcRenderer.send("hud-overlay-close");
	},
	setHudOverlayIgnoreMouseEvents: (ignore: boolean) => {
		ipcRenderer.send("hud-overlay-ignore-mouse-events", ignore);
	},
	beginHudOverlayDrag: () => {
		ipcRenderer.send("hud-overlay-drag-start");
	},
	dragHudOverlayTo: (deltaX: number, deltaY: number) => {
		ipcRenderer.send("hud-overlay-drag-to", deltaX, deltaY);
	},
	endHudOverlayDrag: () => {
		ipcRenderer.send("hud-overlay-drag-end");
	},
	setHudOverlaySize: (width: number, height: number) => {
		ipcRenderer.send("hud-overlay-set-size", width, height);
	},
	setHudPillSize: (width: number, height: number, offsetX: number, offsetY = 0) => {
		ipcRenderer.send("hud-overlay-set-pill-size", width, height, offsetX, offsetY);
	},
	setHudDock: (side: "left" | "right" | "top" | null) => {
		ipcRenderer.send("hud-overlay-set-dock", side);
	},
	setHudDirectionExclusionRectangles: (
		rectangles: Array<{ x: number; y: number; width: number; height: number }>,
	) => {
		ipcRenderer.send("hud-overlay-set-direction-exclusion-rects", rectangles);
	},
	setCameraPreviewVisible: (visible: boolean) => {
		ipcRenderer.send("camera-preview-set-visible", visible);
	},
	setCameraPreviewExpanded: (expanded: boolean) => {
		ipcRenderer.send("camera-preview-set-expanded", expanded);
	},
	requestCameraPreviewConnection: () => {
		ipcRenderer.send("camera-preview-request-connection");
	},
	reportCapturePerformance: (sample: {
		cameraDeliveredFps: number;
		cameraTimestampDriftMs?: number;
	}) => {
		ipcRenderer.send("workload-capture-performance", sample);
	},
	setCameraPreviewPosition: (position: { x: number; y: number }) => {
		ipcRenderer.send("camera-preview-set-position", position);
	},
	setCameraPreviewSize: (size: { width: number; height: number }) => {
		ipcRenderer.send("camera-preview-set-size", size);
	},
	onCameraPreviewSizeChanged: (callback: (size: { width: number; height: number }) => void) => {
		const listener = (_event: unknown, size: { width: number; height: number }) => callback(size);
		ipcRenderer.on("camera-preview-size-changed", listener);
		return () => ipcRenderer.removeListener("camera-preview-size-changed", listener);
	},
	beginCameraPreviewResize: () => {
		ipcRenderer.send("camera-preview-resize-start");
	},
	resizeCameraPreviewTo: (deltaX: number, deltaY: number) => {
		ipcRenderer.send("camera-preview-resize-to", deltaX, deltaY);
	},
	endCameraPreviewResize: () => {
		ipcRenderer.send("camera-preview-resize-end");
	},
	onCameraPreviewPositionChanged: (callback: (position: { x: number; y: number }) => void) => {
		const listener = (_event: unknown, position: { x: number; y: number }) => callback(position);
		ipcRenderer.on("camera-preview-position-changed", listener);
		return () => ipcRenderer.removeListener("camera-preview-position-changed", listener);
	},
	getSources: async (opts: Electron.SourcesOptions) => {
		return await ipcRenderer.invoke("get-sources", opts);
	},
	getCachedSources: () => ipcRenderer.invoke("get-cached-sources"),
	prewarmNativeMacCapture: () => ipcRenderer.invoke("prewarm-native-mac-capture"),
	setNativeMacWarmCamera: (camera: unknown) =>
		ipcRenderer.send("set-native-mac-warm-camera", camera),
	switchToEditor: (options?: { compactReview?: boolean }) => {
		return ipcRenderer.invoke("switch-to-editor", options);
	},
	expandReviewWindow: () => {
		return ipcRenderer.invoke("expand-review-window");
	},
	fitReviewWindow: (request: { aspectRatio: number; chromeHeight: number }): Promise<boolean> => {
		return ipcRenderer.invoke("fit-review-window", request);
	},
	isReviewWindowCompact: (): Promise<boolean> => {
		return ipcRenderer.invoke("is-review-window-compact");
	},
	onReviewWindowCompactChanged: (callback: (compact: boolean) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, compact: boolean) => callback(compact);
		ipcRenderer.on("review-window-compact-changed", listener);
		return () => ipcRenderer.removeListener("review-window-compact-changed", listener);
	},
	switchToHud: () => {
		return ipcRenderer.invoke("switch-to-hud");
	},
	startNewRecording: (context?: RecordingWorkspaceContext) => {
		return ipcRenderer.invoke("start-new-recording", context);
	},
	getRecordingWorkspaceContext: () => {
		return ipcRenderer.invoke("get-recording-workspace-context");
	},
	onRecordingWorkspaceReturned: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("recording-workspace-returned", listener);
		return () => ipcRenderer.removeListener("recording-workspace-returned", listener);
	},
	setRecordingWorkspaceContext: (context: RecordingWorkspaceContext | null) => {
		return ipcRenderer.invoke("set-recording-workspace-context", context);
	},
	returnToEditorIfRecordingWorkspace: () => {
		return ipcRenderer.invoke("return-to-editor-if-recording-workspace");
	},
	openSourceSelector: () => {
		return ipcRenderer.invoke("open-source-selector");
	},
	openNotes: () => {
		return ipcRenderer.invoke("open-notes");
	},
	closeNotesWindow: () => {
		ipcRenderer.send("notes-window-close");
	},
	openTranscript: () => {
		return ipcRenderer.invoke("transcript-open");
	},
	closeTranscriptWindow: () => {
		ipcRenderer.send("transcript-window-close");
	},
	getTranscriptSnapshot: () => {
		return ipcRenderer.invoke("transcript-snapshot");
	},
	refreshTranscript: () => {
		return ipcRenderer.invoke("transcript-refresh");
	},
	onTranscriptUpdated: (callback: (snapshot: unknown) => void) => {
		const listener = (_event: unknown, snapshot: unknown) => callback(snapshot);
		ipcRenderer.on("transcript-updated", listener);
		return () => ipcRenderer.removeListener("transcript-updated", listener);
	},
	cleanCut: {
		start: (projectId: string, strength: "gentle" | "clean", document: unknown): Promise<void> =>
			ipcRenderer.invoke("clean-cut-start", { projectId, strength, document }),
		cancel: (): Promise<void> => ipcRenderer.invoke("clean-cut-cancel"),
		onSnapshot: (callback: (snapshot: unknown) => void) => {
			const listener = (_event: unknown, snapshot: unknown) => callback(snapshot);
			ipcRenderer.on("clean-cut-snapshot", listener);
			return () => ipcRenderer.removeListener("clean-cut-snapshot", listener);
		},
	},
	setNotesWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
		ipcRenderer.send("notes-window-set-bounds", bounds);
	},
	onNotesWindowBoundsChanged: (
		callback: (bounds: { x: number; y: number; width: number; height: number }) => void,
	) => {
		const listener = (
			_event: unknown,
			bounds: { x: number; y: number; width: number; height: number },
		) => callback(bounds);
		ipcRenderer.on("notes-window-bounds-changed", listener);
		return () => ipcRenderer.removeListener("notes-window-bounds-changed", listener);
	},
	selectSource: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("select-source", source);
	},
	getSelectedSource: () => {
		return ipcRenderer.invoke("get-selected-source");
	},
	getRecordingPrefs: () => {
		return ipcRenderer.invoke("get-recording-prefs");
	},
	setRecordingPrefs: (prefs: Partial<RecordingPrefs>) => {
		return ipcRenderer.invoke("set-recording-prefs", prefs);
	},
	onRecordingPrefsChanged: (callback: (prefs: RecordingPrefs) => void) => {
		const listener = (_event: unknown, prefs: RecordingPrefs) => callback(prefs);
		ipcRenderer.on("recording-prefs-changed", listener);
		return () => ipcRenderer.removeListener("recording-prefs-changed", listener);
	},
	onHudWorkAreaChanged: (
		callback: (area: { x: number; y: number; width: number; height: number }) => void,
	) => {
		const listener = (
			_event: unknown,
			area: { x: number; y: number; width: number; height: number },
		) => callback(area);
		ipcRenderer.on("hud-overlay-work-area", listener);
		return () => ipcRenderer.removeListener("hud-overlay-work-area", listener);
	},
	onHudPointerCheck: (callback: (point: { x: number; y: number } | null) => void) => {
		const listener = (_event: unknown, point: { x: number; y: number } | null) => callback(point);
		ipcRenderer.on("hud-overlay-pointer-check", listener);
		return () => ipcRenderer.removeListener("hud-overlay-pointer-check", listener);
	},
	onHudDockChanged: (callback: (side: "left" | "right" | "top" | null) => void) => {
		const listener = (_event: unknown, side: unknown) =>
			callback(side === "left" || side === "right" || side === "top" ? side : null);
		ipcRenderer.on("hud-overlay-dock-changed", listener);
		return () => ipcRenderer.removeListener("hud-overlay-dock-changed", listener);
	},
	onHudVisibilityChanged: (callback: (visible: boolean) => void) => {
		const listener = (_event: unknown, visible: boolean) => callback(visible === true);
		ipcRenderer.on("hud-visibility-changed", listener);
		return () => ipcRenderer.removeListener("hud-visibility-changed", listener);
	},
	onSelectedSourceChanged: (callback: (source: ProcessedDesktopSource) => void) => {
		const listener = (_event: unknown, source: ProcessedDesktopSource) => callback(source);
		ipcRenderer.on("selected-source-changed", listener);
		return () => ipcRenderer.removeListener("selected-source-changed", listener);
	},
	onSourceSelectorClosed: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("source-selector-closed", listener);
		return () => ipcRenderer.removeListener("source-selector-closed", listener);
	},
	requestCameraAccess: () => {
		return ipcRenderer.invoke("request-camera-access");
	},
	openCameraPrivacySettings: () => ipcRenderer.invoke("open-camera-privacy-settings"),
	requestScreenAccess: () => {
		return ipcRenderer.invoke("request-screen-access");
	},
	getCapturePermissions: () => ipcRenderer.invoke("get-capture-permissions"),
	requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
	openPrivacySettings: (kind: "screen" | "microphone" | "camera") =>
		ipcRenderer.invoke("open-privacy-settings", kind),
	relaunchApp: () => ipcRenderer.invoke("relaunch-app"),
	requestNativeMacCursorAccess: () => {
		return ipcRenderer.invoke("request-native-mac-cursor-access");
	},
	storeRecordedVideo: (videoData: ArrayBuffer, fileName: string) => {
		return ipcRenderer.invoke("store-recorded-video", videoData, fileName);
	},
	storeRecordedSession: (payload: StoreRecordedSessionInput) => {
		return ipcRenderer.invoke("store-recorded-session", payload);
	},
	openRecordingStream: (fileName: string) => {
		return ipcRenderer.invoke("open-recording-stream", fileName);
	},
	appendRecordingChunk: (fileName: string, chunk: ArrayBuffer) => {
		return ipcRenderer.invoke("append-recording-chunk", fileName, chunk);
	},
	closeRecordingStream: (fileName: string) => {
		return ipcRenderer.invoke("close-recording-stream", fileName);
	},

	getRecordedVideoPath: () => {
		return ipcRenderer.invoke("get-recorded-video-path");
	},
	setRecordingState: (
		recording: boolean,
		recordingId?: number,
		cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode,
	) => {
		return ipcRenderer.invoke("set-recording-state", recording, recordingId, cursorCaptureMode);
	},
	isNativeWindowsCaptureAvailable: () => {
		return ipcRenderer.invoke("is-native-windows-capture-available");
	},
	isNativeMacCaptureAvailable: () => {
		return ipcRenderer.invoke("is-native-mac-capture-available");
	},
	isNativeLinuxCaptureAvailable: () => {
		return ipcRenderer.invoke("is-native-linux-capture-available");
	},
	prepareNativeLinuxRecording: (request: NativeLinuxRecordingRequest) => {
		return ipcRenderer.invoke("prepare-native-linux-recording", request);
	},
	cancelNativeLinuxPrepare: () => {
		return ipcRenderer.invoke("cancel-native-linux-prepare");
	},
	startNativeLinuxRecording: (request: NativeLinuxRecordingRequest) => {
		return ipcRenderer.invoke("start-native-linux-recording", request);
	},
	pauseNativeLinuxRecording: () => {
		return ipcRenderer.invoke("pause-native-linux-recording");
	},
	resumeNativeLinuxRecording: () => {
		return ipcRenderer.invoke("resume-native-linux-recording");
	},
	stopNativeLinuxRecording: (discard?: boolean) => {
		return ipcRenderer.invoke("stop-native-linux-recording", discard);
	},
	attachNativeLinuxWebcamRecording: (payload: {
		screenVideoPath: string;
		recordingId: number;
		webcam: { fileName: string; videoData: ArrayBuffer };
		cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode;
		durationMs?: number;
		webcamOffsetMs?: number;
	}) => {
		return ipcRenderer.invoke("attach-native-linux-webcam-recording", payload);
	},
	startNativeWindowsRecording: (request: NativeWindowsRecordingRequest) => {
		return ipcRenderer.invoke("start-native-windows-recording", request);
	},
	stopNativeWindowsRecording: (discard?: boolean) => {
		return ipcRenderer.invoke("stop-native-windows-recording", discard);
	},
	pauseNativeWindowsRecording: () => {
		return ipcRenderer.invoke("pause-native-windows-recording");
	},
	resumeNativeWindowsRecording: () => {
		return ipcRenderer.invoke("resume-native-windows-recording");
	},
	startNativeMacRecording: (request: NativeMacRecordingRequest) => {
		return ipcRenderer.invoke("start-native-mac-recording", request);
	},
	pauseNativeMacRecording: () => {
		return ipcRenderer.invoke("pause-native-mac-recording");
	},
	resumeNativeMacRecording: (request?: NativeMacRecordingRequest) => {
		return ipcRenderer.invoke("resume-native-mac-recording", request);
	},
	prepareNativeMacContinue: (request: NativeMacRecordingRequest) => {
		return ipcRenderer.invoke("prepare-native-mac-continue", request);
	},
	removePreviousNativeMacClip: () => {
		return ipcRenderer.invoke("remove-previous-native-mac-clip");
	},
	restoreRemovedNativeMacClip: (clipIndex: number) => {
		return ipcRenderer.invoke("restore-removed-native-mac-clip", clipIndex);
	},
	onNativeMacRecordingError: (
		callback: (failure: import("../src/lib/nativeMacRecording").NativeMacRecordingFailure) => void,
	) => {
		const listener = (
			_: Electron.IpcRendererEvent,
			failure: import("../src/lib/nativeMacRecording").NativeMacRecordingFailure,
		) => callback(failure);
		ipcRenderer.on("native-mac-recording-error", listener);
		return () => ipcRenderer.removeListener("native-mac-recording-error", listener);
	},
	onNativeMacRecordingInterrupted: (callback: (reason: NativeMacRecordingInterruption) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, reason: NativeMacRecordingInterruption) =>
			callback(reason);
		ipcRenderer.on("native-mac-recording-interrupted", listener);
		return () => ipcRenderer.removeListener("native-mac-recording-interrupted", listener);
	},
	onNativeMacRecordingStorageLow: (callback: (status: NativeMacStorageStatus) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, status: NativeMacStorageStatus) =>
			callback(status);
		ipcRenderer.on("native-mac-recording-storage-low", listener);
		return () => ipcRenderer.removeListener("native-mac-recording-storage-low", listener);
	},
	onNativeMacRecordingStoppedByApp: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("native-mac-recording-stopped-by-app", listener);
		return () => ipcRenderer.removeListener("native-mac-recording-stopped-by-app", listener);
	},
	stopNativeMacRecording: (discard?: boolean, clickedAtMs?: number) => {
		return ipcRenderer.invoke("stop-native-mac-recording", discard, clickedAtMs);
	},
	markStopStage: (stage: string) => ipcRenderer.send("mark-stop-stage", stage),
	attachNativeMacWebcamRecording: (payload: {
		screenVideoPath: string;
		recordingId: number;
		webcam: { fileName: string; videoData: ArrayBuffer };
		clips?: import("../src/lib/recordingSession").RecordingSessionClip[];
		cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode;
		durationMs?: number;
		webcamOffsetMs?: number;
	}) => {
		return ipcRenderer.invoke("attach-native-mac-webcam-recording", payload);
	},
	attachNativeMacClipWebcams: (payload: {
		screenVideoPath: string;
		recordingId: number;
		clips: import("../src/lib/recordingSession").RecordingSessionClip[];
		webcams: import("../src/lib/nativeMacRecording").NativeMacClipWebcamInput[];
	}) => {
		return ipcRenderer.invoke("attach-native-mac-clip-webcams", payload);
	},
	getCursorTelemetry: (videoPath?: string) => {
		return ipcRenderer.invoke("get-cursor-telemetry", videoPath);
	},
	discardCursorTelemetry: (recordingId: number) => {
		return ipcRenderer.invoke("discard-cursor-telemetry", recordingId);
	},
	onStopRecordingFromTray: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("stop-recording-from-tray", listener);
		return () => ipcRenderer.removeListener("stop-recording-from-tray", listener);
	},
	openExternalUrl: (url: string) => {
		return ipcRenderer.invoke("open-external-url", url);
	},
	pickExportSavePath: (fileName: string, exportFolder?: string) => {
		return ipcRenderer.invoke("pick-export-save-path", fileName, exportFolder);
	},
	createTemporaryExportPath: () => {
		return ipcRenderer.invoke("create-temporary-export-path") as Promise<string>;
	},
	removeTemporaryExportPath: (filePath: string) => {
		return ipcRenderer.invoke("remove-temporary-export-path", filePath) as Promise<{
			success: boolean;
			message?: string;
		}>;
	},
	writeExportToPath: (
		videoData: ArrayBuffer,
		filePath: string,
		spec: import("./native-bridge/services/compositorViewService").VideoBufferPublishSpec,
		exportId: string | undefined,
		sourceMetadata: import("./native-bridge/services/compositorViewService").ExportSourceMetadata,
	) => {
		return ipcRenderer.invoke(
			"write-export-to-path",
			videoData,
			filePath,
			spec,
			exportId,
			sourceMetadata,
		);
	},
	cancelWriteExport: (exportId: string) => {
		return ipcRenderer.invoke("cancel-write-export", exportId) as Promise<{ cancelled: boolean }>;
	},
	chooseLocalFont: (request: import("../src/lib/localFont").ChooseLocalFontRequest) => {
		return ipcRenderer.invoke("choose-local-font", request) as Promise<
			import("../src/lib/localFont").ChooseLocalFontResult
		>;
	},
	openVideoFilePicker: () => {
		return ipcRenderer.invoke("open-video-file-picker");
	},
	setCurrentVideoPath: (path: string) => {
		return ipcRenderer.invoke("set-current-video-path", path);
	},
	setCurrentRecordingSession: (session: RecordingSession | null) => {
		return ipcRenderer.invoke("set-current-recording-session", session);
	},
	getCurrentVideoPath: () => {
		return ipcRenderer.invoke("get-current-video-path");
	},
	getCurrentRecordingSession: () => {
		return ipcRenderer.invoke("get-current-recording-session");
	},
	findRecordingCamera: (videoPath: string) => {
		return ipcRenderer.invoke("find-recording-camera", videoPath);
	},
	readBinaryFile: (filePath: string) => {
		return ipcRenderer.invoke("read-binary-file", filePath);
	},
	getReadableFileInfo: (filePath: string) => {
		return ipcRenderer.invoke("get-readable-file-info", filePath);
	},
	getCleanVoiceRuntime: (projectId: string, assetIds: string[]) => {
		return ipcRenderer.invoke("clean-voice:get-runtime", projectId, assetIds);
	},
	onCleanVoiceStatus: (
		callback: (status: import("../src/lib/cleanVoiceRuntime").CleanVoiceRuntimeAsset) => void,
	) => {
		const listener = (
			_event: unknown,
			status: import("../src/lib/cleanVoiceRuntime").CleanVoiceRuntimeAsset,
		) => callback(status);
		ipcRenderer.on("clean-voice:status", listener);
		return () => ipcRenderer.removeListener("clean-voice:status", listener);
	},
	readFileChunk: (filePath: string, offset: number, length: number) => {
		return ipcRenderer.invoke("read-file-chunk", filePath, offset, length);
	},
	preparePreviewAudioTrack: (filePath: string) => {
		return ipcRenderer.invoke("prepare-preview-audio-track", filePath);
	},
	clearCurrentVideoPath: () => {
		return ipcRenderer.invoke("clear-current-video-path");
	},
	saveProjectFile: (projectData: unknown, suggestedName?: string, existingProjectPath?: string) => {
		return ipcRenderer.invoke("save-project-file", projectData, suggestedName, existingProjectPath);
	},
	loadProjectFile: (projectFolder?: string) => {
		return ipcRenderer.invoke("load-project-file", projectFolder);
	},
	loadProjectFileFromPath: (filePath: string) => {
		return ipcRenderer.invoke("load-project-file-from-path", filePath);
	},
	getPathForFile: (file: File) => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
	loadCurrentProjectFile: () => {
		return ipcRenderer.invoke("load-current-project-file");
	},
	onMenuNewProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-new-project", listener);
		return () => ipcRenderer.removeListener("menu-new-project", listener);
	},
	onMenuImportVideo: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-import-video", listener);
		return () => ipcRenderer.removeListener("menu-import-video", listener);
	},
	onMenuLoadProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-load-project", listener);
		return () => ipcRenderer.removeListener("menu-load-project", listener);
	},
	onMenuSaveProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project", listener);
		return () => ipcRenderer.removeListener("menu-save-project", listener);
	},
	onMenuSaveProjectAs: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project-as", listener);
		return () => ipcRenderer.removeListener("menu-save-project-as", listener);
	},
	quitApp: () => {
		ipcRenderer.send("app-quit");
	},
	setTitleBarOverlay: (color: string, symbolColor: string) => {
		ipcRenderer.send("set-titlebar-overlay", color, symbolColor);
	},
	getPlatform: () => PLATFORM,
	revealInFolder: (filePath: string) => {
		return ipcRenderer.invoke("reveal-in-folder", filePath);
	},
	getShortcuts: () => {
		return ipcRenderer.invoke("get-shortcuts");
	},
	saveShortcuts: (shortcuts: unknown) => {
		return ipcRenderer.invoke("save-shortcuts", shortcuts);
	},
	updateGlobalShortcuts: (shortcuts: ShortcutsConfig) => {
		return ipcRenderer.invoke("update-global-shortcuts", shortcuts);
	},
	onHudStartRecording: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("hud-start-recording", listener);
		return () => ipcRenderer.removeListener("hud-start-recording", listener);
	},
	onHudToggleRecordingPause: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("hud-toggle-recording-pause", listener);
		return () => ipcRenderer.removeListener("hud-toggle-recording-pause", listener);
	},
	setLocale: (locale: string) => {
		return ipcRenderer.invoke("set-locale", locale);
	},
	writeClipboardText: (text: string) => {
		return ipcRenderer.invoke("clipboard:write-text", text) as Promise<void>;
	},
	saveDiagnostic: (payload: { error: string; stack?: string; logs?: string[] }) => {
		return ipcRenderer.invoke("save-diagnostic", payload);
	},
	setMicrophoneExpanded: (expanded: boolean) => {
		ipcRenderer.send("hud:setMicrophoneExpanded", expanded);
	},
	setHasUnsavedChanges: (hasChanges: boolean) => {
		ipcRenderer.send("set-has-unsaved-changes", hasChanges);
	},
	showCountdownOverlay: (value: number, runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-show", value, runId);
	},
	setCountdownOverlayValue: (value: number, runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-set-value", value, runId);
	},
	hideCountdownOverlay: (runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-hide", runId);
	},
	onCountdownOverlayValue: (callback: (value: number | null) => void) => {
		const listener = (_event: unknown, value: number | null) => callback(value);
		ipcRenderer.on("countdown-overlay-value", listener);
		return () => ipcRenderer.removeListener("countdown-overlay-value", listener);
	},
	onRequestSaveBeforeClose: (callback: () => Promise<boolean> | boolean) => {
		const listener = async () => {
			try {
				const shouldClose = await callback();
				ipcRenderer.send("save-before-close-done", shouldClose);
			} catch {
				ipcRenderer.send("save-before-close-done", false);
			}
		};
		ipcRenderer.on("request-save-before-close", listener);
		return () => ipcRenderer.removeListener("request-save-before-close", listener);
	},
	onRequestCloseConfirm: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("request-close-confirm", listener);
		return () => ipcRenderer.removeListener("request-close-confirm", listener);
	},
	sendCloseConfirmResponse: (choice: "save" | "discard" | "cancel") => {
		ipcRenderer.send("close-confirm-response", choice);
	},
	// ponytail: forward renderer console output to main-process stdout so
	// recorder diagnostics land next to the main-process logs in dev output.
	// One-way fire-and-forget; we deliberately don't await the IPC.
	rendererConsole: (channel: "log" | "warn" | "error", args: unknown[]) => {
		ipcRenderer.send(`renderer-console-${channel}`, ...args);
	},
	// --- CLI mode (hidden runner windows; see electron/cli/) ---
	cliGetRequest: (): Promise<import("../src/lib/cliContracts").CliRequest> => {
		return ipcRenderer.invoke("cli-get-request");
	},
	cliProgress: (progress: import("../src/lib/cliContracts").CliProgressEvent) => {
		ipcRenderer.send("cli-progress", progress);
	},
	cliLog: (level: "info" | "error", message: string) => {
		ipcRenderer.send("cli-log", level, message);
	},
	cliDone: (result: import("../src/lib/cliContracts").CliDoneResult) => {
		return ipcRenderer.invoke("cli-done", result);
	},
	onCliStopRecording: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("cli-stop-recording", listener);
		return () => ipcRenderer.removeListener("cli-stop-recording", listener);
	},
	onCliCancelExport: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("cli-cancel-export", listener);
		return () => ipcRenderer.removeListener("cli-cancel-export", listener);
	},
});
