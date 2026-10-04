/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
	interface ProcessEnv {
		/**
		 * The built directory structure
		 *
		 * ```tree
		 * ├─┬─┬ dist
		 * │ │ └── index.html
		 * │ │
		 * │ ├─┬ dist-electron
		 * │ │ ├── main.js
		 * │ │ └── preload.js
		 * │
		 * ```
		 */
		APP_ROOT: string;
		/** /dist/ or /public/ */
		VITE_PUBLIC: string;
	}
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
	electronAPI: {
		onAgentSessionRequest?: (
			callback: (
				message: import("../src/lib/ai-edition/agent/sessionProtocol").AgentSessionMessage,
			) => void,
		) => () => void;
		replyAgentSession?: (
			reply: import("../src/lib/ai-edition/agent/sessionProtocol").AgentSessionReply,
		) => void;
		getEntitlement: () => Promise<import("../src/lib/entitlements/contracts").EntitlementSnapshot>;
		activateEntitlement: (
			licenseKey: string,
		) => Promise<import("../src/lib/entitlements/contracts").EntitlementSnapshot>;
		refreshEntitlement: () => Promise<
			import("../src/lib/entitlements/contracts").EntitlementSnapshot
		>;
		deactivateEntitlement: () => Promise<
			import("../src/lib/entitlements/contracts").EntitlementSnapshot
		>;
		openEntitlementCheckout: () => Promise<{ opened: boolean }>;
		openEntitlementManagement: () => Promise<{ opened: boolean }>;
		onEntitlementChanged: (
			callback: (snapshot: import("../src/lib/entitlements/contracts").EntitlementSnapshot) => void,
		) => () => void;
		invokeNativeBridge: <TData = unknown>(
			request: import("../src/native/contracts").NativeBridgeRequest,
		) => Promise<import("../src/native/contracts").NativeBridgeResponse<TData>>;
		/** Export bench only (--bench=): tells main the run is over so it can quit. */
		benchFinished?: () => Promise<void>;
		/** Native (D3D) export progress — frames encoded so far, pushed at ~10 Hz max while
		 *  `compositor.export`/`compositor.exportMulti` runs. Distinct from `exportOnFrameAck`,
		 *  the OLD web/CPU pipeline's per-frame ack, not a progress signal. */
		onNativeExportProgress?: (callback: (frames: number) => void) => () => void;
		onNativeExportPhase?: (
			callback: (phase: import("../src/native/contracts").ExportTransactionPhase) => void,
		) => () => void;
		getSources: (opts: Electron.SourcesOptions) => Promise<ProcessedDesktopSource[]>;
		/** The last picker-sized source list, empty until one has been read. */
		getCachedSources?: () => Promise<ProcessedDesktopSource[]>;
		/** Warms a capture helper so the next Record starts faster. macOS only; elsewhere a no-op. */
		prewarmNativeMacCapture?: () => Promise<void>;
		switchToEditor: (options?: { compactReview?: boolean }) => Promise<void>;
		expandReviewWindow: () => Promise<{ success: boolean }>;
		isReviewWindowCompact: () => Promise<boolean>;
		fitReviewWindow: (request: { aspectRatio: number; chromeHeight: number }) => Promise<boolean>;
		onReviewWindowCompactChanged: (callback: (compact: boolean) => void) => () => void;
		switchToHud: () => Promise<void>;
		startNewRecording: (
			context?: import("../src/lib/recordingSession").RecordingWorkspaceContext,
		) => Promise<{ success: boolean; code?: "ENTITLEMENT_REQUIRED"; error?: string }>;
		getRecordingWorkspaceContext: () => Promise<{
			success: boolean;
			context?: import("../src/lib/recordingSession").RecordingWorkspaceContext | null;
		}>;
		onRecordingWorkspaceReturned?: (callback: () => void) => () => void;
		setRecordingWorkspaceContext: (
			context: import("../src/lib/recordingSession").RecordingWorkspaceContext | null,
		) => Promise<{
			success: boolean;
			context?: import("../src/lib/recordingSession").RecordingWorkspaceContext | null;
		}>;
		returnToEditorIfRecordingWorkspace: () => Promise<{ returned: boolean }>;
		openSourceSelector: () => Promise<{
			opened: boolean;
			reason?: string;
			access?: {
				success: boolean;
				granted: boolean;
				status: string;
				error?: string;
			};
		}>;
		openNotes: () => Promise<{
			opened: boolean;
			reason?: string;
		}>;
		closeNotesWindow: () => void;
		setNotesWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
		onNotesWindowBoundsChanged: (
			callback: (bounds: { x: number; y: number; width: number; height: number }) => void,
		) => () => void;
		selectSource: (source: ProcessedDesktopSource) => Promise<ProcessedDesktopSource | null>;
		getSelectedSource: () => Promise<ProcessedDesktopSource | null>;
		onSelectedSourceChanged: (callback: (source: ProcessedDesktopSource) => void) => () => void;
		onHudVisibilityChanged?: (callback: (visible: boolean) => void) => () => void;
		getRecordingPrefs: () => Promise<import("./ipc/handlers").RecordingPrefs>;
		setRecordingPrefs: (
			prefs: Partial<import("./ipc/handlers").RecordingPrefs>,
		) => Promise<import("./ipc/handlers").RecordingPrefs>;
		onRecordingPrefsChanged: (
			callback: (prefs: import("./ipc/handlers").RecordingPrefs) => void,
		) => () => void;
		onSourceSelectorClosed: (callback: () => void) => () => void;
		onAiEditionChatEvent: (
			callback: (event: import("../src/native/contracts").AiEditionChatEvent) => void,
		) => () => void;
		/** Opens macOS Privacy & Security > Camera, where the app's access is switched on. */
		openCameraPrivacySettings?: () => Promise<boolean>;
		requestCameraAccess: () => Promise<{
			success: boolean;
			granted: boolean;
			status: string;
			error?: string;
		}>;
		requestScreenAccess: () => Promise<{
			success: boolean;
			granted: boolean;
			status: string;
			error?: string;
		}>;
		requestNativeMacCursorAccess: () => Promise<{
			success: boolean;
			granted: boolean;
			status: string;
			error?: string;
		}>;
		assetBaseUrl: string;
		storeRecordedVideo: (
			videoData: ArrayBuffer,
			fileName: string,
		) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			error?: string;
		}>;
		storeRecordedSession: (
			payload: import("../src/lib/recordingSession").StoreRecordedSessionInput,
		) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			error?: string;
		}>;
		openRecordingStream: (fileName: string) => Promise<{ success: boolean; error?: string }>;
		appendRecordingChunk: (
			fileName: string,
			chunk: ArrayBuffer,
		) => Promise<{ success: boolean; error?: string }>;
		closeRecordingStream: (fileName: string) => Promise<{ success: boolean; error?: string }>;
		getRecordedVideoPath: () => Promise<{
			success: boolean;
			path?: string;
			message?: string;
			error?: string;
			phase?: import("../src/native/contracts").ExportTransactionPhase;
			code?: string;
			retryable?: boolean;
			exportWarning?: import("./export/atomicExport").ExportTransactionWarning;
		}>;
		setRecordingState: (
			recording: boolean,
			recordingId?: number,
			cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode,
		) => Promise<void>;
		isNativeWindowsCaptureAvailable: () => Promise<{
			success: boolean;
			available: boolean;
			helperPath?: string;
			reason?: string;
			error?: string;
		}>;
		isNativeMacCaptureAvailable: () => Promise<{
			success: boolean;
			available: boolean;
			helperPath?: string;
			reason?: "unsupported-platform" | "missing-helper" | string;
			error?: string;
		}>;
		startNativeWindowsRecording: (
			request: import("../src/lib/nativeWindowsRecording").NativeWindowsRecordingRequest,
		) => Promise<import("../src/lib/nativeWindowsRecording").NativeWindowsRecordingStartResult>;
		stopNativeWindowsRecording: (discard?: boolean) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			discarded?: boolean;
			error?: string;
		}>;
		pauseNativeWindowsRecording: () => Promise<{
			success: boolean;
			error?: string;
		}>;
		resumeNativeWindowsRecording: () => Promise<{
			success: boolean;
			error?: string;
		}>;
		startNativeMacRecording: (
			request: import("../src/lib/nativeMacRecording").NativeMacRecordingRequest,
		) => Promise<import("../src/lib/nativeMacRecording").NativeMacRecordingStartResult>;
		pauseNativeMacRecording: () => Promise<{
			success: boolean;
			clip?: import("../src/lib/recordingSession").RecordingSessionClip;
			paused?: boolean;
			error?: string;
		}>;
		resumeNativeMacRecording: (
			request?: import("../src/lib/nativeMacRecording").NativeMacRecordingRequest,
		) => Promise<{
			success: boolean;
			clipIndex?: number;
			error?: string;
		}>;
		removePreviousNativeMacClip: () => Promise<{
			success: boolean;
			clip?: import("../src/lib/recordingSession").RecordingSessionClip;
			error?: string;
		}>;
		restoreRemovedNativeMacClip: (clipIndex: number) => Promise<{
			success: boolean;
			clip?: import("../src/lib/recordingSession").RecordingSessionClip;
			error?: string;
		}>;
		onNativeMacRecordingError: (
			callback: (
				failure: import("../src/lib/nativeMacRecording").NativeMacRecordingFailure,
			) => void,
		) => () => void;
		stopNativeMacRecording: (discard?: boolean) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			warning?: string;
			discarded?: boolean;
			error?: string;
		}>;
		attachNativeMacWebcamRecording: (payload: {
			screenVideoPath: string;
			recordingId: number;
			webcam: import("../src/lib/recordingSession").RecordedVideoAssetInput;
			clips?: import("../src/lib/recordingSession").RecordingSessionClip[];
			cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode;
			durationMs?: number;
			webcamOffsetMs?: number;
		}) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			error?: string;
		}>;
		attachNativeMacClipWebcams: (payload: {
			screenVideoPath: string;
			recordingId: number;
			clips: import("../src/lib/recordingSession").RecordingSessionClip[];
			webcams: import("../src/lib/nativeMacRecording").NativeMacClipWebcamInput[];
		}) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			error?: string;
		}>;
		isNativeLinuxCaptureAvailable: () => Promise<{
			success: boolean;
			available: boolean;
			helperPath?: string;
			reason?: "unsupported-platform" | "missing-helper" | string;
			error?: string;
		}>;
		/**
		 * Raises the compositor's picker and holds the grant until the recording
		 * actually starts, so a countdown can run AFTER the user has chosen.
		 *
		 * Best-effort: a `success: false` means "start normally", never "fail".
		 */
		prepareNativeLinuxRecording: (
			request: import("../src/lib/nativeLinuxRecording").NativeLinuxRecordingRequest,
		) => Promise<{
			success: boolean;
			recordingId?: number;
			sourceKind?: "monitor" | "window" | "virtual" | null;
			reason?: string;
			error?: string;
		}>;
		/** Drops a prepared session when the countdown was abandoned. */
		cancelNativeLinuxPrepare: () => Promise<{ success: boolean }>;
		startNativeLinuxRecording: (
			request: import("../src/lib/nativeLinuxRecording").NativeLinuxRecordingRequest,
		) => Promise<import("../src/lib/nativeLinuxRecording").NativeLinuxRecordingStartResult>;
		pauseNativeLinuxRecording: () => Promise<{
			success: boolean;
			error?: string;
		}>;
		resumeNativeLinuxRecording: () => Promise<{
			success: boolean;
			error?: string;
		}>;
		stopNativeLinuxRecording: (discard?: boolean) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			discarded?: boolean;
			error?: string;
		}>;
		attachNativeLinuxWebcamRecording: (payload: {
			screenVideoPath: string;
			recordingId: number;
			webcam: import("../src/lib/recordingSession").RecordedVideoAssetInput;
			cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode;
			durationMs?: number;
			webcamOffsetMs?: number;
		}) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			error?: string;
		}>;
		discardCursorTelemetry: (recordingId: number) => Promise<void>;
		getCursorTelemetry: (videoPath?: string) => Promise<{
			success: boolean;
			samples: CursorTelemetryPoint[];
			clicks: number[];
			message?: string;
			error?: string;
		}>;
		onStopRecordingFromTray: (callback: () => void) => () => void;
		openExternalUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
		pickExportSavePath: (
			fileName: string,
			exportFolder?: string,
		) => Promise<{
			success: boolean;
			path?: string;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		writeExportToPath: (
			videoData: ArrayBuffer,
			filePath: string,
			spec: import("./native-bridge/services/compositorViewService").VideoBufferPublishSpec,
			exportId?: string,
		) => Promise<{
			success: boolean;
			path?: string;
			message?: string;
			error?: string;
			phase?: import("./export/atomicExport").ExportTransactionPhase;
			code?: import("./export/atomicExport").ExportTransactionErrorCode;
			retryable?: boolean;
			exportWarning?: import("./export/atomicExport").ExportTransactionWarning;
		}>;
		cancelWriteExport: (exportId: string) => Promise<{ cancelled: boolean }>;
		createTemporaryExportPath: () => Promise<string>;
		removeTemporaryExportPath: (
			filePath: string,
		) => Promise<{ success: boolean; message?: string }>;
		openVideoFilePicker: () => Promise<{
			success: boolean;
			code?: "ENTITLEMENT_REQUIRED";
			error?: string;
			path?: string;
			// Browser-mode shim only: a blob: URL has no meaningful basename, so
			// the shim carries the picked File's real name here for the label.
			name?: string;
			canceled?: boolean;
		}>;
		setCurrentVideoPath: (path: string) => Promise<{ success: boolean }>;
		setCurrentRecordingSession: (
			session: import("../src/lib/recordingSession").RecordingSession | null,
		) => Promise<{
			success: boolean;
			session?: import("../src/lib/recordingSession").RecordingSession;
			error?: string;
		}>;
		getCurrentVideoPath: () => Promise<{ success: boolean; path?: string }>;
		getCurrentRecordingSession: () => Promise<{
			success: boolean;
			session?: import("../src/lib/recordingSession").RecordingSession | null;
			canceled?: boolean;
		}>;
		findRecordingCamera: (videoPath: string) => Promise<{
			success: boolean;
			webcamVideoPath?: string;
			offsetMs?: number;
			error?: string;
		}>;
		readBinaryFile: (filePath: string) => Promise<{
			success: boolean;
			data?: ArrayBuffer;
			path?: string;
			message?: string;
			error?: string;
		}>;
		getReadableFileInfo: (filePath: string) => Promise<{
			success: boolean;
			size?: number;
			mtimeMs?: number;
			path?: string;
			message?: string;
			error?: string;
		}>;
		getAudioPeaks: (
			filePath: string,
			durationSec: number,
			track?: import("./media/audioPeaks").AudioTrackSelection,
			profile?: import("./media/audioPeaks").AudioPeakProfile,
		) => Promise<import("./media/audioPeaks").AudioPeaksResult>;
		getSpeechActivity: (
			filePath: string,
		) => Promise<import("./media/speechActivity").SpeechActivityIpcResult>;
		getCleanVoiceRuntime: (
			projectId: string,
			assetIds: string[],
		) => Promise<import("../src/lib/cleanVoiceRuntime").CleanVoiceRuntimeSnapshot>;
		onCleanVoiceStatus: (
			callback: (status: import("../src/lib/cleanVoiceRuntime").CleanVoiceRuntimeAsset) => void,
		) => () => void;
		readFileChunk: (
			filePath: string,
			offset: number,
			length: number,
		) => Promise<{
			success: boolean;
			data?: ArrayBuffer;
			bytesRead?: number;
			message?: string;
			error?: string;
		}>;
		preparePreviewAudioTrack: (filePath: string) => Promise<{
			success: boolean;
			path?: string | null;
			message?: string;
			error?: string;
		}>;
		clearCurrentVideoPath: () => Promise<{ success: boolean }>;
		saveProjectFile: (
			projectData: unknown,
			suggestedName?: string,
			existingProjectPath?: string,
		) => Promise<{
			success: boolean;
			path?: string;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		loadProjectFile: (projectFolder?: string) => Promise<{
			success: boolean;
			path?: string;
			project?: unknown;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		loadCurrentProjectFile: () => Promise<{
			success: boolean;
			path?: string;
			project?: unknown;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		getPathForFile: (file: File) => string;
		loadProjectFileFromPath: (filePath: string) => Promise<{
			success: boolean;
			path?: string;
			project?: unknown;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		onMenuNewProject: (callback: () => void) => () => void;
		onMenuImportVideo: (callback: () => void) => () => void;
		onMenuLoadProject: (callback: () => void) => () => void;
		onMenuSaveProject: (callback: () => void) => () => void;
		onMenuSaveProjectAs: (callback: () => void) => () => void;
		quitApp: () => void;
		setTitleBarOverlay: (color: string, symbolColor: string) => void;
		getPlatform: () => string;
		revealInFolder: (
			filePath: string,
		) => Promise<{ success: boolean; error?: string; message?: string }>;
		getShortcuts: () => Promise<Record<string, unknown> | null>;
		saveShortcuts: (shortcuts: unknown) => Promise<{ success: boolean; error?: string }>;
		updateGlobalShortcuts: (
			shortcuts: import("../src/lib/shortcuts").ShortcutsConfig,
		) => Promise<{ success: boolean }>;
		onHudToggleRecordingPause: (callback: () => void) => () => void;
		writeClipboardText: (text: string) => Promise<void>;
		hudOverlayHide: () => void;
		hudOverlayClose: () => void;
		setHudOverlayIgnoreMouseEvents: (ignore: boolean) => void;
		/** Pins the overlay's current position as the origin for `dragHudOverlayTo`. */
		beginHudOverlayDrag: () => void;
		/** Total pointer travel since `beginHudOverlayDrag`, not a per-frame delta. */
		dragHudOverlayTo: (deltaX: number, deltaY: number) => void;
		endHudOverlayDrag: () => void;
		setHudOverlaySize: (width: number, height: number) => void;
		setHudDirectionExclusionRectangles: (
			rectangles: Array<{ x: number; y: number; width: number; height: number }>,
		) => void;
		setCameraPreviewVisible: (visible: boolean) => void;
		setCameraPreviewExpanded: (expanded: boolean) => void;
		requestCameraPreviewConnection: () => void;
		reportCapturePerformance: (sample: {
			cameraDeliveredFps: number;
			cameraTimestampDriftMs?: number;
		}) => void;
		setCameraPreviewPosition: (position: { x: number; y: number }) => void;
		onCameraPreviewPositionChanged: (
			callback: (position: { x: number; y: number }) => void,
		) => () => void;
		showCountdownOverlay: (value: number, runId: number) => Promise<void>;
		setCountdownOverlayValue: (value: number, runId: number) => Promise<void>;
		hideCountdownOverlay: (runId: number) => Promise<void>;
		onCountdownOverlayValue: (callback: (value: number | null) => void) => () => void;
		setMicrophoneExpanded: (expanded: boolean) => void;
		setHasUnsavedChanges: (hasChanges: boolean) => void;
		onRequestSaveBeforeClose: (callback: () => Promise<boolean> | boolean) => () => void;
		onRequestCloseConfirm: (callback: () => void) => () => void;
		sendCloseConfirmResponse: (choice: "save" | "discard" | "cancel") => void;
		stt: {
			isAvailable: () => Promise<boolean>;
			transcribe: (
				request: import("./stt/transcriptionContract").SttTranscribeRequest,
			) => Promise<import("./stt/transcriptionContract").SttTranscribeResponse>;
			transcribeSource: (
				request: import("./stt/transcriptionContract").SttTranscribeSourceRequest,
			) => Promise<import("./stt/transcriptionContract").SttTranscribeSourceResponse>;
			cancel: () => Promise<void>;
			release: () => Promise<void>;
			onStatus: (
				callback: (event: import("./stt/transcriptionContract").SttStatusEvent) => void,
			) => () => void;
		};
		// CLI mode (hidden runner windows; see electron/cli/)
		cliGetRequest: () => Promise<import("../src/lib/cliContracts").CliRequest>;
		cliProgress: (progress: import("../src/lib/cliContracts").CliProgressEvent) => void;
		cliLog: (level: "info" | "error", message: string) => void;
		cliDone: (result: import("../src/lib/cliContracts").CliDoneResult) => Promise<void>;
		onCliStopRecording: (callback: () => void) => () => void;
		onCliCancelExport: (callback: () => void) => () => void;
		setLocale: (locale: string) => Promise<void>;
		saveDiagnostic: (payload: {
			error: string;
			stack?: string;
			logs?: string[];
		}) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
	};
}

interface ProcessedDesktopSource {
	id: string;
	name: string;
	display_id: string;
	thumbnail: string | null;
	appIcon: string | null;
}

interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
}
