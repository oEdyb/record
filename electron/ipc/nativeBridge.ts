import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import type { EntitlementCapability } from "../../src/lib/entitlements/contracts";
import type { AiEditionChatEvent } from "../../src/native/contracts";
import {
	NATIVE_BRIDGE_CHANNEL,
	NATIVE_BRIDGE_VERSION,
	type NativeBridgeErrorCode,
	type NativeBridgeRequest,
	type NativeBridgeResponse,
	type NativePlatform,
	type ProjectFileResult,
	type ProjectPathResult,
} from "../../src/native/contracts";
import type { ChatEventSink } from "../ai-edition/chat-service";
import type { DocumentService } from "../ai-edition/document-service";
import type { WorkloadMediaPath, WorkloadTelemetryService } from "../diagnostics/workloadTelemetry";
import { EntitlementRequiredError } from "../entitlements/service";
import { ExportTransactionError } from "../export/atomicExport";
import { exportSourceHandoff } from "../export/sourceHandoff";
import {
	type CursorTelemetryLoadResult,
	TelemetryCursorAdapter,
} from "../native-bridge/cursor/telemetryCursorAdapter";
import { AiEditionService } from "../native-bridge/services/aiEditionService";
import { AudioOverlayStemService } from "../native-bridge/services/audioOverlayStemService";
import { CompositorViewService } from "../native-bridge/services/compositorViewService";
import { CursorService } from "../native-bridge/services/cursorService";
import { ProjectService } from "../native-bridge/services/projectService";
import { SystemService } from "../native-bridge/services/systemService";
import { createNativeBridgeState } from "../native-bridge/store";
import type { RendererIpcMain } from "./trustedRendererIpc";

export interface NativeBridgeContext {
	resolveApprovedRendererMediaPath?: (sourcePath: string) => string | null;
	approveReadableRendererMediaPath?: (outputPath: string) => Promise<string | null>;
	workloadTelemetry?: WorkloadTelemetryService;
	assertEntitlement: (capability: EntitlementCapability) => Promise<void>;
	getPlatform: () => NodeJS.Platform;
	getCurrentProjectPath: () => string | null;
	getCurrentVideoPath: () => string | null;
	saveProjectFile: (
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	) => Promise<ProjectFileResult>;
	loadProjectFile: (projectFolder?: string) => Promise<ProjectFileResult>;
	loadCurrentProjectFile: () => Promise<ProjectFileResult>;
	loadProjectFileFromPath: (path: string) => Promise<ProjectFileResult>;
	setCurrentVideoPath: (path: string) => ProjectPathResult | Promise<ProjectPathResult>;
	getCurrentVideoPathResult: () => ProjectPathResult;
	clearCurrentVideoPath: () => ProjectPathResult;
	resolveAssetBasePath: () => string | null;
	resolveVideoPath: (videoPath?: string | null) => string | null;
	loadCursorRecordingData: (
		videoPath: string,
	) => Promise<import("../../src/native/contracts").CursorRecordingData>;
	loadCursorTelemetry: (videoPath: string) => Promise<CursorTelemetryLoadResult>;
	/**
	 * returns the native (HWND / NSView / xcb_window) handle buffer
	 * for the BrowserWindow that hosts the requesting renderer. Used by the
	 * compositor domain's `createView` to wire the embedded native window
	 * to its D3D11 parent. May return `null` if the sender has no live window
	 * (e.g. mid-teardown), in which case `createView` fails with UNAVAILABLE.
	 */
	getNativeWindowHandle?: (sender: import("electron").WebContents) => Buffer | null;
	getAiEditionDocuments: () => DocumentService;
	getAiEditionLlmConfig: () => import("../ai-edition/llm-config-store").LlmConfigStore;
	runAiEditionChat: (
		projectId: string,
		sessionId: string,
		message: string,
		document?: unknown,
		sink?: ChatEventSink,
	) => Promise<import("../../src/native/contracts").AiEditionChatResult>;
	undoAiEditionToolBatch: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatResult;
	rewindToMessage: (
		projectId: string,
		sessionId: string,
		messageId: string,
	) =>
		| {
				success: true;
				prompt: string;
				document: unknown;
				messages: import("../../src/native/contracts").AiEditionChatMessage[];
		  }
		| { success: false; error: string };
	compactNow: (
		projectId: string,
		sessionId: string,
	) => Promise<import("../../src/native/contracts").AiEditionChatCompactResult | null>;
	getContextUsage: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatBudget | null;
	listAiEditionChatSessions: (
		projectId: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary[];
	createAiEditionChatSession: (
		projectId: string,
		title?: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary;
	selectAiEditionChatSession: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatSession | null;
	renameAiEditionChatSession: (
		projectId: string,
		sessionId: string,
		title: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary | null;
	deleteAiEditionChatSession: (projectId: string, sessionId: string) => boolean;
}

function normalizePlatform(platform: NodeJS.Platform): NativePlatform {
	if (platform === "darwin" || platform === "win32") {
		return platform;
	}

	return "linux";
}

function createMeta(requestId?: string) {
	return {
		version: NATIVE_BRIDGE_VERSION,
		requestId: requestId || `native-${Date.now()}`,
		timestampMs: Date.now(),
	} as const;
}

function createSuccessResponse<TData>(requestId: string | undefined, data: TData) {
	return {
		ok: true,
		data,
		meta: createMeta(requestId),
	} satisfies NativeBridgeResponse<TData>;
}

function createErrorResponse(
	requestId: string | undefined,
	code: NativeBridgeErrorCode,
	message: string,
	retryable = false,
	details?: import("../../src/native/contracts").NativeBridgeError["details"],
) {
	return {
		ok: false,
		error: {
			code,
			message,
			retryable,
			details,
		},
		meta: createMeta(requestId),
	} satisfies NativeBridgeResponse;
}

/**
 * Strips absolute filesystem paths out of an error message before it crosses to
 * the renderer. Main-process errors quote the path they failed on (`ENOENT: no
 * such file or directory, open 'C:\Users\alice\…'`), and that string is rendered
 * verbatim in toasts and the chat error rail. Keeps the basename, which is the
 * part a user can act on. The full message still goes to the main-process log.
 */
function redactPaths(message: string): string {
	return message
		.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]*)/g, "…\\$1")
		.replace(/\/(?:[^/\0\s'"]+\/)+([^/\0\s'"]*)/g, "…/$1");
}

function isBridgeRequest(value: unknown): value is NativeBridgeRequest {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<NativeBridgeRequest>;
	return typeof candidate.domain === "string" && typeof candidate.action === "string";
}

function nativeEncoderPath(name: string, hardware: boolean): WorkloadMediaPath {
	if (name.endsWith("_videotoolbox")) {
		return hardware ? "videotoolbox-hardware" : "videotoolbox-software";
	}
	if (name === "libopenh264") return "libopenh264-software";
	if (name === "libkvazaar") return "libkvazaar-software";
	if (name.endsWith("_amf")) return "amf-hardware";
	if (name.endsWith("_nvenc")) return "nvenc-hardware";
	if (name.endsWith("_qsv")) return "qsv-hardware";
	if (name.endsWith("_mf")) {
		return hardware ? "media-foundation-hardware" : "media-foundation-software";
	}
	return hardware ? "ffmpeg-hardware" : "ffmpeg-software";
}

function nativeDecoderPath(name: string): WorkloadMediaPath {
	if (name === "videotoolbox") return "videotoolbox-decoder";
	if (name === "d3d11va") return "d3d11va-decoder";
	if (name === "software") return "software-decoder";
	if (name === "mixed") return "mixed-decoder";
	return "unknown";
}

function nativeCompositorPath(name: string): WorkloadMediaPath {
	if (name === "metal") return "metal";
	if (name === "d3d11") return "d3d11";
	if (name === "vulkan") return "vulkan";
	if (name === "software") return "software";
	return "unknown";
}

function addNativeExportPaths(
	telemetry: WorkloadTelemetryService,
	workloadId: string,
	stats: {
		encoderName: string;
		encoderHardware: boolean;
		encoderFallback: boolean;
		decoderPath: string;
		compositorBackend: string;
	},
): void {
	telemetry.addMediaPath(workloadId, nativeEncoderPath(stats.encoderName, stats.encoderHardware));
	telemetry.addMediaPath(workloadId, nativeDecoderPath(stats.decoderPath));
	telemetry.addMediaPath(workloadId, nativeCompositorPath(stats.compositorBackend));
	if (stats.encoderFallback) {
		telemetry.addFallback(workloadId, "encoder-hardware-to-software");
	}
}

// build a ChatEventSink that broadcasts each event to the renderer
// that requested the chat run. The webContents may be gone by the time a late
// delta fires (tab closed, window destroyed) — webContents.send throws, so we
// swallow the error to keep the loop running. The renderer treats a missing
// "end of stream" as "the run was abandoned" and shows an inline error.
function buildChatEventSink(sender: Electron.WebContents, sessionId: string): ChatEventSink {
	const send = (payload: AiEditionChatEvent) => {
		try {
			sender.send("ai-edition.chat-event", payload);
		} catch {
			// webContents gone — keep the loop running silently.
		}
	};
	return {
		text: (delta) => send({ kind: "text", sessionId, delta }),
		thinking: (delta) => send({ kind: "thinking", sessionId, delta }),
		toolStart: (name, args) => send({ kind: "toolStart", sessionId, name, args }),
		toolEnd: (name, ok, summary) => send({ kind: "toolEnd", sessionId, name, ok, summary }),
		error: (message) => send({ kind: "error", sessionId, message }),
	};
}

export function registerNativeBridgeHandlers(
	context: NativeBridgeContext,
	ipcMain: RendererIpcMain,
) {
	ipcMain.removeHandler(NATIVE_BRIDGE_CHANNEL);

	const platform = normalizePlatform(context.getPlatform());
	const store = createNativeBridgeState(platform);
	const projectService = new ProjectService({
		store,
		getCurrentProjectPath: context.getCurrentProjectPath,
		getCurrentVideoPath: context.getCurrentVideoPath,
		saveProjectFile: context.saveProjectFile,
		loadProjectFile: context.loadProjectFile,
		loadCurrentProjectFile: context.loadCurrentProjectFile,
		loadProjectFileFromPath: context.loadProjectFileFromPath,
		setCurrentVideoPath: context.setCurrentVideoPath,
		getCurrentVideoPathResult: context.getCurrentVideoPathResult,
		clearCurrentVideoPath: context.clearCurrentVideoPath,
	});
	const cursorService = new CursorService({
		store,
		adapter: new TelemetryCursorAdapter({
			loadRecordingData: context.loadCursorRecordingData,
			resolveVideoPath: context.resolveVideoPath,
			loadTelemetry: context.loadCursorTelemetry,
		}),
	});
	const systemService = new SystemService({
		store,
		getPlatform: () => platform,
		getAssetBasePath: context.resolveAssetBasePath,
		getCursorCapabilities: () => cursorService.getCapabilities(),
	});
	const compositorViewService = new CompositorViewService();
	const audioOverlayStems = new AudioOverlayStemService({
		cacheDirectory: path.join(app.getPath("userData"), "derived-media", "audio-overlays-v1"),
		resolveSourcePath: (sourcePath) =>
			context.resolveApprovedRendererMediaPath?.(sourcePath) ?? null,
		approveOutputPath: async (outputPath) =>
			context.approveReadableRendererMediaPath?.(outputPath) ?? null,
		renderStem: (requestJson, outputPath, jobId) =>
			compositorViewService.renderAudioOverlayStem(requestJson, outputPath, jobId),
	});
	void compositorViewService.initializeExportRecovery().catch((error) => {
		console.warn("[export] startup recovery failed:", error);
	});
	const previewWorkloads = new Map<number, { workloadId: string; senderId: number }>();
	const previewSamples = (value: unknown): number[] =>
		Array.isArray(value)
			? value
					.slice(0, 300)
					.filter(
						(sample): sample is number =>
							typeof sample === "number" &&
							Number.isFinite(sample) &&
							sample >= 0 &&
							sample <= 60_000,
					)
			: [];
	const aiEditionService = new AiEditionService({
		documents: context.getAiEditionDocuments(),
		resolveMediaPath: async (path) =>
			(await import("./handlers")).resolveApprovedRendererMediaPath(path),
		// Passed uncalled on purpose — invoking it here would build the store (and
		// hit the macOS Keychain) while wiring the bridge at startup.
		llmConfig: context.getAiEditionLlmConfig,
		runChat: context.runAiEditionChat,
		undoLastToolBatch: context.undoAiEditionToolBatch,
		rewindToMessage: context.rewindToMessage,
		compactNow: context.compactNow,
		getContextUsage: context.getContextUsage,
		listSessions: context.listAiEditionChatSessions,
		createSession: context.createAiEditionChatSession,
		selectSession: context.selectAiEditionChatSession,
		renameSession: context.renameAiEditionChatSession,
		deleteSession: context.deleteAiEditionChatSession,
	});

	ipcMain.handle(NATIVE_BRIDGE_CHANNEL, async (event, request: unknown) => {
		if (!isBridgeRequest(request)) {
			return createErrorResponse(undefined, "INVALID_REQUEST", "Invalid native bridge request.");
		}

		const requestId = request.requestId;
		const domain = request.domain as string;

		try {
			switch (request.domain) {
				case "system": {
					const action = request.action as string;
					switch (request.action) {
						case "getPlatform":
							return createSuccessResponse(requestId, systemService.getPlatform());
						case "getAssetBasePath":
							return createSuccessResponse(requestId, systemService.getAssetBasePath());
						case "getCapabilities":
							return createSuccessResponse(requestId, await systemService.getCapabilities());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported system action: ${action}`,
							);
					}
				}

				case "project": {
					const action = request.action as string;
					switch (request.action) {
						case "getCurrentContext":
							return createSuccessResponse(requestId, projectService.getCurrentContext());
						case "saveProjectFile":
							await context.assertEntitlement("edit");
							return createSuccessResponse(
								requestId,
								await projectService.saveProjectFile(
									request.payload.projectData,
									request.payload.suggestedName,
									request.payload.existingProjectPath,
								),
							);
						case "loadProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.loadProjectFile(request.payload?.projectFolder),
							);
						case "loadCurrentProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.loadCurrentProjectFile(),
							);
						case "loadProjectFileFromPath":
							return createSuccessResponse(
								requestId,
								await projectService.loadProjectFileFromPath(request.payload.path),
							);
						case "setCurrentVideoPath":
							return createSuccessResponse(
								requestId,
								await projectService.setCurrentVideoPath(request.payload.path),
							);
						case "getCurrentVideoPath":
							return createSuccessResponse(requestId, projectService.getCurrentVideoPath());
						case "clearCurrentVideoPath":
							return createSuccessResponse(requestId, projectService.clearCurrentVideoPath());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported project action: ${action}`,
							);
					}
				}

				case "cursor": {
					const action = request.action as string;
					switch (request.action) {
						case "getCapabilities":
							return createSuccessResponse(requestId, await cursorService.getCapabilities());
						case "getTelemetry":
							return createSuccessResponse(
								requestId,
								await cursorService.getTelemetry(request.payload?.videoPath),
							);
						case "getRecordingData":
							return createSuccessResponse(
								requestId,
								await cursorService.getRecordingData(request.payload?.videoPath),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported cursor action: ${action}`,
							);
					}
				}

				case "compositor": {
					const action = request.action as string;
					switch (request.action) {
						case "createView": {
							const id = compositorViewService.createView(request.payload.rect, {
								screenPath: request.payload.screenPath,
								webcamPath: request.payload.webcamPath,
								cursorPath: request.payload.cursorPath,
							});
							if (context.workloadTelemetry) {
								const workloadId = context.workloadTelemetry.begin({
									kind: "preview",
									operation: "native-preview",
									platform: context.getPlatform(),
									configuration: {
										previewWidthPx: request.payload.rect.width,
										previewHeightPx: request.payload.rect.height,
									},
								});
								previewWorkloads.set(id, { workloadId, senderId: event.sender.id });
								context.workloadTelemetry.startPhase(workloadId, "preview-active");
								context.workloadTelemetry.event(workloadId, "preview-started");
								const backend = compositorViewService.probeBackend();
								context.workloadTelemetry.addMediaPath(
									workloadId,
									backend === "cpu"
										? "software"
										: backend === "none"
											? "unknown"
											: context.getPlatform() === "darwin"
												? "metal"
												: context.getPlatform() === "win32"
													? "d3d11"
													: "vulkan",
								);
							}
							return createSuccessResponse(requestId, { id });
						}
						case "probeBackend":
							// No view needed: the export dialog asks before any preview exists.
							return createSuccessResponse(requestId, {
								backend: compositorViewService.probeBackend(),
							});
						case "setRect":
							compositorViewService.setRect(request.payload.id, request.payload.rect);
							return createSuccessResponse(requestId, { ok: true });
						case "readFrame": {
							// The renderer polls this every rAF tick (~30fps). It passes the
							// generation it last painted as `sinceGen`; native returns `null` when
							// nothing newer exists (idle path — no buffer copy). On a new frame it
							// returns `{ gen, width, height, data }`. The response wrapper does NOT
							// JSON-stringify — `ipcMain.handle` round-trips via structured clone,
							// which preserves the nested `Buffer` in `.data` as binary.
							const preview = previewWorkloads.get(request.payload.id);
							const startedAt = performance.now();
							try {
								const frame = compositorViewService.readFrame(
									request.payload.id,
									request.payload.sinceGen,
								);
								if (frame && preview?.senderId === event.sender.id && context.workloadTelemetry) {
									context.workloadTelemetry.observe(
										preview.workloadId,
										"preview.native_boundary_ms",
										performance.now() - startedAt,
									);
									context.workloadTelemetry.observe(
										preview.workloadId,
										"preview.gpu_readback_ms",
										frame.readbackMs,
									);
								}
								return createSuccessResponse(requestId, frame);
							} catch (error) {
								if (preview?.senderId === event.sender.id && context.workloadTelemetry) {
									context.workloadTelemetry.finish(preview.workloadId, "failed", "preview-failed");
									previewWorkloads.delete(request.payload.id);
								}
								throw error;
							}
						}
						case "reportPreviewTiming": {
							const preview = previewWorkloads.get(request.payload.id);
							if (preview?.senderId !== event.sender.id || !context.workloadTelemetry) {
								return createSuccessResponse(requestId, { ok: true });
							}
							for (const sample of previewSamples(request.payload.ipcMs)) {
								context.workloadTelemetry.observe(preview.workloadId, "preview.ipc_ms", sample);
							}
							for (const sample of previewSamples(request.payload.drawMs)) {
								context.workloadTelemetry.observe(preview.workloadId, "preview.draw_ms", sample);
							}
							for (const sample of previewSamples(request.payload.browserMainThreadMs)) {
								context.workloadTelemetry.observe(
									preview.workloadId,
									"preview.browser_main_thread_ms",
									sample,
								);
							}
							return createSuccessResponse(requestId, { ok: true });
						}
						case "setParam":
							compositorViewService.setParam(
								request.payload.id,
								request.payload.key,
								request.payload.value,
							);
							return createSuccessResponse(requestId, { ok: true });
						case "setPlaying":
							compositorViewService.setPlaying(request.payload.id, request.payload.playing);
							return createSuccessResponse(requestId, { ok: true });
						case "syncTransport":
							compositorViewService.syncTransport(
								request.payload.id,
								request.payload.generation,
								request.payload.playing,
								request.payload.screenPath,
								request.payload.webcamPath,
								request.payload.webcamOffsetSec,
								request.payload.clipIndex,
								request.payload.sourceTimeSec,
							);
							return createSuccessResponse(requestId, { ok: true });
						case "presentTime":
							compositorViewService.presentTime(request.payload.id, request.payload.seconds);
							return createSuccessResponse(requestId, { ok: true });
						case "setScene":
							compositorViewService.setScene(request.payload.id, request.payload.sceneJson);
							return createSuccessResponse(requestId, { ok: true });
						case "setActiveClip":
							compositorViewService.setActiveClip(
								request.payload.id,
								request.payload.screenPath,
								request.payload.webcamPath,
								request.payload.webcamOffsetSec,
								request.payload.clipIndex,
								request.payload.sourceTimeSec,
							);
							return createSuccessResponse(requestId, { ok: true });
						case "destroyView": {
							const preview = previewWorkloads.get(request.payload.id);
							try {
								compositorViewService.destroyView(request.payload.id);
								if (preview?.senderId === event.sender.id && context.workloadTelemetry) {
									context.workloadTelemetry.event(preview.workloadId, "preview-completed");
									context.workloadTelemetry.finish(preview.workloadId, "succeeded");
								}
								return createSuccessResponse(requestId, { ok: true });
							} catch (error) {
								if (preview?.senderId === event.sender.id && context.workloadTelemetry) {
									context.workloadTelemetry.finish(preview.workloadId, "failed", "preview-failed");
								}
								throw error;
							} finally {
								if (preview?.senderId === event.sender.id) {
									previewWorkloads.delete(request.payload.id);
								}
							}
						}
						case "cancelExport":
							return createSuccessResponse(requestId, {
								cancelled: compositorViewService.cancelExport(request.payload.exportId),
							});
						case "audioOverlayStem":
							return createSuccessResponse(requestId, await audioOverlayStems.get(request.payload));
						case "exportMulti": {
							await context.assertEntitlement("export");
							audioOverlayStems.validateSceneSources(request.payload.sceneJson);
							const sender = event.sender;
							const telemetryId = context.workloadTelemetry?.begin({
								kind: "export",
								operation: "native-video-export",
								platform: context.getPlatform(),
								configuration: {
									format: "mp4",
									outputFps: request.payload.params?.fps,
									outputWidthPx: request.payload.params?.width,
									outputHeightPx: request.payload.params?.height,
								},
								diskDirectory: request.payload.outPath
									? path.dirname(request.payload.outPath)
									: undefined,
							});
							if (telemetryId) {
								context.workloadTelemetry?.startPhase(telemetryId, "export-compose");
								context.workloadTelemetry?.event(telemetryId, "export-started");
							}
							let stats: Awaited<ReturnType<typeof compositorViewService.exportMulti>>;
							try {
								stats = await compositorViewService.exportMulti(
									request.payload.clips,
									request.payload.outPath,
									request.payload.sceneJson,
									request.payload.params,
									(frames) => {
										if (!sender.isDestroyed()) {
											sender.send("export:native-progress", frames);
										}
									},
									{
										expectedBytes: request.payload.expectedBytes,
										exportId: request.payload.exportId,
										onPhase: (phase) => {
											if (!sender.isDestroyed()) sender.send("export:native-phase", phase);
										},
									},
								);
							} catch (error) {
								if (telemetryId) {
									context.workloadTelemetry?.finish(telemetryId, "failed", "export-failed");
								}
								throw error;
							}
							if (!stats) {
								if (telemetryId) {
									context.workloadTelemetry?.finish(telemetryId, "failed", "export-failed");
								}
								return createErrorResponse(
									requestId,
									"UNAVAILABLE",
									"Native compositor addon not present.",
								);
							}
							if (telemetryId) {
								context.workloadTelemetry?.endPhase(telemetryId, "export-compose");
								context.workloadTelemetry?.observe(telemetryId, "export.frames", stats.frames);
								context.workloadTelemetry?.observe(
									telemetryId,
									"export.media_duration_s",
									stats.videoDurationS,
								);
								context.workloadTelemetry?.observe(telemetryId, "export.throughput_fps", stats.fps);
								if (request.payload.outPath) {
									const output = await fs.stat(request.payload.outPath).catch(() => null);
									if (output) {
										context.workloadTelemetry?.observe(
											telemetryId,
											"export.output_bytes",
											output.size,
										);
									}
								}
								if (context.workloadTelemetry) {
									addNativeExportPaths(context.workloadTelemetry, telemetryId, stats);
								}
								context.workloadTelemetry?.event(telemetryId, "export-completed");
								context.workloadTelemetry?.finish(telemetryId, "succeeded");
							}
							return createSuccessResponse(requestId, stats);
						}
						case "exportGif": {
							await context.assertEntitlement("export");
							const sender = event.sender;
							const telemetryId = context.workloadTelemetry?.begin({
								kind: "export",
								operation: "native-gif-export",
								platform: context.getPlatform(),
								configuration: {
									format: "gif",
									outputFps: request.payload.params?.fps,
									outputWidthPx: request.payload.params?.width,
									outputHeightPx: request.payload.params?.height,
								},
								diskDirectory: request.payload.outPath
									? path.dirname(request.payload.outPath)
									: undefined,
							});
							if (telemetryId) {
								context.workloadTelemetry?.startPhase(telemetryId, "export-compose");
								context.workloadTelemetry?.event(telemetryId, "export-started");
							}
							let stats: Awaited<ReturnType<typeof compositorViewService.exportGif>>;
							try {
								stats = await compositorViewService.exportGif(
									request.payload.clips,
									request.payload.outPath,
									request.payload.sceneJson,
									request.payload.params,
									(frames) => {
										if (!sender.isDestroyed()) {
											sender.send("export:native-progress", frames);
										}
									},
									{
										expectedBytes: request.payload.expectedBytes,
										exportId: request.payload.exportId,
										onPhase: (phase) => {
											if (!sender.isDestroyed()) sender.send("export:native-phase", phase);
										},
									},
								);
							} catch (error) {
								if (telemetryId) {
									context.workloadTelemetry?.finish(telemetryId, "failed", "export-failed");
								}
								throw error;
							}
							if (!stats) {
								if (telemetryId) {
									context.workloadTelemetry?.finish(telemetryId, "failed", "export-failed");
								}
								return createErrorResponse(
									requestId,
									"UNAVAILABLE",
									"Native compositor addon not present.",
								);
							}
							if (telemetryId) {
								context.workloadTelemetry?.endPhase(telemetryId, "export-compose");
								context.workloadTelemetry?.observe(telemetryId, "export.frames", stats.frames);
								context.workloadTelemetry?.observe(
									telemetryId,
									"export.media_duration_s",
									stats.videoDurationS,
								);
								context.workloadTelemetry?.observe(telemetryId, "export.throughput_fps", stats.fps);
								context.workloadTelemetry?.observe(
									telemetryId,
									"export.output_bytes",
									stats.fileBytes,
								);
								context.workloadTelemetry?.addMediaPath(telemetryId, "software");
								context.workloadTelemetry?.event(telemetryId, "export-completed");
								context.workloadTelemetry?.finish(telemetryId, "succeeded");
							}
							return createSuccessResponse(requestId, stats);
						}
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported compositor action: ${action}`,
							);
					}
				}

				case "aiEdition": {
					const action = request.action as string;
					switch (request.action) {
						case "document.listProjects":
							return createSuccessResponse(requestId, await aiEditionService.listProjects());
						case "document.exportSources": {
							const document = documentSchema.parse(request.payload?.document);
							const { dialog, BrowserWindow } = await import("electron");
							const options: Electron.OpenDialogOptions = {
								title: "Export source files",
								properties: ["openDirectory", "createDirectory"],
							};
							const parent = BrowserWindow.fromWebContents(event.sender);
							const selected = parent
								? await dialog.showOpenDialog(parent, options)
								: await dialog.showOpenDialog(options);
							if (selected.canceled || !selected.filePaths[0])
								return createSuccessResponse(requestId, { canceled: true });
							return createSuccessResponse(
								requestId,
								await exportSourceHandoff(
									document,
									selected.filePaths[0],
									(source) => context.resolveApprovedRendererMediaPath?.(source) ?? null,
								),
							);
						}
						case "document.get":
							return createSuccessResponse(
								requestId,
								await aiEditionService.get(request.payload.projectId),
							);
						case "document.create":
							await context.assertEntitlement("edit");
							return createSuccessResponse(
								requestId,
								await aiEditionService.create(request.payload?.title),
							);
						case "document.snapshot":
							return createSuccessResponse(
								requestId,
								await aiEditionService.snapshot(request.payload.projectId),
							);
						case "document.receipt":
							return createSuccessResponse(
								requestId,
								await aiEditionService.receipt(
									request.payload.projectId,
									request.payload.operationRequestId,
								),
							);
						case "document.commit":
							await context.assertEntitlement("edit");
							return createSuccessResponse(
								requestId,
								await aiEditionService.commit(
									request.payload.projectId,
									request.payload.document,
									request.payload.guard,
								),
							);
						case "document.save":
							await context.assertEntitlement("edit");
							return createSuccessResponse(
								requestId,
								await aiEditionService.save(request.payload.document),
							);
						case "document.delete":
							await context.assertEntitlement("edit");
							return createSuccessResponse(
								requestId,
								await aiEditionService.deleteProject(request.payload.projectId),
							);
						case "document.import":
							await context.assertEntitlement("import");
							return createSuccessResponse(
								requestId,
								await aiEditionService.importProject(request.payload.document),
							);
						case "document.pickAudioAsset": {
							await context.assertEntitlement("import");
							const { dialog, BrowserWindow } = await import("electron");
							const options: Electron.OpenDialogOptions = {
								title: "Add audio",
								properties: ["openFile"],
								filters: [
									{ name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"] },
								],
							};
							const parent = BrowserWindow.fromWebContents(event.sender);
							const selected = parent
								? await dialog.showOpenDialog(parent, options)
								: await dialog.showOpenDialog(options);
							if (selected.canceled || !selected.filePaths[0])
								return createSuccessResponse(requestId, { canceled: true });
							const { approveReadableRendererMediaPath } = await import("./handlers");
							const approved = await approveReadableRendererMediaPath(selected.filePaths[0]);
							if (!approved) throw new Error("Selected audio file is not readable");
							return createSuccessResponse(
								requestId,
								await aiEditionService.prepareAudioAsset(request.payload.projectId, approved),
							);
						}

						case "document.prepareAsset":
							await context.assertEntitlement("import");
							return createSuccessResponse(
								requestId,
								await aiEditionService.prepareAsset(
									request.payload.projectId,
									request.payload.path,
									request.payload.label,
									request.payload.recordingImportId,
								),
							);

						case "document.addAsset":
							await context.assertEntitlement("import");
							return createSuccessResponse(
								requestId,
								await aiEditionService.addAsset(
									request.payload.projectId,
									request.payload.path,
									request.payload.label,
									request.payload.recordingImportId,
								),
							);
						case "document.removeAsset":
							await context.assertEntitlement("edit");
							return createSuccessResponse(
								requestId,
								await aiEditionService.removeAsset(
									request.payload.projectId,
									request.payload.assetId,
								),
							);
						case "llm.getSnapshot":
							return createSuccessResponse(requestId, await aiEditionService.llmGetSnapshot());
						case "llm.setConfig":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmSetConfig(request.payload.config),
							);
						case "llm.setApiKey":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmSetApiKey(
									request.payload.providerId,
									request.payload.apiKey,
								),
							);
						case "llm.removeApiKey":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmRemoveApiKey(request.payload.providerId),
							);
						case "llm.disconnect":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmDisconnect(request.payload.providerId),
							);
						case "llm.listProviderModels":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmListProviderModels(request.payload.providerId),
							);
						case "chat.run": {
							await context.assertEntitlement("automatic-editing");
							const sessionId = request.payload.sessionId;
							const sink = buildChatEventSink(event.sender, sessionId);
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatRun(
									request.payload.projectId,
									sessionId,
									request.payload.message,
									request.payload.document,
									sink,
								),
							);
						}
						case "chat.undoLastBatch":
							await context.assertEntitlement("edit");
							return createSuccessResponse(
								requestId,
								aiEditionService.chatUndoLastBatch(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.listSessions":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatListSessions(request.payload.projectId),
							);
						case "chat.createSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatCreateSession(
									request.payload.projectId,
									request.payload.title,
								),
							);
						case "chat.selectSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatSelectSession(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.renameSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatRenameSession(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.title,
								),
							);
						case "chat.deleteSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatDeleteSession(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.budget":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatBudget(request.payload.projectId, request.payload.sessionId),
							);
						case "chat.compact":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatCompact(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.rewind":
							await context.assertEntitlement("edit");
							return createSuccessResponse(
								requestId,
								aiEditionService.chatRewindToMessage(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.messageId,
								),
							);
						case "chat.contextUsage":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatContextUsage(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.compactNow":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatCompactNow(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "captions.translate":
							await context.assertEntitlement("automatic-editing");
							return createSuccessResponse(
								requestId,
								await aiEditionService.captionsTranslate({
									segments: request.payload.segments,
									targetLanguage: request.payload.targetLanguage,
									sourceLanguage: request.payload.sourceLanguage,
								}),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported aiEdition action: ${action}`,
							);
					}
				}

				default:
					return createErrorResponse(
						requestId,
						"UNSUPPORTED_ACTION",
						`Unsupported bridge domain: ${domain}`,
					);
			}
		} catch (error) {
			// Not retryable by default: most failures here are permanent (a missing
			// file, a bad payload, an unavailable addon), and a blanket `true` tells
			// the client to spin on them. The message keeps the reason but drops any
			// absolute path — it crosses to the renderer and ends up in UI strings.
			console.error(`native bridge ${domain}.${request.action} failed:`, error);
			if (error instanceof ExportTransactionError) {
				return createErrorResponse(
					requestId,
					"EXPORT_FAILED",
					redactPaths(error.message),
					error.retryable,
					{ exportPhase: error.phase, exportCode: error.code },
				);
			}
			return createErrorResponse(
				requestId,
				error instanceof EntitlementRequiredError ? "ENTITLEMENT_REQUIRED" : "INTERNAL_ERROR",
				redactPaths(error instanceof Error ? error.message : "Unknown native bridge error."),
			);
		}
	});
}
