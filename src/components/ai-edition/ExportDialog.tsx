// Export dialog for the new editor. Wires together:
// 1. pickExportSavePath (native save dialog)
// 2. the native D3D exporter (exportMultiNative / exportGifNative)
// 3. writeExportToPath (writes the resulting buffer to disk)
//
// Format/quality/GIF options use local state while the dialog is mounted and
// restore from the versioned editing-preference record across app launches. The
// legacy `ExportDialog` (in components/video-editor) is the rich version
// used by the legacy VideoEditor; this one is a compact surface tuned for
// the new shell's modal style.

import {
	AlertCircle,
	Check,
	Download,
	FileVideo,
	Film,
	FolderOpen,
	ImagePlay,
	Loader2,
	RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { InspectorSwitch } from "@/components/ui/inspector";
import { useScopedT } from "@/contexts/I18nContext";
import { useCleanVoiceRuntime } from "@/hooks/useCleanVoiceRuntime";
import {
	collectEffectiveClipDims,
	type Dims,
	pickExtremeDims,
	resolveOutputAspectRatioValue,
} from "@/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	loadEditingPreferences,
	saveExportPreferences,
} from "@/lib/ai-edition/store/editingPreferences";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import {
	type ExportFailureDetails,
	type ExportRunPhase,
	isExportRunActive,
	useExportRunStore,
} from "@/lib/ai-edition/store/exportRunStore";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import { APP_DISPLAY_NAME } from "@/lib/brand";
import type { CleanCutExport } from "@/lib/cleanCut/types";
import {
	type ExportFormat,
	type ExportProgress,
	type ExportQuality,
	type ExportVideoCodec,
	GIF_FRAME_RATES,
	GIF_SIZE_PRESETS,
	type GifFrameRate,
	type GifSizePreset,
} from "@/lib/exporter";
import {
	calculateEffectiveExportDuration,
	calculateMp4ExportSettings,
	calculateMp4ExportSettingsForResolution,
	estimateMp4FileSizeBytes,
	formatBitrate,
	formatExportEta,
	wouldUpscale,
} from "@/lib/exporter/mp4ExportSettings";
import { exportGifNative, exportMultiNative, useIsCpuCompositor } from "@/native";
import { NativeBridgeClientError } from "@/native/client";
import type { CompositorAudioMasteringResult } from "@/native/contracts";
import { buildCompositorClipInputs, buildSceneDescription } from "@/native/sceneDescription";
import { formatBytes } from "@/utils/formatBytes";
import exportStyles from "./ExportDialog.module.css";
import { ModalShell } from "./Modals";
import styles from "./ReviewSurface.module.css";
import { SourceExportPanel } from "./SourceExportPanel";

/** hh:mm:ss (always shows hours, unlike the shared mm:ss `formatTimePadded`) — exports can run
 *  past an hour on either axis (video duration or render wall-time). */
function fileName(filePath: string): string {
	return filePath.split(/[\\/]/).pop() || filePath;
}

/** The name the save sheet suggests, so the dialog can show the same one. */
function suggestedFileName(title: string | undefined, format: ExportFormat): string {
	const safeName = (title || APP_DISPLAY_NAME)
		.replace(/[^a-z0-9-_]+/gi, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 60);
	return `${safeName || "export"}${format === "gif" ? ".gif" : ".mp4"}`;
}

function formatHms(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return [h, m, sec].map((v) => v.toString().padStart(2, "0")).join(":");
}

const QUALITY_OPTIONS: Array<{
	value: ExportQuality;
	labelKey: string;
}> = [
	{ value: "medium", labelKey: "exportQuality.low" },
	{ value: "good", labelKey: "exportQuality.medium" },
	{ value: "source", labelKey: "exportQuality.high" },
];

interface ExportDialogProps {
	open: boolean;
	onClose: () => void;
	document: AxcutDocument | null;
	/** Recording review uses source-quality MP4 for the One video option. */
	quickExport?: boolean;
	/** Original files allows untouched source recovery, never a finished video export. */
	sourceOnly?: boolean;
	onSourceBusyChange?: (busy: boolean) => void;
	/** The review's clean cut; Save adds its timeline to the separate files. */
	cleanCut?: CleanCutExport | null;
	/** Clean cut is on but has no result, so this save goes without it. */
	cleanCutStatus?: "working" | "failed" | null;
}

export function ExportDialog({
	open,
	onClose,
	document,
	quickExport = false,
	sourceOnly = false,
	onSourceBusyChange,
	cleanCut = null,
	cleanCutStatus = null,
}: ExportDialogProps) {
	const t = useScopedT("editor");
	const { routes: cleanVoiceRoutes } = useCleanVoiceRuntime(document);
	// No usable GPU: the export still applies every effect (output is identical), it
	// just runs on the software encoder and takes minutes instead of seconds.
	const cpuCompositor = useIsCpuCompositor();
	const [initialPreferences] = useState(() => loadEditingPreferences().export);
	const [output, setOutput] = useState<"sources" | "video">(initialPreferences.output);
	const [sourceBusy, setSourceBusy] = useState(false);
	const [format, setFormat] = useState<ExportFormat>(initialPreferences.format);
	const [quality, setQuality] = useState<ExportQuality>(initialPreferences.quality);
	const [fps, setFps] = useState<24 | 30 | 60>(initialPreferences.fps);
	const [codec, setCodec] = useState<ExportVideoCodec>(initialPreferences.codec);
	const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(initialPreferences.gifFrameRate);
	const [gifSize, setGifSize] = useState<GifSizePreset>(initialPreferences.gifSize);
	const [gifLoop, setGifLoop] = useState(initialPreferences.gifLoop);
	// The run itself lives in a shared store so the dialog can close while the file
	// renders and the top bar can show its progress.
	const phase = useExportRunStore((s) => s.phase);
	const progress = useExportRunStore((s) => s.progress);
	const error = useExportRunStore((s) => s.error);
	const errorDetails = useExportRunStore((s) => s.errorDetails);
	const savedPath = useExportRunStore((s) => s.savedPath);
	const openRef = useRef(open);
	openRef.current = open;
	const audioMastering = useExportRunStore((s) => s.audioMastering);
	const run = useExportRunStore.getState;

	// (Old behavior: the native compositor overlay used to be a top-level OS window outside the
	//  Chromium surface, so we'd hide it here to put this modal in front. The compositor now
	//  streams into a normal `<canvas>` inside the DOM — CSS z-index handles stacking naturally
	//  and there's no OS window to hide. The hide/show dance is now dead code; removed.)

	// Source dimensions come straight off `asset.video`. This dialog used to probe missing ones
	// into local state as a fallback for recordings that were never probed; `useAssetDimensionBackfill` now
	// backfills them on review load (before this dialog can open) and persists them, so every
	// consumer reads the one populated source instead of each re-probing on its own.
	const primaryAsset = useMemo(
		() =>
			document
				? (document.assets.find((a) => a.id === document.project.primaryAssetId) ??
					document.assets[0])
				: null,
		[document],
	);

	// Per-clip EFFECTIVE (post-crop) dims — single source of truth for both the "largest"
	// and "smallest" picks below, computed once instead of two near-identical hand-rolled
	// reduce+fallback loops. Crop is per-clip, so this must iterate clips, not assets: the
	// same recording can be cropped differently in two different clips on the timeline.
	const effectiveClipDims = useMemo<Dims[]>(
		() => (document ? collectEffectiveClipDims(document) : []),
		[document],
	);
	// (The "largest clip" pick lived here for the old renderer-side GIF path, which
	// sized to the best available footage independently of the quality tier. GIF now
	// goes through the same native exporter as MP4 and shares its sizing, so only the
	// smallest-clip pick below is still needed.)

	// Smallest clip's true (cropped) footprint on the timeline — a multiclip timeline can mix
	// crops/resolutions, so this is what "Source" quality actually targets: sizing to the
	// SMALLEST clip's own resolution means no clip on the timeline is ever upscaled past its
	// true footprint by picking Source. It also feeds the upscale badge on the fixed
	// 1080p/2K tiers, which can still genuinely upscale a small clip.
	const smallestSource = useMemo(
		() => pickExtremeDims(effectiveClipDims, "smallest"),
		[effectiveClipDims],
	);
	const editorSettings = useMemo(() => getEditorSettings(document), [document]);

	// Aspect the export normalizes to: the timeline's selected ratio (mirrors documentExporter),
	// so the sizes shown match what the export produces. Read through `getEditorSettings` — the
	// same typed façade the ratio dropdown writes through and `buildSceneDescription` reads — so
	// this dialog can't drift from the compositor if the storage ever moves. `resolveAspectRatioValue`
	// owns the legacy "native" case (uncropped reference asset), previously hand-rolled here.
	const EXPORT_ASPECT = useMemo(
		() =>
			resolveOutputAspectRatioValue(
				document,
				editorSettings.aspectRatio,
				editorSettings.outputResolution,
			),
		[document, editorSettings.aspectRatio, editorSettings.outputResolution],
	);
	// Output dimensions the export will produce for a given tier, from the (crop-aware)
	// SMALLEST clip on the timeline — see `smallestSource` above for why. Only "Source"
	// quality actually uses these as its target size; 1080p/2K target a fixed short side
	// regardless (`calculateDimensionsForShortSide`), so this only changes what "Source"
	// resolves to.
	// GIF is 8-bit indexed and grows fast with area, so the size preset caps the
	// output height rather than following the quality tier. `original` keeps the
	// tier's dims; the native side falls back to its own defaults when undefined.
	const gifOutputDims = (
		preset: GifSizePreset,
		tierDims: { width: number; height: number } | null,
	): { width?: number; height?: number } => {
		if (!tierDims) return {};
		const maxHeight = GIF_SIZE_PRESETS[preset].maxHeight;
		if (!Number.isFinite(maxHeight) || tierDims.height <= maxHeight) {
			return { width: tierDims.width, height: tierDims.height };
		}
		const scale = maxHeight / tierDims.height;
		// Even dimensions: the compositor rasterises to this size and the readback
		// assumes a tightly-packed RGBA buffer.
		const even = (n: number) => Math.max(2, Math.round(n * scale) & ~1);
		return { width: even(tierDims.width), height: even(tierDims.height) };
	};

	const tierOutputDims = (value: ExportQuality) => {
		if (value === "source" && editorSettings.outputResolution) {
			return calculateMp4ExportSettingsForResolution({
				quality: value,
				...editorSettings.outputResolution,
				fps,
				codec,
			});
		}
		return smallestSource
			? calculateMp4ExportSettings({
					quality: value,
					sourceWidth: smallestSource.width,
					sourceHeight: smallestSource.height,
					aspectRatioValue: EXPORT_ASPECT,
					fps,
					codec,
				})
			: null;
	};

	const nativeClips = useMemo(
		() => (open && document ? buildCompositorClipInputs(document, cleanVoiceRoutes) : []),
		[cleanVoiceRoutes, open, document],
	);
	const nativeScene = useMemo(
		() => (open && document ? buildSceneDescription(document) : null),
		[open, document],
	);
	const selectedMp4Settings = tierOutputDims(quality);
	const effectiveDurationSec = useMemo(
		() => calculateEffectiveExportDuration(nativeClips, nativeScene?.speedRegions ?? []),
		[nativeClips, nativeScene],
	);
	const estimatedMp4Bytes = selectedMp4Settings
		? estimateMp4FileSizeBytes({
				durationSec: effectiveDurationSec,
				videoBitrate: selectedMp4Settings.bitrate,
				hasAudio: nativeClips.some((clip) => clip.hasAudio),
			})
		: 0;

	// Closing after a finished or failed run clears it; closing during a run keeps it
	// going (`reset` is a no-op while active) so the editor stays usable meanwhile.
	useEffect(() => {
		if (!open) useExportRunStore.getState().reset();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		if (quickExport && !isExportRunActive(useExportRunStore.getState().phase))
			useExportRunStore.getState().reset();
		const saved = loadEditingPreferences().export;
		setOutput(sourceOnly ? "sources" : saved.output);
		// Quick export forces its own settings without saving them. Restore the saved
		// ones for a full export before the save effect below can persist forced values.
		setFormat(quickExport ? "mp4" : saved.format);
		setQuality(quickExport ? "source" : saved.quality);
		setFps(quickExport ? 60 : saved.fps);
		setCodec(quickExport ? "h264" : saved.codec);
	}, [open, quickExport, sourceOnly]);

	useEffect(() => {
		if (quickExport) return;
		saveExportPreferences({
			format,
			quality,
			fps,
			codec: codec === "h265" ? "h265" : "h264",
			gifFrameRate,
			gifSize,
			gifLoop,
		});
	}, [codec, format, fps, gifFrameRate, gifLoop, gifSize, quality, quickExport]);
	const selectOutput = (next: "sources" | "video") => {
		setOutput(next);
		saveExportPreferences({ output: next });
	};
	const sourceBusyChanged = (busy: boolean) => {
		onSourceBusyChange?.(busy);
		setSourceBusy(busy);
	};

	// Escape, the backdrop and Close never cancel: a running export continues in the
	// background and the top bar shows its progress. Cancel is its own button.
	const handleClose = () => {
		if (phase === "configuring") return;
		onClose();
	};

	const handleStart = async () => {
		if (
			!document ||
			phase === "configuring" ||
			phase === "rendering" ||
			phase === "writing" ||
			phase === "done"
		)
			return;
		const asset = primaryAsset;
		if (!asset) {
			run().fail(t("exportDialog.addVideoBeforeExporting"), null);
			return;
		}

		const suggested = suggestedFileName(document.project.title, format);

		const exportController = new AbortController();
		if (!run().begin(() => exportController.abort())) return;

		let pickedPath: string | undefined;
		try {
			const picker = await window.electronAPI?.pickExportSavePath?.(suggested);
			pickedPath = picker && "path" in picker ? picker.path : undefined;
		} catch (err) {
			run().fail(err instanceof Error ? err.message : String(err), null);
			return;
		}
		if (!pickedPath) {
			run().abandon();
			return;
		}

		// Both formats go through the native D3D exporter — same clips, same scene,
		// same frame walk in the compositor crate; only the container differs. There
		// is no CPU/web fallback: that path silently regressed to an ultra-slow CPU
		// render once, which is exactly the failure mode a flag-gated fallback
		// invites. Background/layout/webcam/cursor/effects come from the same scene
		// as the live preview, so an export can no longer disagree with what the
		// user previewed.
		{
			run().setPhase("rendering");
			// Render the real timeline when there are clips; else fall back to the fixture.
			const clips = nativeClips;
			// GIF runs at its own frame rate, so the progress total has to use it.
			const outFps = format === "gif" ? gifFrameRate : fps;
			// Total frames the encoder will produce, known upfront from the timeline (sum of
			// each clip's trimmed source duration) — the native side only reports frames
			// AFTER encoding one (onNativeExportProgress), it doesn't know/send a total, so
			// this is computed here to turn that raw count into a percentage.
			const totalDurationSec = effectiveDurationSec;
			const totalFrames = Math.max(1, Math.round(totalDurationSec * outFps));
			let firstProgress: { frame: number; timeMs: number } | null = null;
			const progressOf = () => useExportRunStore.getState().progress;
			const unsubscribeProgress = window.electronAPI?.onNativeExportProgress?.((frames) => {
				const now = Date.now();
				// A source copy that falls back to rendering starts counting again.
				if (!firstProgress || frames < (progressOf()?.currentFrame ?? 0))
					firstProgress = { frame: frames, timeMs: now };
				const elapsedS = (now - firstProgress.timeMs) / 1000;
				const measuredFrames = frames - firstProgress.frame;
				const fractionDone = Math.min(1, frames / totalFrames);
				const renderRate = measuredFrames > 0 ? measuredFrames / Math.max(elapsedS, 0.001) : 0;
				const estimatedTimeRemaining =
					renderRate > 0 ? Math.max(0, (totalFrames - frames) / renderRate) : 0;
				run().setProgress({
					currentFrame: frames,
					totalFrames,
					percentage: fractionDone * 100,
					estimatedTimeRemaining,
				});
			});
			const unsubscribePhase = window.electronAPI?.onNativeExportPhase?.((nativePhase) => {
				run().setPhase(
					nativePhase === "preflight" || nativePhase === "rendering" ? "rendering" : "writing",
				);
			});
			try {
				const sceneJson = JSON.stringify(nativeScene ?? buildSceneDescription(document));
				const outDims = tierOutputDims(quality);
				if (clips.length === 0) {
					throw new Error(t("exportDialog.nothingToExport"));
				}
				const stats =
					format === "gif"
						? await exportGifNative(
								clips,
								pickedPath,
								sceneJson,
								{
									// GIF is 256-colour and grows fast; cap the long edge at the
									// chosen preset rather than exporting at source size.
									...gifOutputDims(gifSize, outDims),
									fps: gifFrameRate,
									// 0 = infinite, the historical GIF default; 1 = play once.
									loopCount: gifLoop ? 0 : 1,
								},
								{ signal: exportController.signal },
							)
						: await exportMultiNative(
								clips,
								pickedPath,
								sceneJson,
								{
									width: outDims?.width,
									height: outDims?.height,
									fps,
									codec,
									bitrate: outDims?.bitrate,
									evenVolume: editorSettings.evenVolume,
									normalizeAudio: editorSettings.normalizeVolume,
									targetLufs: editorSettings.audioTargetLufs,
									peakCeilingDbtp: editorSettings.audioPeakCeilingDbtp,
									preserveRecordingSource: quickExport && quality === "source",
								},
								{
									expectedBytes: estimatedMp4Bytes,
									signal: exportController.signal,
								},
							);
				run().succeed({
					savedPath: pickedPath,
					audioMastering: "audioMastering" in stats ? stats.audioMastering : null,
				});
				// The open dialog shows the finished state with Show in folder itself; a
				// toast is only for a warning or for an export finished in the background.
				if (stats.exportWarning || !openRef.current) {
					const exportToast = stats.exportWarning ? toast.warning : toast.success;
					exportToast(t("exportDialog.exportedVideo"), {
						description:
							stats.exportWarning?.message ??
							t("exportDialog.savedSummary", {
								name: fileName(pickedPath),
								duration: formatHms(stats.videoDurationS),
							}),
						action: {
							label: t("exportDialog.showInFolder"),
							onClick: () => {
								// `revealInFolder` is a bare ipcRenderer.invoke, so it rejects when
								// the main handler throws. The export already succeeded — failing to
								// open the folder is not worth a second toast, but it is worth a line.
								void window.electronAPI?.revealInFolder?.(pickedPath).catch((err) => {
									console.warn("[export] failed to reveal the file in its folder:", err);
								});
							},
						},
					});
				}
			} catch (err) {
				if (exportController.signal.aborted) {
					run().abandon();
					return;
				}
				const message = err instanceof Error ? err.message : String(err);
				const details =
					err instanceof NativeBridgeClientError
						? {
								phase: err.details?.exportPhase,
								code: err.details?.exportCode,
								retryable: err.retryable,
							}
						: null;
				run().fail(message, details);
				toast.error(t("exportDialog.exportFailed"), {
					description: message,
				});
			} finally {
				unsubscribeProgress?.();
				unsubscribePhase?.();
			}
			return;
		}
	};

	const isBusy = isExportRunActive(phase);
	const pct = progress?.percentage ?? 0;
	const gifSizeLabel = GIF_SIZE_PRESETS[gifSize].label;
	const selectedGifDims = gifOutputDims(gifSize, selectedMp4Settings);
	const revealSavedFile = () => {
		if (!savedPath) return;
		void window.electronAPI?.revealInFolder?.(savedPath).catch((err) => {
			console.warn("[export] failed to reveal the file in its folder:", err);
		});
	};

	const busyLabel =
		phase === "rendering"
			? quickExport
				? t("exportDialog.saving")
				: t("exportDialog.rendering")
			: phase === "writing"
				? t("exportDialog.saving")
				: t("exportDialog.starting");
	const running = phase === "rendering" || phase === "writing";
	const lead =
		output === "sources"
			? null
			: phase === "done" || phase === "error" || isBusy
				? null
				: quickExport
					? selectedMp4Settings
						? t("exportDialog.quickSummary", {
								width: selectedMp4Settings.width,
								height: selectedMp4Settings.height,
							})
						: t("exportDialog.quickSubtitle")
					: t("exportDialog.subtitle");

	return (
		<ModalShell
			open={open}
			onClose={() => {
				if (!sourceBusy) handleClose();
			}}
			title={t("recordingReview.save")}
			size="md"
			className={exportStyles.dialogWidth}
		>
			<div className={exportStyles.sheet}>
				{!sourceOnly ? (
					<div className={exportStyles.output} data-output={output}>
						<span className={exportStyles.outputThumb} aria-hidden="true" />
						<button
							type="button"
							aria-pressed={output === "sources"}
							disabled={isBusy || sourceBusy}
							onClick={() => selectOutput("sources")}
						>
							{t("exportDialog.outputSources")}
						</button>
						<button
							type="button"
							aria-pressed={output === "video"}
							disabled={isBusy || sourceBusy}
							onClick={() => selectOutput("video")}
						>
							{t("exportDialog.outputVideo")}
						</button>
					</div>
				) : null}
				{output === "sources" && !isBusy ? (
					<SourceExportPanel
						document={document}
						busy={sourceBusy}
						onBusy={sourceBusyChanged}
						cleanCut={cleanCut}
						cleanCutStatus={cleanCutStatus}
					/>
				) : (
					<>
						{lead ? <p className={exportStyles.lead}>{lead}</p> : null}
						{phase !== "done" && !quickExport && (
							<FullExportSettings
								format={format}
								setFormat={setFormat}
								quality={quality}
								setQuality={setQuality}
								fps={fps}
								setFps={setFps}
								codec={codec}
								setCodec={setCodec}
								gifFrameRate={gifFrameRate}
								setGifFrameRate={setGifFrameRate}
								gifSize={gifSize}
								setGifSize={setGifSize}
								gifLoop={gifLoop}
								setGifLoop={setGifLoop}
								disabled={isBusy}
								tierOutputDims={tierOutputDims}
								smallestSource={smallestSource}
								customResolution={Boolean(editorSettings.outputResolution)}
								selectedMp4Settings={selectedMp4Settings}
								selectedGifDims={selectedGifDims}
								gifSizeLabel={gifSizeLabel}
								effectiveDurationSec={effectiveDurationSec}
								estimatedMp4Bytes={estimatedMp4Bytes}
							/>
						)}

						<ProgressBlock
							quickExport={quickExport}
							fileLabel={suggestedFileName(document?.project.title, "mp4")}
							durationSec={effectiveDurationSec}
							phase={phase}
							progress={progress}
							error={error}
							errorDetails={errorDetails}
							pct={pct}
							savedPath={savedPath}
							audioMastering={audioMastering}
						/>

						{cleanCut && phase !== "done" ? (
							<p className={exportStyles.note} data-tone="quiet">
								{t("cleanCut.oneVideoFull")}
							</p>
						) : null}

						{cpuCompositor && phase !== "done" && (
							// Placed next to the export button, not in a toast: it has to land while
							// the user is still deciding. A CPU export renders every effect correctly
							// but takes minutes rather than seconds, and an unexplained ten-minute
							// wait reads as a hang.
							<p data-testid="export-cpu-warning" className={exportStyles.hint} data-tone="warn">
								{t("cpuCompositor.exportWarning")}
							</p>
						)}

						<div className={exportStyles.footer}>
							{running ? (
								<button
									type="button"
									className={`${styles.btn} ${styles.btnSecondary}`}
									onClick={() => run().requestCancel()}
								>
									{t("exportDialog.cancelExport")}
								</button>
							) : null}
							<button
								type="button"
								className={`${styles.btn} ${styles.btnSecondary}`}
								onClick={handleClose}
								disabled={phase === "configuring"}
							>
								{phase === "done" || running ? t("exportDialog.close") : t("exportDialog.cancel")}
							</button>
							{running ? null : (
								<button
									type="button"
									className={`${styles.btn} ${styles.btnPrimary}`}
									onClick={phase === "done" ? revealSavedFile : handleStart}
									disabled={isBusy || !document}
								>
									{phase === "done" ? (
										<>
											<FolderOpen size={15} aria-hidden="true" />
											{t("exportDialog.showInFolder")}
										</>
									) : isBusy ? (
										<>
											<Loader2 size={15} className="animate-spin" aria-hidden="true" />
											{busyLabel}
										</>
									) : (
										<>
											{phase === "error" ? (
												<RotateCcw size={15} aria-hidden="true" />
											) : (
												<Download size={15} aria-hidden="true" />
											)}
											{phase === "error"
												? t("exportDialog.retryExport")
												: quickExport
													? t("exportDialog.saveVideoAction")
													: format === "gif"
														? t("exportDialog.exportGif")
														: t("exportDialog.exportMp4")}
										</>
									)}
								</button>
							)}
						</div>
					</>
				)}
			</div>
		</ModalShell>
	);
}

function Seg<T extends string | number>({
	value,
	options,
	onChange,
	disabled,
	label,
}: {
	value: T;
	options: Array<{ value: T; label: React.ReactNode; title?: string; detail?: React.ReactNode }>;
	onChange: (next: T) => void;
	disabled?: boolean;
	label?: string;
}) {
	return (
		<div className={exportStyles.section}>
			{label ? <span className={exportStyles.sectionLabel}>{label}</span> : null}
			<div className={exportStyles.seg}>
				{options.map((option) => (
					<button
						type="button"
						key={String(option.value)}
						disabled={disabled}
						aria-pressed={value === option.value}
						onClick={() => onChange(option.value)}
						title={option.title}
					>
						{option.label}
						{option.detail}
					</button>
				))}
			</div>
		</div>
	);
}

/** Format, quality, frame rate and codec: only for a full export (source recovery). */
function FullExportSettings(props: {
	format: ExportFormat;
	setFormat: (value: ExportFormat) => void;
	quality: ExportQuality;
	setQuality: (value: ExportQuality) => void;
	fps: 24 | 30 | 60;
	setFps: (value: 24 | 30 | 60) => void;
	codec: ExportVideoCodec;
	setCodec: (value: ExportVideoCodec) => void;
	gifFrameRate: GifFrameRate;
	setGifFrameRate: (value: GifFrameRate) => void;
	gifSize: GifSizePreset;
	setGifSize: (value: GifSizePreset) => void;
	gifLoop: boolean;
	setGifLoop: (value: boolean) => void;
	disabled: boolean;
	tierOutputDims: (value: ExportQuality) => { width: number; height: number } | null;
	smallestSource: Dims | null;
	customResolution: boolean;
	selectedMp4Settings: { width: number; height: number; bitrate: number } | null;
	selectedGifDims: { width?: number; height?: number };
	gifSizeLabel: string;
	effectiveDurationSec: number;
	estimatedMp4Bytes: number;
}) {
	const t = useScopedT("editor");
	const ts = useScopedT("settings");
	const { disabled } = props;
	return (
		<>
			<Seg
				value={props.format}
				onChange={props.setFormat}
				disabled={disabled}
				options={[
					{
						value: "mp4" as ExportFormat,
						label: (
							<span className={exportStyles.segRow}>
								<FileVideo size={15} aria-hidden="true" />
								{ts("exportFormat.mp4")}
							</span>
						),
					},
					{
						value: "gif" as ExportFormat,
						label: (
							<span className={exportStyles.segRow}>
								<ImagePlay size={15} aria-hidden="true" />
								{ts("exportFormat.gif")}
							</span>
						),
					},
				]}
			/>
			{props.format === "mp4" ? (
				<>
					<Seg
						label={t("exportDialog.quality")}
						value={props.quality}
						onChange={props.setQuality}
						disabled={disabled}
						options={QUALITY_OPTIONS.map((q) => {
							const dims = props.tierOutputDims(q.value);
							// The upscale flag asks whether the clip has to be STRETCHED to fill this
							// frame (`wouldUpscale`), a contain-fit question; see `wouldUpscale`.
							const isUpscale =
								dims !== null &&
								props.smallestSource !== null &&
								wouldUpscale(dims, props.smallestSource);
							return {
								value: q.value,
								label: ts(q.labelKey),
								detail: dims ? (
									<span className={exportStyles.segDetail} data-warn={isUpscale || undefined}>
										{q.value === "source"
											? props.customResolution
												? ts("background.custom")
												: t("exportDialog.qualityMatchRecording")
											: q.value === "good"
												? "2K"
												: "1080p"}
										{", "}
										{dims.width} × {dims.height}
										{isUpscale ? `, ${t("exportDialog.qualityUpscaleWarning")}` : ""}
									</span>
								) : null,
							};
						})}
					/>
					<div className={exportStyles.sectionRow}>
						<Seg
							label={t("exportDialog.frameRate")}
							value={props.fps}
							onChange={props.setFps}
							disabled={disabled}
							options={([24, 30, 60] as const).map((r) => ({ value: r, label: r }))}
						/>
						<Seg
							label={t("exportDialog.codec")}
							value={props.codec}
							onChange={props.setCodec}
							disabled={disabled}
							// VP9 has no hardware encoder on the native pipeline, so it is not offered.
							options={[
								{
									value: "h264" as ExportVideoCodec,
									label: "H.264",
									title: t("exportDialog.codecBestCompatibility"),
								},
								{
									value: "h265" as ExportVideoCodec,
									label: "H.265",
									title: t("exportDialog.codecMaySupportVary"),
								},
							]}
						/>
					</div>
					{props.selectedMp4Settings && props.effectiveDurationSec > 0 && (
						<div data-testid="export-estimate" className={exportStyles.estimate}>
							<div className={exportStyles.movieText}>
								<span className={exportStyles.sectionLabel}>{t("exportDialog.estimatedSize")}</span>
								<div className={exportStyles.metadata}>
									<span>
										{props.selectedMp4Settings.width} × {props.selectedMp4Settings.height}
									</span>
									<span>{props.fps} FPS</span>
									<span>{props.codec === "h264" ? "H.264" : "H.265"}</span>
									<span>{formatBitrate(props.selectedMp4Settings.bitrate)}</span>
									<span>{formatHms(props.effectiveDurationSec)}</span>
								</div>
							</div>
							<strong className={exportStyles.estimateSize}>
								~{formatBytes(props.estimatedMp4Bytes)}
							</strong>
						</div>
					)}
				</>
			) : (
				<>
					<div className={exportStyles.sectionRow}>
						<Seg
							label={t("exportDialog.frameRate")}
							value={props.gifFrameRate}
							onChange={props.setGifFrameRate}
							disabled={disabled}
							options={GIF_FRAME_RATES.map((r) => ({ value: r.value, label: `${r.value} FPS` }))}
						/>
						<Seg
							label={t("exportDialog.size")}
							value={props.gifSize}
							onChange={props.setGifSize}
							disabled={disabled}
							options={(Object.keys(GIF_SIZE_PRESETS) as GifSizePreset[]).map((s) => ({
								value: s,
								label: GIF_SIZE_PRESETS[s].label,
							}))}
						/>
					</div>
					<div className={exportStyles.switchRow}>
						<span>{t("exportDialog.loopGif")}</span>
						<InspectorSwitch
							label={t("exportDialog.loopGif")}
							checked={props.gifLoop}
							disabled={disabled}
							onCheckedChange={props.setGifLoop}
						/>
					</div>
					<div className={exportStyles.metadata}>
						{props.selectedGifDims.width && props.selectedGifDims.height ? (
							<span>
								{props.selectedGifDims.width} × {props.selectedGifDims.height}
							</span>
						) : null}
						<span>{props.gifFrameRate} FPS</span>
						<span>{props.gifSizeLabel}</span>
						<span>{props.gifLoop ? t("exportDialog.loopOn") : t("exportDialog.loopOff")}</span>
					</div>
				</>
			)}
		</>
	);
}

function folderOf(filePath: string): string {
	const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	return index > 0 ? filePath.slice(0, index) : filePath;
}

function ProgressBlock({
	quickExport,
	fileLabel,
	durationSec,
	phase,
	progress,
	error,
	errorDetails,
	pct,
	savedPath,
	audioMastering,
}: {
	/** Recording review's One video: a fixed-quality save, not a frame render. */
	quickExport: boolean;
	fileLabel: string;
	durationSec: number;
	phase: ExportRunPhase;
	progress: ExportProgress | null;
	error: string | null;
	errorDetails: ExportFailureDetails | null;
	pct: number;
	savedPath: string | null;
	audioMastering: CompositorAudioMasteringResult | null;
}) {
	const t = useScopedT("editor");
	if (phase === "idle") {
		if (!quickExport) return null;
		return (
			<div className={exportStyles.movie}>
				<span className={exportStyles.movieIcon}>
					<Film size={20} aria-hidden="true" />
				</span>
				<div className={exportStyles.movieText}>
					<span className={exportStyles.movieName}>{fileLabel}</span>
					<span className={exportStyles.metadata}>
						<span>MP4</span>
						{durationSec > 0 ? <span>{formatPlayerTime(durationSec)}</span> : null}
					</span>
				</div>
			</div>
		);
	}
	if (phase === "configuring") {
		return (
			<div className={exportStyles.progress}>
				<div className={exportStyles.progressHead}>
					<span className={exportStyles.progressLabel}>{t("exportDialog.starting")}</span>
				</div>
				<div className={exportStyles.track} data-indeterminate>
					<span />
				</div>
			</div>
		);
	}
	if (phase === "done") {
		const masteringSummary = audioMastering?.analyzed
			? `${audioMastering.inputLufs?.toFixed(1)} → ${audioMastering.outputLufs?.toFixed(1)} LUFS, ${audioMastering.outputTruePeakDbtp?.toFixed(1)} dBTP`
			: null;
		return (
			<div className={exportStyles.result}>
				<span className={exportStyles.check} aria-hidden="true">
					<Check size={15} strokeWidth={2.6} />
				</span>
				<div className={exportStyles.resultBody}>
					<p role="status" className={exportStyles.resultTitle}>
						{t("exportDialog.exportedVideo")}
					</p>
					{savedPath ? (
						<>
							<p className={exportStyles.resultName}>{fileName(savedPath)}</p>
							<p className={exportStyles.path}>
								<span className="sr-only">{t("exportDialog.savedTo")} </span>
								{folderOf(savedPath)}
							</p>
						</>
					) : null}
					{masteringSummary && (
						<p data-testid="audio-mastering-summary" className={exportStyles.path}>
							{t("exportDialog.audioLevel")} {masteringSummary}
						</p>
					)}
					{audioMastering?.warning && (
						<p className={exportStyles.resultHint}>{audioMastering.warning}</p>
					)}
				</div>
			</div>
		);
	}
	if (phase === "error") {
		return (
			<div
				role="alert"
				className={exportStyles.result}
				data-export-phase={errorDetails?.phase}
				data-export-code={errorDetails?.code}
				title={
					errorDetails?.code
						? `${errorDetails.phase ?? "export"}, ${errorDetails.code}${errorDetails.retryable ? ", retryable" : ""}`
						: undefined
				}
			>
				<AlertCircle size={18} className={exportStyles.errorIcon} aria-hidden="true" />
				<div className={exportStyles.resultBody}>
					<p className={exportStyles.resultTitle}>{t("exportDialog.exportFailed")}</p>
					<p className={exportStyles.errorText}>{error ?? t("exportDialog.exportFailedGeneric")}</p>
				</div>
			</div>
		);
	}
	const current = progress?.currentFrame ?? 0;
	const total = progress?.totalFrames ?? 0;
	const eta = progress?.estimatedTimeRemaining ?? 0;
	const indeterminate = phase === "writing" || !progress;
	const stepLabel =
		phase === "writing"
			? t("exportDialog.writingFile")
			: quickExport
				? t("exportDialog.savingVideo")
				: t("exportDialog.renderingFrames");
	const detail =
		phase === "writing"
			? t("exportDialog.finishingFile")
			: quickExport
				? eta > 0
					? t("exportDialog.timeLeft", { eta: formatExportEta(eta) })
					: t("exportDialog.quickChecking")
				: total > 0 && current > 1 && eta > 0
					? t("exportDialog.framesEta", {
							current,
							total,
							eta: formatExportEta(eta),
						})
					: progress
						? t("exportDialog.renderingFrames")
						: t("exportDialog.preparingEncoder");
	return (
		<div className={exportStyles.progress}>
			<div className={exportStyles.progressHead}>
				<span className={exportStyles.progressLabel}>{stepLabel}</span>
				{indeterminate ? null : (
					<span className={exportStyles.percent}>
						<RollingNumber value={Math.round(pct)} />%
					</span>
				)}
			</div>
			<div
				role="progressbar"
				aria-label={stepLabel}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={indeterminate ? undefined : Math.round(pct)}
				className={exportStyles.track}
				data-indeterminate={indeterminate || undefined}
			>
				<span
					style={
						indeterminate
							? undefined
							: { transform: `scaleX(${Math.max(0, Math.min(100, pct)) / 100})` }
					}
				/>
			</div>
			<div className={exportStyles.progressMeta}>
				<span>{detail}</span>
			</div>
			<p className={exportStyles.hint}>
				{quickExport ? t("exportDialog.quickBackgroundHint") : t("exportDialog.backgroundHint")}
			</p>
		</div>
	);
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** An integer whose digits roll to each new value, like the review's odometer times. */
function RollingNumber({ value }: { value: number }) {
	const chars = [...String(value)];
	return (
		<span className={exportStyles.roll}>
			<span className="sr-only">{value}</span>
			{chars.map((char, index) => (
				<span
					key={`d${chars.length - index}`}
					className={exportStyles.rollColumn}
					aria-hidden="true"
				>
					<span
						className={exportStyles.rollStrip}
						style={{ transform: `translateY(${-Number(char) * 10}%)` }}
					>
						{DIGITS.map((digit) => (
							<span key={digit}>{digit}</span>
						))}
					</span>
				</span>
			))}
		</span>
	);
}
