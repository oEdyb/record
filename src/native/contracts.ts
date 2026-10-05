export const NATIVE_BRIDGE_CHANNEL = "native-bridge:invoke";
export const NATIVE_BRIDGE_VERSION = 1;

export type NativePlatform = "darwin" | "win32" | "linux";
export type CursorProviderKind = "native" | "none";
export type NativeCursorType =
	| "arrow"
	| "text"
	| "pointer"
	| "crosshair"
	| "open-hand"
	| "closed-hand"
	| "resize-ew"
	| "resize-ns"
	| "resize-nesw"
	| "resize-nwse"
	| "move"
	| "not-allowed"
	| "wait"
	| "app-starting"
	| "help"
	| "up-arrow";

export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
}

export interface CursorRecordingSample extends CursorTelemetryPoint {
	assetId?: string | null;
	visible?: boolean;
	cursorType?: NativeCursorType | null;
	interactionType?: "move" | "click" | "mouseup";
	/** Pointer was over private recorder UI that is excluded from captured pixels. */
	directionExcluded?: boolean;
	/** Opaque capture-session context. It contains no app name, title, or text. */
	directionContextId?: string;
	/** True on the first sample after the active app context changes. */
	directionContextChanged?: boolean;
}

export interface KeyboardActivitySample extends CursorTelemetryPoint {
	/** Number of key-down events observed in this sampling interval. */
	count: number;
	/** Whether macOS resolved an exact caret/selection bound or only the editable target. */
	focusSource?: "caret" | "target";
	/** Bounds of the focused editable element, normalized to the captured source. */
	targetRect?: { x: number; y: number; width: number; height: number };
	/** Focused target belongs to private recorder UI that is absent from captured pixels. */
	directionExcluded?: boolean;
	/** Opaque capture-session app context. It contains no app name, title, or text. */
	directionContextId?: string;
	/** Opaque focused editable identity used only to split typing activities. */
	directionTargetId?: string;
}

export interface NativeCursorAsset {
	id: string;
	platform: NativePlatform;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	scaleFactor?: number;
	cursorType?: NativeCursorType | null;
}

export interface CursorRecordingData {
	version: number;
	provider: CursorProviderKind;
	samples: CursorRecordingSample[];
	assets: NativeCursorAsset[];
	/** Privacy-safe activity only. Key codes, characters, shortcuts, and text are never stored. */
	keyboardActivity?: KeyboardActivitySample[];
}

export interface CursorCapabilities {
	telemetry: boolean;
	systemAssets: boolean;
	provider: CursorProviderKind;
}

export interface SystemCapabilities {
	bridgeVersion: typeof NATIVE_BRIDGE_VERSION;
	platform: NativePlatform;
	cursor: CursorCapabilities;
	project: {
		currentContext: boolean;
	};
}

export interface ProjectContext {
	currentProjectPath: string | null;
	currentVideoPath: string | null;
}

export interface ProjectPathResult {
	success: boolean;
	path?: string;
	message?: string;
	canceled?: boolean;
	error?: string;
}

export interface ProjectFileResult {
	success: boolean;
	path?: string;
	project?: unknown;
	message?: string;
	canceled?: boolean;
	error?: string;
}

// ---- Compositor view domain (Option A embed) -----------------------------
// Drives a native D3D11 compositor preview window embedded in the main app
// window. The Rust napi-rs addon (`compositor_view.node`) lives at
// `electron/native/compositor-view/` and is built OUT OF SCOPE for the TS
// layer; the service falls back to a safe no-op when the addon is absent so
// the renderer keeps running. Defined here (not in the addon .d.ts) so the
// renderer, the IPC contract, and the main-side service all import from a
// single TS source — never from the native `.d.ts`.

export interface CompositorViewRect {
	/** Device pixels, relative to the parent window's client area. */
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CompositorParamValue = boolean | number | string;

export interface CompositorViewResult {
	id: number;
}

/** Which backend the native compositor runs on.
 *
 *  `"cpu"` = WARP rasterisation with software decode and encode, selected automatically
 *  when no usable D3D11 GPU is present. Output is identical to the GPU path — the effects
 *  all render — but the preview runs at roughly 8 fps with everything on and exports take
 *  minutes rather than seconds, so it is worth telling the user about.
 *
 *  `"none"` = no native compositor at all (addon absent: pure-web dev, jsdom). NOT a
 *  degraded-GPU signal — never warn on it. */
export type CompositorBackend = "hardware" | "cpu" | "none";

export interface CompositorBackendResult {
	backend: CompositorBackend;
}

/** A self-describing preview frame returned by `readFrame` (native → renderer): pixels
 *  (`data`, RGBA8, `width * height * 4` bytes) plus their dimensions and a monotonic
 *  generation. The hook keeps `gen` and passes it back as `sinceGen`; an unchanged frame
 *  is never re-delivered, so the whole per-frame copy cost vanishes while nothing moves. */
export interface CompositorFramePacket {
	gen: number;
	width: number;
	height: number;
	data: Buffer;
	/** Source-media PTS of the frame native actually rendered. This is measured,
	 * not inferred from the renderer clock, so transport drift is observable. */
	sourceTimeSec: number;
	/** Sorted SceneDescription clip index used to render this frame. */
	clipIndex: number;
	/** Atomic transport command that produced this frame. Old frames can arrive
	 * after a seek; their lower generation keeps them out of drift decisions. */
	transportGeneration: number;
	/** GPU render-target readback and CPU copy time on the native render thread. */
	readbackMs: number;
}

export type CompositorFrameTiming = Pick<
	CompositorFramePacket,
	"sourceTimeSec" | "clipIndex" | "transportGeneration"
>;

/** One indivisible preview transport state. Keeping clip identity, exact source
 * time, and play state in one command prevents a late clip switch from undoing
 * a newer pause or seek. */
export interface CompositorTransportCommand {
	id: number;
	generation: number;
	playing: boolean;
	clipIndex: number;
	screenPath: string;
	webcamPath: string;
	webcamOffsetSec: number;
	sourceTimeSec: number;
}

/** Un clip de la timeline pour l'export multiclip natif (fichiers screen+webcam + trim). */
export interface CompositorClipInput {
	screenPath: string;
	webcamPath: string;
	sourceStartSec: number;
	sourceEndSec: number;
	/** temps source webcam = temps source screen − ceci. */
	webcamOffsetSec: number;
	/** `true` when this clip's screen asset has a decodable audio track the native
	 *  compositor should mix into the export. `false` skips audio decode/encode/mux
	 *  for this clip entirely (and the webcam path never carries audio by product
	 *  convention). Populated by `buildSceneDescription` and `buildNativeClipList`;
	 *  see the comment on the producer side for the exact rule. */
	hasAudio: boolean;
	/** Verified lossless microphone replacement. Missing means decode the raw embedded mic. */
	cleanMicrophonePath?: string;
}

/** Bilan d'un export natif (mesure enveloppante §10 : frames, durée, fps). */
export interface CompositorExportResult {
	frames: number;
	wallS: number;
	fps: number;
	/** Durée de la vidéo exportée (secondes) — distincte de `wallS` (temps de rendu réel). */
	videoDurationS: number;
	audioMastering: CompositorAudioMasteringResult;
	/** Actual native paths selected after probing this machine. */
	encoderName: string;
	encoderHardware: boolean;
	encoderFallback: boolean;
	decoderPath: string;
	compositorBackend: string;
	exportWarning?: CompositorExportWarning;
}

interface CompositorExportWarning {
	phase: "publishing";
	code: "DURABILITY_UNCONFIRMED";
	message: string;
	retryable: false;
}

export interface CompositorAudioMasteringResult {
	enabled: boolean;
	analyzed: boolean;
	appliedGainDb: number;
	inputLufs?: number;
	outputLufs?: number;
	inputTruePeakDbtp?: number;
	outputTruePeakDbtp?: number;
	limitedByTruePeak: boolean;
	limitedByGainCap: boolean;
	warning?: string;
}

/** Taille/cadence/codec de sortie voulus. Tout omis → 1920x1080 / fps du 1er clip / h264. */
export interface CompositorExportParams {
	/** Preserve an untouched recording's encoded video, original timestamps and
	 * cadence when safe. Explicit opt-in; FPS/bitrate apply to rendered fallback. */
	preserveRecordingSource?: boolean;
	width?: number;
	height?: number;
	fps?: number;
	/** Target video bitrate in bits/s. */
	bitrate?: number;
	/** Full-program EBU R128 normalization. Omitted defaults to enabled. */
	normalizeAudio?: boolean;
	/** Integrated loudness target for full-program normalization. */
	targetLufs?: number;
	/** Maximum pre-encode true peak in dBTP. */
	peakCeilingDbtp?: number;
	/** Match dialogue loudness between adjacent clips. Omitted defaults to enabled. */
	evenVolume?: boolean;
	/** "h264" | "h265" — pas de vp9 (aucun équivalent matériel AMF côté natif). */
	codec?: string;
}

export type ExportTransactionPhase =
	| "preflight"
	| "rendering"
	| "verification"
	| "syncing"
	| "publishing"
	| "cleanup";

export interface CompositorExportTransactionOptions {
	/** Estimated final bytes. Main uses this only for free-space protection. */
	expectedBytes?: number;
	signal?: AbortSignal;
}

/** Sortie GIF native (le seul chemin GIF de l'app).
 *  Tout omis → 854×480, 12 fps, boucle infinie, pas de dithering —
 *  défauts choisis pour un GIF 8-bit-indexed lisible : 12 fps est la
 *  cadence historique de `gif.js` côté renderer, 854×480 tient
 *  confortablement dans la palette 256-couleurs sans banding visible
 *  sur du contenu de présentation. Le dithering Floyd-Steinberg est off
 *  par défaut (qualité acceptable sans, et double تقريبًا le coût CPU
 *  du quantize par frame). */
export interface CompositorExportGifParams {
	width?: number;
	height?: number;
	fps?: number;
	/** Compteur de loop GIF : `0` ou omis = infini, sinon `n` boucles finies. */
	loopCount?: number;
	/** Floyd-Steinberg error diffusion avant quantification. `false` par défaut. */
	dither?: boolean;
}

/** Bilan d'un export GIF natif. Mêmes champs que `CompositorExportResult`
 *  plus la taille du fichier sur disque (le format est petit, la
 *  taille est une mesure d'utilité). */
export interface CompositorExportGifResult {
	frames: number;
	wallS: number;
	fps: number;
	/** Durée du GIF exporté (s) — distincte de `wallS` (temps de rendu réel). */
	videoDurationS: number;
	/** Taille du fichier `.gif` final sur disque (octets), mesurée après
	 *  le drop de l'encodeur (donc après le flush du trailer GIF89a). */
	fileBytes: number;
	exportWarning?: CompositorExportWarning;
}

// ---- AI Edition domain (Phase 1+) -----------------------------------------
// v3/v4 AxcutDocument projects live under userData/projects/<id>.klippt
// (older builds used <id>.axcut, migrated on access). Project ids are
// uuid-prefixed strings (e.g. "proj_<uuid>"). Asset ids likewise.

export interface AiEditionProjectSummary {
	id: string;
	title: string;
	updatedAt: string;
	assetCount: number;
}

export interface AiEditionAssetResult {
	assetId: string;
	document: unknown;
}

export interface AiEditionDocumentResult {
	success: boolean;
	transactionVersion?: AiEditionProjectVersion;
	undoRecovery?: AiEditionUndoRecovery;
	document?: unknown;
	error?: string;
}

export interface SourceHandoffResult {
	canceled: boolean;
	directory?: string;
	manifestPath?: string;
	timelinePath?: string;
	sourceCount?: number;
	warnings?: string[];
}

/** Persistent storage identity, distinct from a renderer's live edit generation. */
export interface AiEditionProjectVersion {
	mutationIdentity: string;
	revision: string;
	fileHash: string;
}
export interface AiEditionUndoRecovery {
	requestId: string;
	afterRevision: string;
	beforeDocument: unknown;
}
export interface AiEditionWriteGuard {
	agentHistory?: {
		restoreTo?: string;
		requestKey?: string;
		planSummary: string;
		kind: "apply" | "undo" | "redo";
		targetIds: string[];
		force: boolean;
	};
	recordUndo?: boolean;
	requestId: string;
	expected: AiEditionProjectVersion;
}
export interface AiEditionTransactionReceipt {
	requestId: string;
	payloadHash: string;
	operationId: string;
	revision: string;
	changed: boolean;
}
export interface AiEditionTransactionResult {
	undoRecovery?: AiEditionUndoRecovery;
	success: boolean;
	/** Current saved snapshot, never an assertion that this is the receipt's output. */
	document?: unknown;
	version?: AiEditionProjectVersion;
	receipt?: AiEditionTransactionReceipt | null;
	snapshotMatchesReceipt?: boolean;
	error?: string;
	errorCode?: string;
}

export type NativeBridgeErrorCode =
	| "INVALID_REQUEST"
	| "UNSUPPORTED_ACTION"
	| "NOT_FOUND"
	| "UNAVAILABLE"
	| "ENTITLEMENT_REQUIRED"
	| "EXPORT_FAILED"
	| "INTERNAL_ERROR";

export interface NativeBridgeError {
	code: NativeBridgeErrorCode;
	message: string;
	retryable: boolean;
	details?: {
		exportPhase?: ExportTransactionPhase;
		exportCode?: string;
	};
}

interface NativeBridgeMeta {
	version: typeof NATIVE_BRIDGE_VERSION;
	requestId: string;
	timestampMs: number;
}

interface NativeBridgeSuccess<TData> {
	ok: true;
	data: TData;
	meta: NativeBridgeMeta;
}

interface NativeBridgeFailure {
	ok: false;
	error: NativeBridgeError;
	meta: NativeBridgeMeta;
}

export type NativeBridgeResponse<TData = unknown> =
	| NativeBridgeSuccess<TData>
	| NativeBridgeFailure;

type EmptyPayload = Record<string, never>;

export type NativeBridgeRequest =
	| {
			domain: "system";
			action: "getPlatform";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "system";
			action: "getAssetBasePath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "system";
			action: "getCapabilities";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "getCurrentContext";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "saveProjectFile";
			payload: {
				projectData: unknown;
				suggestedName?: string;
				existingProjectPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadProjectFile";
			payload?: {
				/** Folder to pre-fill the open dialog with, usually the user's
				 * last-opened project folder from userPreferences. */
				projectFolder?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadCurrentProjectFile";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadProjectFileFromPath";
			payload: { path: string };
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "setCurrentVideoPath";
			payload: {
				path: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "getCurrentVideoPath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "clearCurrentVideoPath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getCapabilities";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getTelemetry";
			payload?: {
				videoPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getRecordingData";
			payload?: {
				videoPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.exportSources";
			payload: { document: unknown };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.listProjects";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.get";
			payload: { projectId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.create";
			payload: { title?: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.snapshot";
			payload: { projectId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.commit";
			payload: { projectId: string; document: unknown; guard: AiEditionWriteGuard };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.receipt";
			payload: { projectId: string; operationRequestId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.save";
			payload: { document: unknown };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.delete";
			payload: { projectId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.import";
			payload: { document: unknown };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.prepareAsset";
			payload: { projectId: string; path: string; label?: string; recordingImportId?: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.addAsset";
			payload: {
				projectId: string;
				path: string;
				label?: string;
				recordingImportId?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.removeAsset";
			payload: { projectId: string; assetId: string };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "audioOverlayStem";
			payload: {
				audioOverlays: import("./sceneDescription").SceneAudioOverlay[];
				durationSec: number;
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "createView";
			/** F3: optional real-recording sources (screen + webcam, two separate H264 files) +
			 *  cursor telemetry; omitted → the POC fixture. The compositor renders OFFSCREEN
			 *  at `rect.width`x`rect.height`; no HWND/native-window-handle is carried over IPC
			 *  anymore (the addon no longer parents a top-level window). `rect.x` / `rect.y`
			 *  are vestigial — kept on the wire so the existing `CompositorViewRect` shape
			 *  stays source-compatible. */
			payload: {
				rect: CompositorViewRect;
				screenPath?: string;
				webcamPath?: string;
				cursorPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "probeBackend";
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setRect";
			payload: { id: number; rect: CompositorViewRect };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "readFrame";
			/** Polled every rAF tick (target ~30fps) by the renderer's
			 *  `useNativeCompositorView` hook. `sinceGen` is the generation the hook
			 *  last painted; native returns a {@link CompositorFramePacket} only when a
			 *  newer frame exists, else `null` (view absent, no frame yet, or the hook
			 *  already holds the current generation — the idle path, no buffer copied).
			 *  The nested `data` Buffer survives IPC via Electron's structured clone. */
			payload: { id: number; sinceGen: number };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "reportPreviewTiming";
			/** Bounded numeric batches only. No DOM, media, project, or path data. */
			payload: {
				id: number;
				ipcMs: number[];
				drawMs: number[];
				browserMainThreadMs: number[];
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setParam";
			payload: { id: number; key: string; value: CompositorParamValue };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setPlaying";
			payload: { id: number; playing: boolean };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "syncTransport";
			payload: CompositorTransportCommand;
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "destroyView";
			payload: { id: number };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "exportMulti";
			payload: {
				clips: CompositorClipInput[];
				outPath?: string;
				sceneJson?: string;
				params?: CompositorExportParams;
				expectedBytes?: number;
				exportId: string;
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "presentTime";
			payload: { id: number; seconds: number };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setScene";
			payload: { id: number; sceneJson: string };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setActiveClip";
			payload: {
				id: number;
				screenPath: string;
				webcamPath: string;
				webcamOffsetSec: number;
				/** Index in the sorted SceneDescription.clips stream (disambiguates shared assets). */
				clipIndex: number;
				/** Current screen-source time within the active clip's source window. */
				sourceTimeSec: number;
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "exportGif";
			/** Même payload que `exportMulti` : GIF et MP4 sont le même rendu
			 *  (`walk_composited_timeline` côté Rust) et ne diffèrent que par
			 *  l'encodeur. La scène porte fond / layout / webcam / curseur, donc
			 *  il n'y a aucune entrée spécifique au GIF. */
			payload: {
				clips: CompositorClipInput[];
				outPath?: string;
				sceneJson?: string;
				params?: CompositorExportGifParams;
				expectedBytes?: number;
				exportId: string;
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "cancelExport";
			payload: { exportId: string };
			requestId?: string;
	  };
