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

import { Download, FileVideo, FolderOpen, Loader2 } from "lucide-react";
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
import { APP_DISPLAY_NAME } from "@/lib/brand";
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
	onSourceBusyChange?: (busy: boolean) => void;
}

export function ExportDialog({
	open,
	onClose,
	document,
	quickExport = false,
	onSourceBusyChange,
}: ExportDialogProps) {
	const t = useScopedT("editor");
	const ts = useScopedT("settings");
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

	useEffect(() => {
		if (!open) return;
		if (quickExport && !isExportRunActive(useExportRunStore.getState().phase))
			useExportRunStore.getState().reset();
		setOutput(loadEditingPreferences().export.output);
		if (quickExport) {
			setFormat("mp4");
			setQuality("source");
			setFps(60);
			setCodec("h264");
		}
	}, [open, quickExport]);
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

		const safeName = (document.project.title || APP_DISPLAY_NAME)
			.replace(/[^a-z0-9-_]+/gi, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 60);
		const suggested = `${safeName || "export"}${format === "gif" ? ".gif" : ".mp4"}`;

		const exportController = new AbortController();
		run().begin(() => exportController.abort());

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
			const unsubscribeProgress = window.electronAPI?.onNativeExportProgress?.((frames) => {
				const now = Date.now();
				firstProgress ??= { frame: frames, timeMs: now };
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
							`${pickedPath}, ${formatHms(stats.videoDurationS)} ${t("exportDialog.exportedVideoOf")} ${formatHms(stats.wallS)}`,
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

	return (
		<ModalShell
			open={open}
			onClose={() => {
				if (!sourceBusy) handleClose();
			}}
			title={t("exportDialog.title")}
			subtitle={
				output === "sources"
					? t("recordingReview.originalsHint")
					: phase === "done"
						? undefined
						: quickExport
							? t("exportDialog.quickSubtitle")
							: t("exportDialog.subtitle")
			}
			size="xl"
		>
			<div className={`${exportStyles.dialog} ${exportStyles.outputMode}`}>
				<button
					type="button"
					className={styles.btn}
					aria-pressed={output === "sources"}
					disabled={isBusy || sourceBusy}
					onClick={() => selectOutput("sources")}
				>
					Separate takes
				</button>
				<button
					type="button"
					className={styles.btn}
					aria-pressed={output === "video"}
					disabled={isBusy || sourceBusy}
					onClick={() => selectOutput("video")}
				>
					One video
				</button>
			</div>
			{output === "sources" && !isBusy ? (
				<div className={exportStyles.dialog}>
					<SourceExportPanel document={document} busy={sourceBusy} onBusy={sourceBusyChanged} />
				</div>
			) : (
				<div
					className={exportStyles.dialog}
					style={{ display: "flex", flexDirection: "column", gap: 18 }}
				>
					{phase !== "done" && !quickExport && (
						<>
							<div
								style={{
									display: "grid",
									gridTemplateColumns: "1fr 1fr",
									gap: 8,
								}}
							>
								<FormatToggle
									active={format === "mp4"}
									label={ts("exportFormat.mp4")}
									icon={<FileVideo size={18} />}
									onClick={() => setFormat("mp4")}
									disabled={isBusy}
								/>
								<FormatToggle
									active={format === "gif"}
									label={ts("exportFormat.gif")}
									icon={<Download size={18} />}
									onClick={() => setFormat("gif")}
									disabled={isBusy}
								/>
							</div>

							{format === "mp4" ? (
								<section>
									<div
										style={{
											font: "500 11px/1 var(--font-body)",
											textTransform: "uppercase",
											letterSpacing: "0.06em",
											color: "var(--muted)",
											marginBottom: 8,
										}}
									>
										{t("exportDialog.quality")}
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "repeat(3, 1fr)",
											gap: 8,
										}}
									>
										{QUALITY_OPTIONS.map((q) => (
											<button
												type="button"
												key={q.value}
												disabled={isBusy}
												aria-pressed={quality === q.value}
												onClick={() => setQuality(q.value)}
												style={{
													display: "flex",
													flexDirection: "column",
													gap: 2,
													padding: "10px 12px",
													border: `1px solid ${quality === q.value ? "var(--accent)" : "var(--border)"}`,
													borderRadius: 10,
													background: quality === q.value ? "var(--accent-wash)" : "var(--surface)",
													color: "var(--fg-2)",
													cursor: "pointer",
													font: "500 13px/1 var(--font-body)",
												}}
											>
												<span style={{ color: "var(--fg)", fontWeight: 600 }}>
													{ts(q.labelKey)}
												</span>
												{(() => {
													const dims = tierOutputDims(q.value);
													if (!dims) return null;
													// Downscale badge removed everywhere — restated what picking a lower
													// tier already means, not actionable. The upscale badge asks whether
													// the clip has to be STRETCHED to fill this frame (`wouldUpscale`),
													// which is a contain-fit question: a short-side compare read the
													// letterbox rows a non-16:9 source gets in a 16:9 project as if they
													// were stretched pixels, and flagged "1080p" on the very frame
													// "Source" produced unflagged. No "Source" special case any more —
													// its frame is the source's long side at the project ratio, so its
													// contain scale is never above 1 and the general test covers it.
													const isUpscale =
														smallestSource !== null && wouldUpscale(dims, smallestSource);
													return (
														<span
															style={{
																font: "500 11px var(--font-body)",
																color: isUpscale ? "var(--warn)" : "var(--muted)",
															}}
														>
															{q.value === "source"
																? editorSettings.outputResolution
																	? ts("background.custom")
																	: t("exportDialog.qualityMatchRecording")
																: q.value === "good"
																	? "2K"
																	: "1080p"}
															{", "}
															{dims.width} × {dims.height}
															{isUpscale ? `, ${t("exportDialog.qualityUpscaleWarning")}` : ""}
														</span>
													);
												})()}
											</button>
										))}
									</div>
									<div
										style={{
											display: "grid",
											gridTemplateColumns: "1fr 1fr",
											gap: 12,
											marginTop: 12,
										}}
									>
										<div>
											<div
												style={{
													font: "500 11px/1 var(--font-body)",
													textTransform: "uppercase",
													letterSpacing: "0.06em",
													color: "var(--muted)",
													marginBottom: 8,
												}}
											>
												{t("exportDialog.frameRate")}
											</div>
											<div
												style={{
													display: "grid",
													gridTemplateColumns: "repeat(3, 1fr)",
													gap: 6,
												}}
											>
												{([24, 30, 60] as const).map((r) => (
													<button
														type="button"
														key={r}
														disabled={isBusy}
														aria-pressed={fps === r}
														onClick={() => setFps(r)}
														style={segStyle(fps === r)}
													>
														{r}
													</button>
												))}
											</div>
										</div>
										<div>
											<div
												style={{
													font: "500 11px/1 var(--font-body)",
													textTransform: "uppercase",
													letterSpacing: "0.06em",
													color: "var(--muted)",
													marginBottom: 8,
												}}
											>
												{t("exportDialog.codec")}
											</div>
											<div
												style={{
													display: "grid",
													gridTemplateColumns: "repeat(2, 1fr)",
													gap: 6,
												}}
											>
												{(
													[
														["h264", "H.264"],
														["h265", "H.265"],
														// VP9 has no AMF hardware encoder on this GPU — the native pipeline
														// (the only MP4 export path now) rejects it outright (tested: a
														// software libvpx-vp9 fallback worked but was too slow to ship).
														// Hidden here rather than left selectable-then-erroring.
													] as Array<[ExportVideoCodec, string]>
												).map(([value, label]) => (
													<button
														type="button"
														key={value}
														disabled={isBusy}
														aria-pressed={codec === value}
														onClick={() => setCodec(value)}
														style={segStyle(codec === value)}
														title={
															value === "h264"
																? t("exportDialog.codecBestCompatibility")
																: t("exportDialog.codecMaySupportVary")
														}
													>
														{label}
													</button>
												))}
											</div>
										</div>
									</div>
									{selectedMp4Settings && effectiveDurationSec > 0 && (
										<div
											data-testid="export-estimate"
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: 16,
												marginTop: 12,
												padding: "12px 14px",
												border: "1px solid var(--border-soft)",
												borderRadius: 10,
												background: "var(--surface-1)",
											}}
										>
											<div style={{ minWidth: 0 }}>
												<div
													style={{
														font: "500 11px/1 var(--font-body)",
														color: "var(--muted)",
														marginBottom: 6,
													}}
												>
													{t("exportDialog.estimatedSize")}
												</div>
												<div
													className={exportStyles.metadata}
													style={{
														font: "500 11px/1.4 var(--font-mono)",
														color: "var(--muted)",
													}}
												>
													<span>
														{selectedMp4Settings.width} × {selectedMp4Settings.height}
													</span>
													<span>{fps} FPS</span>
													<span>{codec === "h264" ? "H.264" : "H.265"}</span>
													<span>{formatBitrate(selectedMp4Settings.bitrate)}</span>
													<span>{formatHms(effectiveDurationSec)}</span>
												</div>
											</div>
											<strong
												style={{
													flexShrink: 0,
													font: "650 18px/1 var(--font-body)",
													color: "var(--fg)",
												}}
											>
												~{formatBytes(estimatedMp4Bytes)}
											</strong>
										</div>
									)}
								</section>
							) : (
								<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
									<div>
										<div
											style={{
												font: "500 11px/1 var(--font-body)",
												textTransform: "uppercase",
												letterSpacing: "0.06em",
												color: "var(--muted)",
												marginBottom: 8,
											}}
										>
											{t("exportDialog.frameRate")}
										</div>
										<div
											style={{
												display: "grid",
												gridTemplateColumns: "repeat(4, 1fr)",
												gap: 6,
											}}
										>
											{GIF_FRAME_RATES.map((r) => (
												<button
													type="button"
													key={r.value}
													disabled={isBusy}
													aria-pressed={gifFrameRate === r.value}
													onClick={() => setGifFrameRate(r.value)}
													style={segStyle(gifFrameRate === r.value)}
												>
													{r.value} FPS
												</button>
											))}
										</div>
									</div>
									<div>
										<div
											style={{
												font: "500 11px/1 var(--font-body)",
												textTransform: "uppercase",
												letterSpacing: "0.06em",
												color: "var(--muted)",
												marginBottom: 8,
											}}
										>
											{t("exportDialog.size")}
										</div>
										<div
											style={{
												display: "grid",
												gridTemplateColumns: "repeat(3, 1fr)",
												gap: 6,
											}}
										>
											{(Object.keys(GIF_SIZE_PRESETS) as GifSizePreset[]).map((s) => (
												<button
													type="button"
													key={s}
													disabled={isBusy}
													aria-pressed={gifSize === s}
													onClick={() => setGifSize(s)}
													style={segStyle(gifSize === s)}
												>
													{GIF_SIZE_PRESETS[s].label}
												</button>
											))}
										</div>
									</div>
									<div className={styles.paneRow} style={{ margin: 0 }}>
										<span className="label">{t("exportDialog.loopGif")}</span>
										<InspectorSwitch
											label={t("exportDialog.loopGif")}
											checked={gifLoop}
											disabled={isBusy}
											onCheckedChange={setGifLoop}
										/>
									</div>
									<div
										className={exportStyles.metadata}
										style={{
											font: "500 11px/1.4 var(--font-mono)",
											color: "var(--muted)",
											letterSpacing: "0.04em",
										}}
									>
										{selectedGifDims.width && selectedGifDims.height ? (
											<span>
												{selectedGifDims.width} × {selectedGifDims.height}
											</span>
										) : null}
										<span>{gifFrameRate} FPS</span>
										<span>{gifSizeLabel}</span>
										<span>{gifLoop ? t("exportDialog.loopOn") : t("exportDialog.loopOff")}</span>
									</div>
								</section>
							)}
						</>
					)}

					<ProgressBlock
						quickExport={quickExport}
						quickSummary={
							selectedMp4Settings
								? t("exportDialog.quickSummary", {
										width: selectedMp4Settings.width,
										height: selectedMp4Settings.height,
									})
								: t("exportDialog.quickSubtitle")
						}
						phase={phase}
						progress={progress}
						error={error}
						errorDetails={errorDetails}
						pct={pct}
						savedPath={savedPath}
						audioMastering={audioMastering}
					/>

					{cpuCompositor && phase !== "done" && (
						// Placed next to the export button, not in a toast: it has to land while
						// the user is still deciding. A CPU export renders every effect correctly
						// but takes minutes rather than seconds, and an unexplained ten-minute
						// wait reads as a hang.
						<p
							data-testid="export-cpu-warning"
							style={{
								margin: "0 0 4px",
								fontSize: "0.8125rem",
								lineHeight: 1.4,
								color: "var(--text-muted, rgb(0 0 0 / 0.65))",
							}}
						>
							{t("cpuCompositor.exportWarning")}
						</p>
					)}

					<div
						style={{
							display: "flex",
							justifyContent: "flex-end",
							gap: 8,
							paddingTop: 12,
							borderTop: "1px solid var(--border-soft)",
						}}
					>
						{phase === "rendering" || phase === "writing" ? (
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
							{phase === "done" || phase === "rendering" || phase === "writing"
								? t("exportDialog.close")
								: t("exportDialog.cancel")}
						</button>
						<button
							type="button"
							className={`${styles.btn} ${styles.btnPrimary}`}
							onClick={phase === "done" ? revealSavedFile : handleStart}
							disabled={isBusy || !document}
						>
							{phase === "done" ? (
								<>
									<FolderOpen size={14} />
									{t("exportDialog.showInFolder")}
								</>
							) : isBusy ? (
								<>
									<Loader2 size={14} className="animate-spin" />
									{phase === "rendering"
										? quickExport
											? t("exportDialog.saving")
											: t("exportDialog.rendering")
										: phase === "writing"
											? t("exportDialog.saving")
											: t("exportDialog.starting")}
								</>
							) : (
								<>
									<Download size={14} />
									{phase === "error"
										? t("exportDialog.retryExport")
										: format === "gif"
											? t("exportDialog.exportGif")
											: t("exportDialog.exportMp4")}
								</>
							)}
						</button>
					</div>
				</div>
			)}
		</ModalShell>
	);
}

function FormatToggle({
	active,
	label,
	icon,
	onClick,
	disabled,
}: {
	active: boolean;
	label: string;
	icon: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			aria-pressed={active}
			onClick={onClick}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 8,
				padding: "12px 16px",
				border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
				borderRadius: 10,
				background: active ? "var(--accent-wash)" : "var(--surface)",
				// Selection is conveyed by border + wash background (like the quality
				// cards below), not by swapping text color -- `--accent-on` is meant
				// for text on a SOLID accent fill, and paired with the near-transparent
				// `--accent-wash` it read as near-invisible dark-on-dark text.
				color: "var(--fg)",
				cursor: "pointer",
				font: "600 14px/1 var(--font-body)",
			}}
		>
			{icon}
			{label}
		</button>
	);
}

function ProgressBlock({
	quickExport,
	quickSummary,
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
	quickSummary: string;
	phase: ExportRunPhase;
	progress: ExportProgress | null;
	error: string | null;
	errorDetails: ExportFailureDetails | null;
	pct: number;
	savedPath: string | null;
	audioMastering: CompositorAudioMasteringResult | null;
}) {
	const t = useScopedT("editor");
	if (phase === "idle" || phase === "configuring") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--border)",
					borderRadius: 10,
					background: "var(--surface-1)",
					color: "var(--muted)",
					font: "500 12px var(--font-body)",
					textAlign: "center",
				}}
			>
				{phase === "configuring"
					? t("exportDialog.starting")
					: quickExport
						? quickSummary
						: t("exportDialog.pickFormatAndExport")}
			</div>
		);
	}
	if (phase === "done") {
		const masteringSummary = audioMastering?.analyzed
			? `${audioMastering.inputLufs?.toFixed(1)} → ${audioMastering.outputLufs?.toFixed(1)} LUFS, ${audioMastering.outputTruePeakDbtp?.toFixed(1)} dBTP`
			: null;
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--brand)",
					borderRadius: 10,
					background: "var(--success-soft)",
					color: "var(--fg-2)",
					font: "500 12px var(--font-body)",
				}}
			>
				<div role="status" style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>
					{t("exportDialog.exportedVideo")}
				</div>
				<div style={{ overflowWrap: "anywhere" }}>
					{t("exportDialog.savedTo")}{" "}
					<span style={{ fontFamily: "var(--font-mono)" }}>{savedPath}</span>
				</div>
				{masteringSummary && (
					<div data-testid="audio-mastering-summary" style={{ marginTop: 8 }}>
						{t("exportDialog.audioLevel")} {masteringSummary}
					</div>
				)}
				{audioMastering?.warning && (
					<div style={{ marginTop: 6, color: "var(--warn)" }}>{audioMastering.warning}</div>
				)}
			</div>
		);
	}
	if (phase === "error") {
		return (
			<div
				role="alert"
				data-export-phase={errorDetails?.phase}
				data-export-code={errorDetails?.code}
				title={
					errorDetails?.code
						? `${errorDetails.phase ?? "export"}, ${errorDetails.code}${errorDetails.retryable ? ", retryable" : ""}`
						: undefined
				}
				style={{
					padding: "16px",
					border: "1px solid var(--danger)",
					borderRadius: 10,
					background: "var(--danger-soft)",
					color: "var(--danger)",
					font: "500 12px var(--font-body)",
				}}
			>
				{error ?? t("exportDialog.exportFailedGeneric")}
			</div>
		);
	}
	const current = progress?.currentFrame ?? 0;
	const total = progress?.totalFrames ?? 0;
	const eta = progress?.estimatedTimeRemaining ?? 0;
	const stepLabel =
		phase === "writing"
			? t("exportDialog.writingFile")
			: quickExport
				? t("exportDialog.savingVideo")
				: t("exportDialog.renderingFrames");
	return (
		<div
			style={{
				padding: "12px 14px",
				border: "1px solid var(--border)",
				borderRadius: 10,
				background: "var(--surface-1)",
				display: "flex",
				flexDirection: "column",
				gap: 8,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<span style={{ font: "500 12px var(--font-body)", color: "var(--fg-2)" }}>{stepLabel}</span>
				<span
					style={{
						font: "500 12px/1 var(--font-mono)",
						color: "var(--brand)",
					}}
				>
					{phase === "writing" || !progress ? (
						<Loader2 size={14} className="animate-spin" />
					) : (
						`${Math.round(pct)}%`
					)}
				</span>
			</div>
			<div
				role="progressbar"
				aria-label={stepLabel}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={phase === "writing" || !progress ? undefined : Math.round(pct)}
				style={{
					position: "relative",
					height: 8,
					background: "var(--surface-3)",
					borderRadius: 999,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						position: "absolute",
						inset: 0,
						transform: `scaleX(${phase === "writing" ? 1 : Math.max(0, Math.min(100, pct)) / 100})`,
						transformOrigin: "left center",
						background: "var(--brand)",
						transition: "transform 200ms var(--ease)",
					}}
				/>
			</div>
			<div
				style={{
					font: "500 11px/1.4 var(--font-mono)",
					color: "var(--muted)",
					letterSpacing: "0.04em",
				}}
			>
				{phase === "writing"
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
								: t("exportDialog.preparingEncoder")}
			</div>
			<p
				style={{
					margin: "2px 0 0",
					font: "400 11.5px/1.45 var(--font-body)",
					color: "var(--muted)",
				}}
			>
				{quickExport ? t("exportDialog.quickBackgroundHint") : t("exportDialog.backgroundHint")}
			</p>
		</div>
	);
}

function segStyle(active: boolean): React.CSSProperties {
	return {
		padding: "8px 10px",
		border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
		borderRadius: 8,
		background: active ? "var(--brand)" : "var(--bg)",
		color: active ? "var(--accent-on)" : "var(--fg-2)",
		cursor: "pointer",
		font: "500 12px/1 var(--font-body)",
	};
}
