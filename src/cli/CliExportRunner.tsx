// Hidden-window runner for `klippt export`. Loads a Klippt or legacy project,
// migrates it to the AxcutDocument the native Rust compositor consumes, and
// drives exportMultiNative/exportGifNative — mirroring the v4 ExportDialog so
// CLI exports and GUI exports stay pixel-identical. The hidden window does no
// compositing itself: the render runs in the main process; this runner only
// builds the clip list + scene JSON and relays progress.

import { useEffect, useRef, useState } from "react";
import {
	DEFAULT_EXPORT_SETTINGS,
	DEFAULT_GIF_SETTINGS,
} from "@/components/video-editor/editorDefaults";
import {
	normalizeProjectEditor,
	resolveProjectMedia,
	toFileUrl,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import {
	collectEffectiveClipDims,
	type Dims,
	pickExtremeDims,
	resolveOutputAspectRatioValue,
} from "@/lib/ai-edition/document/outputFormat";
import { applyProbedDuration } from "@/lib/ai-edition/document/timeline";
import {
	type AxcutDocument,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { type CleanVoiceRuntimeSnapshot, cleanVoiceRoutes } from "@/lib/cleanVoiceRuntime";
import type { CliDoneResult, CliExportRequest } from "@/lib/cliContracts";
import { GIF_SIZE_PRESETS, type GifSizePreset } from "@/lib/exporter";
import {
	calculateEffectiveExportDuration,
	calculateMp4ExportSettings,
	calculateMp4ExportSettingsForResolution,
	estimateGifFileSizeBytes,
	estimateMp4FileSizeBytes,
} from "@/lib/exporter/mp4ExportSettings";
import { mixVoiceoverIntoVideo } from "@/lib/exporter/voiceoverMix";
import {
	exportGifNative,
	exportMultiNative,
	NativeBridgeClientError,
	nativeBridgeClient,
} from "@/native";
import type { ExportTransactionPhase } from "@/native/contracts";
import {
	buildCompositorClipInputs,
	buildSceneDescription,
	resolveVisibleClips,
} from "@/native/sceneDescription";

const MP4_EXPORT_FPS = 60;

class CliExportTransactionError extends Error {
	constructor(
		message: string,
		readonly exportPhase: ExportTransactionPhase,
		readonly exportCode: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "CliExportTransactionError";
	}
}

function throwIfCancelled(signal: AbortSignal | undefined, phase: ExportTransactionPhase): void {
	if (signal?.aborted) {
		throw new CliExportTransactionError("Export cancelled.", phase, "CANCELLED");
	}
}

function cliExportFailure(error: unknown): CliDoneResult {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof CliExportTransactionError) {
		return {
			success: false,
			error: message,
			exportPhase: error.exportPhase,
			exportCode: error.exportCode,
			retryable: error.retryable,
		};
	}
	if (error instanceof NativeBridgeClientError) {
		return {
			success: false,
			error: message,
			...(error.details?.exportPhase ? { exportPhase: error.details.exportPhase } : {}),
			...(error.details?.exportCode ? { exportCode: error.details.exportCode } : {}),
			retryable: error.retryable,
		};
	}
	if (error instanceof DOMException && error.name === "AbortError") {
		return {
			success: false,
			error: "Export cancelled.",
			exportPhase: "preflight",
			exportCode: "CANCELLED",
			retryable: false,
		};
	}
	return { success: false, error: message };
}

function probeVideoDimensions(
	url: string,
): Promise<{ width: number; height: number; durationMs: number }> {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		const cleanup = () => {
			clearTimeout(timer);
			video.removeAttribute("src");
			video.load();
		};
		// A stalled load fires neither event; without a deadline the CLI hangs.
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out reading video metadata: ${url}`));
		}, 30_000);
		video.onloadedmetadata = () => {
			const width = video.videoWidth;
			const height = video.videoHeight;
			const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
			cleanup();
			resolve({ width, height, durationMs });
		};
		video.onerror = () => {
			cleanup();
			reject(new Error(`Failed to load video metadata: ${url}`));
		};
		video.src = url;
	});
}

function replaceExtension(filePath: string, newExtension: string): string {
	return filePath.replace(/\.(klippt|openscreen|axcut|json)$/i, "") + newExtension;
}

/** Mirrors ExportDialog.gifOutputDims: cap height at the preset, keep even. */
function gifOutputDims(
	preset: GifSizePreset,
	tierDims: { width: number; height: number },
): { width: number; height: number } {
	const maxHeight = GIF_SIZE_PRESETS[preset].maxHeight;
	if (!Number.isFinite(maxHeight) || tierDims.height <= maxHeight) {
		return { width: tierDims.width, height: tierDims.height };
	}
	const scale = maxHeight / tierDims.height;
	const even = (n: number) => Math.max(2, Math.round(n * scale) & ~1);
	return { width: even(tierDims.width), height: even(tierDims.height) };
}

export async function runExport(
	request: CliExportRequest,
	signal?: AbortSignal,
): Promise<CliDoneResult> {
	throwIfCancelled(signal, "preflight");
	const loaded = await nativeBridgeClient.project.loadProjectFileFromPath(request.projectPath);
	if (!loaded.success || loaded.project === undefined) {
		throw new Error(loaded.error ?? loaded.message ?? "Failed to load project file");
	}
	const rawProject = loaded.project as unknown;
	const isCurrentDocument =
		typeof rawProject === "object" &&
		rawProject !== null &&
		"schemaVersion" in rawProject &&
		"timeline" in rawProject;

	let axcutDocument: AxcutDocument;
	let storedFormat = DEFAULT_EXPORT_SETTINGS.format;
	let storedQuality = DEFAULT_EXPORT_SETTINGS.quality;
	let storedGifFrameRate = DEFAULT_GIF_SETTINGS.frameRate;
	let storedGifSizePreset = DEFAULT_GIF_SETTINGS.sizePreset;
	let storedGifLoop = DEFAULT_GIF_SETTINGS.loop;
	if (isCurrentDocument) {
		axcutDocument = documentSchema.parse(migrateRawDocumentToCurrent(rawProject));
		const editor = normalizeProjectEditor(
			(axcutDocument.legacyEditor ?? {}) as Parameters<typeof normalizeProjectEditor>[0],
		);
		storedFormat = editor.exportFormat;
		storedQuality = editor.exportQuality;
		storedGifFrameRate = editor.gifFrameRate;
		storedGifSizePreset = editor.gifSizePreset;
		storedGifLoop = editor.gifLoop;
	} else {
		if (!validateProjectData(rawProject)) {
			throw new Error("Project file is not a valid Klippt project");
		}
		const project = rawProject;
		const media = resolveProjectMedia(project);
		if (!media) {
			throw new Error("Project file does not reference any recorded media");
		}
		// Prefer the main process's approved session paths: they carry the
		// packed-project sibling fallback when the stored absolute paths are stale.
		try {
			const sessionResult = await window.electronAPI.getCurrentRecordingSession();
			const session = sessionResult?.session;
			if (session?.screenVideoPath) {
				media.screenVideoPath = session.screenVideoPath;
				if (media.webcamVideoPath && session.webcamVideoPath) {
					media.webcamVideoPath = session.webcamVideoPath;
				}
			}
		} catch {
			// Fall back to the paths stored in the project file.
		}
		const editor = normalizeProjectEditor(project.editor ?? {});
		storedFormat = editor.exportFormat;
		storedQuality = editor.exportQuality;
		storedGifFrameRate = editor.gifFrameRate;
		storedGifSizePreset = editor.gifSizePreset;
		storedGifLoop = editor.gifLoop;
		axcutDocument = migrateProjectDataToAxcutDocument({
			...project,
			media,
			editor,
		});
	}

	const format = request.format ?? storedFormat;
	if (request.audioPath && format === "gif") {
		throw new Error(
			"--audio is only supported for MP4 exports (this project's stored format is gif; pass --format mp4)",
		);
	}
	const quality = request.quality ?? storedQuality;
	const gifFrameRate = request.gifFrameRate ?? storedGifFrameRate;
	const gifSizePreset = request.gifSizePreset ?? storedGifSizePreset;
	const outPath =
		request.outPath ?? replaceExtension(request.projectPath, format === "gif" ? ".gif" : ".mp4");
	// Probe each used asset once. Current editor projects can contain many clips
	// from different recordings; the legacy CLI path only probed the first file.
	const assetById = new Map(axcutDocument.assets.map((asset) => [asset.id, asset]));
	const usedAssets = [
		...new Set(resolveVisibleClips(axcutDocument).map((clip) => clip.assetId)),
	].flatMap((assetId) => {
		const asset = assetById.get(assetId);
		return asset?.originalPath ? [asset] : [];
	});
	if (usedAssets.length === 0) {
		throw new Error("The project's timeline has no readable media to export");
	}
	const probedAssetDims: Record<string, Dims> = {};
	for (const asset of usedAssets) {
		// A recording can contain dozens of clip assets. Probe them in sequence so
		// the hidden CLI window never opens dozens of media decoders at once.
		const probe = await probeVideoDimensions(toFileUrl(asset.originalPath));
		probedAssetDims[asset.id] = { width: probe.width, height: probe.height };
		if (probe.durationMs > 0) {
			axcutDocument = applyProbedDuration(axcutDocument, asset.id, probe.durationMs / 1000);
		}
	}
	const primaryAssetId = axcutDocument.project.primaryAssetId ?? axcutDocument.assets[0]?.id;
	if (!primaryAssetId) {
		throw new Error("Project contains no media asset");
	}

	// Output sizing mirrors the ExportDialog: crop-aware smallest clip on the
	// timeline, normalized to the document's aspect ratio.
	const smallestSource =
		pickExtremeDims(collectEffectiveClipDims(axcutDocument, probedAssetDims), "smallest") ??
		probedAssetDims[primaryAssetId] ??
		Object.values(probedAssetDims)[0];
	if (!smallestSource) {
		throw new Error("Could not determine the export dimensions");
	}
	const editorSettings = getEditorSettings(axcutDocument);
	const aspectRatioValue = resolveOutputAspectRatioValue(
		axcutDocument,
		editorSettings.aspectRatio,
		editorSettings.outputResolution,
	);
	const outDims =
		quality === "source" && editorSettings.outputResolution
			? calculateMp4ExportSettingsForResolution({
					quality,
					...editorSettings.outputResolution,
					fps: MP4_EXPORT_FPS,
					codec: "h264",
				})
			: calculateMp4ExportSettings({
					quality,
					sourceWidth: smallestSource.width,
					sourceHeight: smallestSource.height,
					aspectRatioValue,
					fps: MP4_EXPORT_FPS,
					codec: "h264",
				});

	const cleanVoiceRuntime: CleanVoiceRuntimeSnapshot = window.electronAPI.getCleanVoiceRuntime
		? await window.electronAPI
				.getCleanVoiceRuntime(
					axcutDocument.project.id,
					axcutDocument.assets.map((asset) => asset.id),
				)
				.catch((): CleanVoiceRuntimeSnapshot => ({ available: false, assets: [] }))
		: { available: false, assets: [] };
	const clips = buildCompositorClipInputs(axcutDocument, cleanVoiceRoutes(cleanVoiceRuntime));
	if (clips.length === 0) {
		throw new Error("The project's timeline has no visible clips to export");
	}
	const scene = buildSceneDescription(axcutDocument);
	const sceneJson = JSON.stringify(scene);
	const effectiveDurationSec = calculateEffectiveExportDuration(clips, scene.speedRegions);

	// Progress: native pushes raw encoded-frame counts; totals and pacing are
	// computed here, mirroring the ExportDialog.
	const outFps = format === "gif" ? gifFrameRate : MP4_EXPORT_FPS;
	const totalFrames = Math.max(1, Math.round(effectiveDurationSec * outFps));
	let firstProgress: { frame: number; timeMs: number } | null = null;
	const unsubscribeProgress = window.electronAPI.onNativeExportProgress?.((frames: number) => {
		const now = Date.now();
		firstProgress ??= { frame: frames, timeMs: now };
		const elapsedSec = (now - firstProgress.timeMs) / 1000;
		const measuredFrames = frames - firstProgress.frame;
		const rate = measuredFrames > 0 ? measuredFrames / Math.max(elapsedSec, 0.001) : 0;
		window.electronAPI.cliProgress({
			percentage: Math.min(100, (frames / totalFrames) * 100),
			currentFrame: frames,
			totalFrames,
			...(rate > 0 ? { estimatedTimeRemaining: Math.max(0, (totalFrames - frames) / rate) } : {}),
		});
	});
	const unsubscribePhase = window.electronAPI.onNativeExportPhase?.((phase) => {
		window.electronAPI.cliProgress({
			percentage: phase === "preflight" || phase === "rendering" ? 0 : 100,
			phase,
		});
	});
	let intermediatePath: string | null = null;

	try {
		if (format === "gif") {
			const dims = gifOutputDims(gifSizePreset, outDims);
			const stats = await exportGifNative(
				clips,
				outPath,
				sceneJson,
				{
					...dims,
					fps: gifFrameRate,
					loopCount: storedGifLoop ? 0 : 1,
				},
				{
					signal,
					expectedBytes: estimateGifFileSizeBytes({
						durationSec: effectiveDurationSec,
						...dims,
						fps: gifFrameRate,
					}),
				},
			);
			return {
				success: true,
				outputPath: outPath,
				format,
				width: dims.width,
				height: dims.height,
				...(stats.exportWarning ? { warnings: [stats.exportWarning.message] } : {}),
			};
		}

		// A voiceover export keeps the requested destination untouched until the
		// mixed file is complete and verified. The native render first goes to an
		// app-owned temporary path; the final buffer then uses the same atomic
		// publisher as normal exports.
		if (request.audioPath) {
			intermediatePath = await window.electronAPI.createTemporaryExportPath();
		}
		const nativeOutputPath = intermediatePath ?? outPath;
		const exportStats = await exportMultiNative(
			clips,
			nativeOutputPath,
			sceneJson,
			{
				width: outDims.width,
				height: outDims.height,
				fps: MP4_EXPORT_FPS,
				codec: "h264",
				bitrate: outDims.bitrate,
				evenVolume: editorSettings.evenVolume,
				normalizeAudio: editorSettings.normalizeVolume,
				targetLufs: editorSettings.audioTargetLufs,
				peakCeilingDbtp: editorSettings.audioPeakCeilingDbtp,
			},
			{
				signal,
				expectedBytes: estimateMp4FileSizeBytes({
					durationSec: effectiveDurationSec,
					videoBitrate: outDims.bitrate,
					hasAudio: clips.some((clip) => clip.hasAudio),
				}),
			},
		);

		if (request.audioPath) {
			throwIfCancelled(signal, "rendering");
			window.electronAPI.cliProgress({
				percentage: 100,
				phase: "mixing-voiceover",
			});
			const [videoResponse, audioResponse] = await Promise.all([
				fetch(toFileUrl(nativeOutputPath)),
				fetch(toFileUrl(request.audioPath)),
			]);
			if (!videoResponse.ok) {
				throw new Error(`Failed to read the exported video back for mixing: ${outPath}`);
			}
			if (!audioResponse.ok) {
				throw new Error(`Failed to read voiceover file: ${request.audioPath}`);
			}
			const mixed = await mixVoiceoverIntoVideo(await videoResponse.blob(), {
				voiceoverData: await audioResponse.arrayBuffer(),
				mode: request.audioMode,
				offsetSec: request.audioOffsetSec,
			});
			throwIfCancelled(signal, "rendering");
			const mixedBuffer = await mixed.arrayBuffer();
			const bufferExportId = crypto.randomUUID();
			const cancelBufferExport = () => {
				void window.electronAPI.cancelWriteExport(bufferExportId).catch(() => undefined);
			};
			signal?.addEventListener("abort", cancelBufferExport, { once: true });
			let saveResult: Awaited<ReturnType<typeof window.electronAPI.writeExportToPath>>;
			try {
				if (signal?.aborted) cancelBufferExport();
				saveResult = await window.electronAPI.writeExportToPath(
					mixedBuffer,
					outPath,
					{
						width: outDims.width,
						height: outDims.height,
						fps: MP4_EXPORT_FPS,
						durationS: exportStats.videoDurationS,
						codec: "h264",
						expectedBytes: mixedBuffer.byteLength,
					},
					bufferExportId,
				);
			} finally {
				signal?.removeEventListener("abort", cancelBufferExport);
			}
			if (!saveResult.success) {
				const failure = saveResult.message ?? `Failed to write mixed output to ${outPath}`;
				throw new CliExportTransactionError(
					failure,
					saveResult.phase ?? "publishing",
					saveResult.code ?? "PUBLISH_FAILED",
					saveResult.retryable,
				);
			}
			// Only the final voiceover publication controls the user-facing
			// durability state. The intermediate render is app-owned scratch media.
			exportStats.exportWarning = saveResult.exportWarning;
		}

		return {
			success: true,
			outputPath: outPath,
			format,
			width: outDims.width,
			height: outDims.height,
			...(exportStats.exportWarning ? { warnings: [exportStats.exportWarning.message] } : {}),
		};
	} finally {
		unsubscribeProgress?.();
		unsubscribePhase?.();
		if (intermediatePath) {
			await window.electronAPI.removeTemporaryExportPath(intermediatePath).catch(() => undefined);
		}
	}
}

function CliExportRunner() {
	const startedRef = useRef(false);
	const [status, setStatus] = useState("Starting export…");

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		void (async () => {
			const controller = new AbortController();
			const unsubscribeCancel = window.electronAPI.onCliCancelExport(() => controller.abort());
			try {
				const request = (await window.electronAPI.cliGetRequest()) as CliExportRequest;
				if (request.kind !== "export") {
					throw new Error(`cli-export window received a ${request.kind} request`);
				}
				setStatus(`Exporting ${request.projectPath}…`);
				const result = await runExport(request, controller.signal);
				await window.electronAPI.cliDone(result);
			} catch (error) {
				await window.electronAPI.cliDone(cliExportFailure(error));
			} finally {
				unsubscribeCancel();
			}
		})();
	}, []);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			{status}
		</div>
	);
}

export default CliExportRunner;
