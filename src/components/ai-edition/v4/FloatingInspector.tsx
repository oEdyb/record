import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import {
	AudioLines,
	Captions as CaptionsIcon,
	ChevronRight,
	FileText,
	Image as ImageIcon,
	Layout as LayoutIcon,
	Loader2,
	Maximize2,
	MousePointer2,
	Pencil,
	Scissors,
	SlidersHorizontal,
	Sparkles,
	Trash2,
	X,
	ZoomIn,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	AppMenu,
	AppMenuContent,
	AppMenuItem,
	AppMenuLabel,
	AppMenuTrigger,
} from "@/components/ui/app-menu";
import { AppSelect } from "@/components/ui/app-select";
import { parseCustomPlaybackSpeedInput } from "@/components/video-editor/customPlaybackSpeed";
import {
	effectiveZoomScale,
	MAX_PLAYBACK_SPEED,
	MAX_ZOOM_SCALE,
	MIN_ZOOM_SCALE,
	SPEED_OPTIONS,
} from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import {
	hasTextBackground,
	setTextBackgroundColor,
	textBackgroundColor,
	toggleTextBackground,
} from "@/lib/ai-edition/annotations/background";
import {
	type AnnotationTextAnimation,
	TEXT_ANIMATION_VALUES,
} from "@/lib/ai-edition/annotations/textAnimation";
import type { AxcutAnnotationRegion, AxcutClip } from "@/lib/ai-edition/schema";
import { rafCoalesce } from "@/lib/ai-edition/store/rafCoalesce";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { coalescedTrimGroups } from "@/lib/ai-edition/timeline/trim-mapping";
import { isOptionalEditorFacetVisible } from "@/lib/productSurface";
import {
	DEFAULT_CAMERA_MOTION_STYLE,
	DEFAULT_ZOOM_MOTION_STYLE,
	MOTION_SPEED_VALUES,
	MOTION_STYLE_VALUES,
	type MotionStyle,
	normalizeMotionSpeed,
} from "@/lib/zoomMath/motionCurve";
import { AudioPane } from "../AudioPane";
import { AutomaticDirectionPane } from "../AutomaticDirectionPane";
import { CaptionsPane } from "../CaptionsPane";
import { ColorField } from "../ColorField";
import {
	type SelectablePauseSuggestion,
	usePauseAnalysisStore,
} from "../pauses/pauseAnalysisStore";
import {
	BackgroundPane,
	CursorPane,
	LayoutPane,
	SliderCell,
	Toggle,
	TranscriptPane,
	VideoEffectsPane,
} from "../RightPanes";
import styles from "./EditorShellV4.module.css";

type TimelineApi = ReturnType<typeof useTimeline>;

export type Facet =
	| "background"
	| "effects"
	| "layout"
	| "cursor"
	| "audio"
	| "automatic"
	| "captions"
	| "transcript";

const ALL_FACETS: Array<{
	id: Facet;
	labelKey: string;
	icon: typeof ImageIcon;
}> = [
	{ id: "background", labelKey: "background.title", icon: ImageIcon },
	{ id: "effects", labelKey: "effects.title", icon: SlidersHorizontal },
	{ id: "layout", labelKey: "layout.title", icon: LayoutIcon },
	{ id: "cursor", labelKey: "cursor.title", icon: MousePointer2 },
	{ id: "audio", labelKey: "audio.title", icon: AudioLines },
	{ id: "automatic", labelKey: "automatic.title", icon: Sparkles },
	{ id: "captions", labelKey: "facets.captions", icon: CaptionsIcon },
	{ id: "transcript", labelKey: "facets.transcript", icon: FileText },
];

const FACETS = ALL_FACETS.filter(
	(facet) =>
		(facet.id !== "captions" && facet.id !== "transcript") ||
		isOptionalEditorFacetVisible(facet.id),
);

type TranscriptProps = ComponentProps<typeof TranscriptPane>;

interface FloatingInspectorProps {
	facet: Facet;
	open: boolean;
	onFacetChange: (facet: Facet) => void;
	onToggleOpen: () => void;
	/** Clips on the timeline, for the "Edit clip" picker — crop + trim now live
	 * per-clip (see clipSchema.cropRegion) instead of behind a document-wide
	 * facet, so this button opens EditClipModal directly instead of routing
	 * through a facet body. */
	clips: AxcutClip[];
	onEditClip: (clip: AxcutClip) => void;
	transcriptProps: TranscriptProps;
	onPausePreview?: (suggestions: SelectablePauseSuggestion[] | null) => void;
	/** Drives the selected-element settings pane (zoom/speed/annotation/trim) —
	 * takes over the inspector, forcing it open, whenever a timeline region is
	 * selected. Clicking elsewhere on the timeline clears the selection
	 * (see V4Timeline's empty-area click handler) which closes this pane. */
	tl: TimelineApi;
}

const DEFAULT_CAMERA_EMPHASIS_SCALE = 1.35;
const CAMERA_SCALE_VALUES = [1.15, 1.25, 1.35, 1.5, 1.75, 2];
/** The preset sizes, plus the region's own value when it was set elsewhere (agent, planner). */
function cameraScaleOptions(current: number | undefined): number[] {
	const value = current ?? DEFAULT_CAMERA_EMPHASIS_SCALE;
	return CAMERA_SCALE_VALUES.includes(value)
		? CAMERA_SCALE_VALUES
		: [...CAMERA_SCALE_VALUES, value].sort((a, b) => a - b);
}

export function FloatingInspector({
	facet,
	open,
	onFacetChange,
	onToggleOpen,
	clips,
	onEditClip,
	transcriptProps,
	onPausePreview = () => undefined,
	tl,
}: FloatingInspectorProps) {
	const te = useScopedT("editor");
	const selection = tl.selection;
	const hasEditableMedia = clips.length > 0;
	const effectiveOpen = hasEditableMedia && (open || selection !== null);
	const visibleFacet = FACETS.some((candidate) => candidate.id === facet) ? facet : "effects";
	const pauseAnalysisRunning = usePauseAnalysisStore((state) => state.status === "analyzing");
	return (
		<div className={styles.inspectorWrap}>
			<div className={styles.inspectorWorkspace} data-open={effectiveOpen}>
				{effectiveOpen ? (
					<div className={styles.inspector}>
						{selection ? (
							<SelectionPane tl={tl} onClose={() => tl.clearSelection()} />
						) : (
							<FacetBody
								facet={visibleFacet}
								onCollapse={onToggleOpen}
								transcriptProps={transcriptProps}
								onPausePreview={onPausePreview}
								onAdjustAutomatic={(member) => tl.selectRegion(member.kind, member.id)}
							/>
						)}
					</div>
				) : null}
				<div className={styles.facetRail}>
					<FacetNavigation
						value={!selection && open ? visibleFacet : ""}
						disabled={!hasEditableMedia}
						pauseAnalysisRunning={pauseAnalysisRunning}
						onValueChange={(next) => {
							if (selection) tl.clearSelection();
							if (next) onFacetChange(next);
							else onToggleOpen();
						}}
					/>
					<div className={styles.facetRailUtility}>
						{clips.length > 1 ? (
							<AppMenu>
								<AppMenuTrigger asChild>
									<button
										type="button"
										title={te("editClipDialog.title")}
										aria-label={te("editClipDialog.title")}
										onClick={() => selection && tl.clearSelection()}
									>
										<Pencil size={17} aria-hidden />
									</button>
								</AppMenuTrigger>
								<AppMenuContent
									side="left"
									align="end"
									sideOffset={8}
									className={styles.clipMenu}
									aria-label={te("editClipDialog.pickClipTitle")}
								>
									<AppMenuLabel>{te("editClipDialog.pickClipTitle")}</AppMenuLabel>
									{clips.map((clip, index) => (
										<AppMenuItem
											key={clip.id}
											className={styles.clipMenuItem}
											onSelect={() => onEditClip(clip)}
										>
											<span className={styles.clipMenuTitle}>
												{te("editClipDialog.clipLabel", { index: index + 1 })}
											</span>
											<span className={styles.clipMenuTime}>
												{formatSeconds(clip.timelineStartSec)}–{formatSeconds(clip.timelineEndSec)}
											</span>
										</AppMenuItem>
									))}
								</AppMenuContent>
							</AppMenu>
						) : (
							<button
								type="button"
								title={te("editClipDialog.title")}
								aria-label={te("editClipDialog.title")}
								disabled={!hasEditableMedia}
								onClick={() => {
									if (selection) tl.clearSelection();
									if (clips[0]) onEditClip(clips[0]);
								}}
							>
								<Pencil size={17} aria-hidden />
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function paneHeader(icon: React.ReactNode, title: string, onClose: () => void, closeLabel: string) {
	return (
		<header className={styles.selectionPaneHeader}>
			<span className={styles.selectionPaneHeaderIcon}>{icon}</span>
			<h2>{title}</h2>
			<button
				type="button"
				title={closeLabel}
				aria-label={closeLabel}
				onClick={onClose}
				className={styles.inspectorHeaderButton}
			>
				<X size={15} />
			</button>
		</header>
	);
}

function paneRow(label: string, control: React.ReactNode) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 10,
			}}
		>
			<span style={{ fontSize: 12.5, color: "var(--fg-2)", fontWeight: 500 }}>{label}</span>
			{control}
		</div>
	);
}

type AnnotationKind = AxcutAnnotationRegion["type"];
type ArrowDirectionKind = NonNullable<AxcutAnnotationRegion["figureData"]>["arrowDirection"];

/** The eight directions from `ArrowSvgs.tsx`, in its declared order. */
const ARROW_DIRECTIONS: ArrowDirectionKind[] = [
	"up",
	"down",
	"left",
	"right",
	"up-right",
	"up-left",
	"down-right",
	"down-left",
];

/** Schema defaults used to fill missing `blurData` without replacing stored values. */
const BLUR_DEFAULTS = {
	type: "mosaic",
	shape: "rectangle",
	color: "white",
	intensity: 12,
	blockSize: 12,
} as const;

/**
 * Build the patch used when the user changes an annotation type.
 *
 * `content` is shared by text and image annotations. The text field writes plain text to it, while
 * image rendering reads a data URL from it. Park each value in its typed slot when changing types
 * so image base64 never enters the text field and switching back does not lose content.
 */
function convertAnnotationKind(
	region: AxcutAnnotationRegion,
	next: AnnotationKind,
): Partial<AxcutAnnotationRegion> {
	if (region.type === next) return {};
	const parked: Partial<AxcutAnnotationRegion> =
		region.type === "text"
			? { textContent: region.content ?? "" }
			: region.type === "image"
				? { imageContent: region.content ?? "" }
				: {};
	// Arrow and blur annotations have no content, so do not retain text or image base64.
	const restored =
		next === "text"
			? (region.textContent ?? "")
			: next === "image"
				? (region.imageContent ?? "")
				: "";
	return { ...parked, type: next, content: restored };
}

// The ladder the shared editor already ships (`SPEED_OPTIONS`), plus 1× so the select can
// express "back to normal". It stops at 5×; the free field in `SpeedControl` is what reaches
// `MAX_PLAYBACK_SPEED`.
const SPEED_PRESETS = [1, ...SPEED_OPTIONS.map((option) => option.speed)].sort((a, b) => a - b);

/**
 * Preset select + free numeric field, the speed UX this editor already had translations for
 * (`settings.speed.customPlaybackSpeed` / `maxSpeedError` / `previewFrameSteppingHint`, shipped
 * in all 13 locales) but no longer any control for: the V4 shell replaced the panel that hosted
 * it with a preset-only `<AppSelect>` capped at 3×, while the underlying capability goes to
 * `MAX_PLAYBACK_SPEED` (100×). Only the control was missing, so this rewires it rather than
 * adding anything new.
 */
export function SpeedControl({
	region,
	tl,
}: {
	region: { id: string; speed: number };
	tl: Pick<TimelineApi, "updateSpeedValue">;
}) {
	const ts = useScopedT("settings");
	// "" means the field is idle and the select is showing the truth. A non-empty draft is
	// uncommitted text; it's cleared on commit so the placeholder tracks the live speed again.
	const [draft, setDraft] = useState("");

	const commitDraft = () => {
		const result = parseCustomPlaybackSpeedInput(draft);
		if (result.status === "valid") {
			void tl.updateSpeedValue(region.id, result.speed);
		} else if (result.status === "too-fast") {
			toast.error(ts("speed.maxSpeedError", { max: MAX_PLAYBACK_SPEED }));
		}
		// Anything else (empty, unparseable, below the floor) just reverts to the live value
		// rather than guessing at an intent.
		setDraft("");
	};

	// A custom speed matches no preset, so surface it as its own option — otherwise the select
	// would fall back to rendering its first entry and misreport the region.
	const options = SPEED_PRESETS.includes(region.speed)
		? SPEED_PRESETS
		: [...SPEED_PRESETS, region.speed].sort((a, b) => a - b);

	return (
		<>
			{paneRow(
				ts("speed.playbackSpeed"),
				<AppSelect
					value={region.speed}
					onChange={(e) => void tl.updateSpeedValue(region.id, Number(e.target.value))}
					style={selectStyle}
				>
					{options.map((speed) => (
						<option key={speed} value={speed}>
							{speed}×
						</option>
					))}
				</AppSelect>,
			)}
			{paneRow(
				ts("speed.customPlaybackSpeed"),
				<input
					type="text"
					inputMode="decimal"
					placeholder={`${region.speed}×`}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commitDraft}
					// Enter blurs, and the blur handler commits — one path, so a keyboard commit
					// can't apply the same draft twice.
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
					}}
					style={{ ...selectStyle, width: 84, textAlign: "right" }}
				/>,
			)}
			{/* No hint past 16×. There is nothing for the user to do about it and nothing that
			    changes in what they get: the export renders the true speed either way. The note
			    that used to sit here described the legacy editor's frame-stepped, silent preview,
			    which is not this one. */}
		</>
	);
}

export function ZoomScaleControl({
	region,
	tl,
}: {
	region: { id: string; depth: 1 | 2 | 3 | 4 | 5 | 6; customScale?: number };
	tl: Pick<TimelineApi, "updateZoomScaleLive" | "commitZoomScale">;
}) {
	const ts = useScopedT("settings");
	return (
		<SliderCell
			label={ts("zoom.customScale")}
			value={effectiveZoomScale(region)}
			min={MIN_ZOOM_SCALE}
			max={MAX_ZOOM_SCALE}
			step={0.05}
			decimals={2}
			suffix="×"
			onChange={(next) => tl.updateZoomScaleLive(region.id, next)}
			onCommit={() => void tl.commitZoomScale()}
			flat
		/>
	);
}

function RegionDurationControl({
	startMs,
	endMs,
	maximumEndMs,
	onCommit,
}: {
	startMs: number;
	endMs: number;
	maximumEndMs: number;
	onCommit: (nextEndMs: number) => void;
}) {
	const te = useScopedT("editor");
	const initialDurationSec = Math.max(0.1, (endMs - startMs) / 1_000);
	const maximumDurationSec = Math.max(initialDurationSec, (maximumEndMs - startMs) / 1_000);
	const [durationSec, setDurationSec] = useState(initialDurationSec);
	return (
		<SliderCell
			label={te("editClipDialog.duration")}
			value={durationSec}
			min={0.1}
			max={maximumDurationSec}
			step={0.1}
			decimals={1}
			suffix="s"
			onChange={setDurationSec}
			onCommit={() => onCommit(startMs + Math.round(durationSec * 1_000))}
			flat
		/>
	);
}

function SelectionPane({ tl, onClose }: { tl: TimelineApi; onClose: () => void }) {
	const ts = useScopedT("settings");
	const tt = useScopedT("timeline");
	const tc = useScopedT("common");
	const te = useScopedT("editor");
	// Read here rather than threading it through: the zoom pane is the only consumer, and the
	// toggle that writes it lives in the timeline toolbar, not on this component's path.
	const { settings } = useEditorSettings();
	const autoFocusAll = settings.autoFocusAll;
	// Coalesce live updates to one per frame. `updateAnnotationLive` replaces the document in the
	// store, so every call rebuilds and serializes the scene before sending it to the native layer.
	// A color input can emit an event for every pointer pixel, which can otherwise saturate the
	// renderer thread. The ref keeps the latest store function without recreating the coalescer.
	const liveUpdateRef = useRef(tl.updateAnnotationLive);
	liveUpdateRef.current = tl.updateAnnotationLive;
	const liveUpdate = useMemo(
		() =>
			rafCoalesce((id: string, patch: Partial<AxcutAnnotationRegion>) =>
				liveUpdateRef.current(id, patch),
			),
		[],
	);
	/** Flush the final pending value before saving so the disk does not keep the previous frame. */
	const commitAnnotation = () => {
		liveUpdate.flush();
		void tl.commitAnnotationChange();
	};
	const selection = tl.selection;
	if (!selection) return null;

	const deleteAndClose = () => {
		void tl.removeRegion(selection.kind, selection.id);
		onClose();
	};

	// The panel clips its rounded, blurred surface. Keep the header fixed and scroll the body so
	// tall selection controls remain available when the window gets shorter.
	const bodyStyle: React.CSSProperties = {
		padding: "12px 16px",
		display: "flex",
		flexDirection: "column",
		gap: 8,
		flex: "1 1 auto",
		minHeight: 0,
		overflowY: "auto",
		overflowX: "hidden",
		overscrollBehavior: "contain",
		scrollbarWidth: "thin",
		scrollbarColor: "var(--border) transparent",
	};
	const deleteBtnStyle: React.CSSProperties = {
		alignSelf: "flex-start",
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 7,
		padding: "6px 0",
		borderRadius: 8,
		border: 0,
		background: "transparent",
		color: "var(--danger)",
		font: "500 12px var(--font-body)",
		cursor: "pointer",
		marginTop: 2,
	};

	if (selection.kind === "zoom") {
		const region = tl.zoomRegions.find((z) => z.id === selection.id);
		if (!region) return null;
		const timelineEndMs = Math.max(
			region.endMs,
			...tl.clips.map((clip) => clip.timelineEndSec * 1_000),
		);
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<ZoomIn size={15} />, tt("labels.zoom"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					<ZoomScaleControl region={region} tl={tl} />
					<RegionDurationControl
						key={`${region.id}:${region.startMs}:${region.endMs}`}
						startMs={region.startMs}
						endMs={region.endMs}
						maximumEndMs={timelineEndMs}
						onCommit={(nextEndMs) => void tl.updateZoomSpan(region.id, region.startMs, nextEndMs)}
					/>
					{paneRow(
						ts("zoom.focusMode.title"),
						// While the global toggle is on it OVERRIDES every region, so the control shows
						// the effective mode ("auto") and goes read-only rather than lying about a
						// per-region value that currently has no effect. The region's own `focusMode` is
						// never written by the toggle — that is what makes each zoom snap back to its
						// previous value the moment the toggle goes off.
						<AppSelect
							value={autoFocusAll ? "auto" : (region.focusMode ?? "manual")}
							disabled={autoFocusAll}
							onChange={(e) =>
								void tl.updateZoomFocusMode(region.id, e.target.value as "manual" | "auto")
							}
							style={
								autoFocusAll ? { ...selectStyle, opacity: 0.5, cursor: "not-allowed" } : selectStyle
							}
						>
							<option value="manual">{ts("zoom.focusMode.manual")}</option>
							<option value="auto">{ts("zoom.focusMode.auto")}</option>
						</AppSelect>,
					)}
					{autoFocusAll || region.focusMode === "auto" ? (
						// Auto resamples the focus from cursor telemetry every frame, so there is no fixed
						// point to reset and no gimbal on the canvas (ZoomFocusOverlay bows out) — the
						// reset button would be a no-op. When the global toggle is what forced auto, say
						// so, and say where to turn it off.
						<p
							style={{
								margin: 0,
								font: "400 11px/1.45 var(--font-sans)",
								color: "var(--fg-2)",
							}}
						>
							{ts(
								autoFocusAll ? "zoom.focusMode.lockedDisclaimer" : "zoom.focusMode.autoDescription",
							)}
						</p>
					) : (
						<button
							type="button"
							onClick={() => {
								tl.updateZoomFocusLive(region.id, { cx: 0.5, cy: 0.5 });
								void tl.commitZoomFocus();
							}}
							style={secondaryBtnStyle}
						>
							{te("inspector.resetFocusPoint")}
						</button>
					)}
					<details style={advancedStyle}>
						<summary style={advancedSummaryStyle}>{ts("zoom.advanced")}</summary>
						<div style={advancedBodyStyle}>
							{paneRow(
								ts("zoom.threeD.title"),
								<AppSelect
									value={region.rotationPreset ?? "none"}
									onChange={(e) =>
										void tl.updateZoomRotation(
											region.id,
											e.target.value === "none"
												? undefined
												: (e.target.value as "iso" | "left" | "right"),
										)
									}
									style={selectStyle}
								>
									<option value="none">{ts("zoom.threeD.none")}</option>
									<option value="iso">{ts("zoom.threeD.preset.iso")}</option>
									<option value="left">{ts("zoom.threeD.preset.left")}</option>
									<option value="right">{ts("zoom.threeD.preset.right")}</option>
								</AppSelect>,
							)}
							{paneRow(
								ts("motion.title"),
								<AppSelect
									value={region.motionStyle ?? DEFAULT_ZOOM_MOTION_STYLE}
									onChange={(e) =>
										void tl.updateZoomMotionStyle(region.id, e.target.value as MotionStyle)
									}
									style={selectStyle}
								>
									{MOTION_STYLE_VALUES.map((style) => (
										<option key={style} value={style}>
											{ts(`motion.${style}`)}
										</option>
									))}
								</AppSelect>,
							)}
							{paneRow(
								ts("motion.speed"),
								<AppSelect
									value={normalizeMotionSpeed(region.motionSpeed)}
									disabled={region.motionStyle === "instant"}
									onChange={(e) => void tl.updateZoomMotionSpeed(region.id, Number(e.target.value))}
									style={
										region.motionStyle === "instant"
											? { ...selectStyle, opacity: 0.5, cursor: "not-allowed" }
											: selectStyle
									}
								>
									{MOTION_SPEED_VALUES.map((speed) => (
										<option key={speed} value={speed}>
											{speed}×
										</option>
									))}
								</AppSelect>,
							)}
						</div>
					</details>
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						{ts("zoom.deleteZoom")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "speed") {
		const region = tl.speedRegions.find((s) => s.id === selection.id);
		if (!region) return null;
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<ZoomIn size={15} />, tt("labels.speed"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					<SpeedControl region={region} tl={tl} />
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						{ts("speed.deleteRegion")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "annotation") {
		const region = tl.annotationRegions.find((a) => a.id === selection.id);
		if (!region) return null;
		const hasBackground = hasTextBackground(region.style);
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(
					<FileText size={15} />,
					tt("labels.annotationItem"),
					onClose,
					tc("actions.close"),
				)}
				<div style={bodyStyle}>
					{/* Type switch. Only text annotations could ever be created, so image, arrow and
					    blur were unreachable even though the compositor renders all four and every
					    label here already shipped translated. Converting keeps the span and box, so
					    a mistake costs one more click rather than redrawing the region. */}
					{paneRow(
						ts("annotation.type"),
						<AppSelect
							value={region.type}
							onChange={(e) => {
								tl.updateAnnotationLive(
									region.id,
									convertAnnotationKind(region, e.target.value as AnnotationKind),
								);
								void tl.commitAnnotationChange();
							}}
							style={selectStyle}
						>
							<option value="text">{ts("annotation.typeText")}</option>
							<option value="image">{ts("annotation.typeImage")}</option>
							<option value="figure">{ts("annotation.typeArrow")}</option>
							<option value="blur">{ts("annotation.typeBlur")}</option>
						</AppSelect>,
					)}
					{region.type === "text" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<span
								style={{
									fontSize: 12.5,
									color: "var(--fg-2)",
									fontWeight: 500,
								}}
							>
								{ts("annotation.textContent")}
							</span>
							<textarea
								value={region.content ?? ""}
								placeholder={ts("annotation.textPlaceholder")}
								onChange={(e) =>
									tl.updateAnnotationLive(region.id, {
										content: e.target.value,
									})
								}
								onBlur={commitAnnotation}
								rows={2}
								style={{
									resize: "vertical",
									padding: "8px 10px",
									borderRadius: 9,
									border: "1px solid var(--border)",
									background: "var(--surface)",
									color: "var(--fg)",
									font: "500 13px var(--font-display)",
								}}
							/>
						</div>
					) : null}
					{region.type === "image" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							{/* Read as a data URL, which is what the renderer expects: `content` holds
							    "Separate storage for image data URL" (types.ts) and both the preview
							    overlay and the compositor read it from there. */}
							<label
								style={{
									...secondaryBtnStyle,
									textAlign: "center",
									cursor: "pointer",
								}}
								htmlFor={`ann-img-${region.id}`}
							>
								{ts("annotation.uploadImage")}
							</label>
							<input
								id={`ann-img-${region.id}`}
								type="file"
								accept="image/jpeg,image/png,image/gif,image/webp"
								style={{ display: "none" }}
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (!file) return;
									if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
										toast.error(ts("annotation.imageFormatsOnly"));
										return;
									}
									const reader = new FileReader();
									reader.onload = () => {
										tl.updateAnnotationLive(region.id, {
											content: String(reader.result),
										});
										void tl.commitAnnotationChange();
										toast.success(ts("annotation.imageUploadSuccess"));
									};
									reader.readAsDataURL(file);
								}}
							/>
							<span
								style={{
									font: "400 11px/1.4 var(--font-sans)",
									color: "var(--fg-2)",
								}}
							>
								{ts("annotation.supportedFormats")}
							</span>
						</div>
					) : null}
					{region.type === "figure" ? (
						<>
							{paneRow(
								ts("annotation.arrowDirection"),
								<AppSelect
									value={region.figureData?.arrowDirection ?? "right"}
									onChange={(e) => {
										tl.updateAnnotationLive(region.id, {
											figureData: {
												...(region.figureData ?? {
													color: "#34B27B",
													strokeWidth: 4,
												}),
												arrowDirection: e.target.value as ArrowDirectionKind,
											},
										});
										void tl.commitAnnotationChange();
									}}
									style={selectStyle}
								>
									{ARROW_DIRECTIONS.map((d) => (
										<option key={d} value={d}>
											{d}
										</option>
									))}
								</AppSelect>,
							)}
							{paneRow(
								ts("annotation.arrowColor"),
								<ColorField
									label={ts("annotation.arrowColor")}
									value={region.figureData?.color ?? "#34B27B"}
									onChange={(next) =>
										liveUpdate(region.id, {
											figureData: {
												...(region.figureData ?? {
													arrowDirection: "right",
													strokeWidth: 4,
												}),
												color: next,
											},
										})
									}
									onCommit={commitAnnotation}
								/>,
							)}
							<SliderCell
								label={ts("annotation.strokeWidth", {
									width: region.figureData?.strokeWidth ?? 4,
								})}
								value={region.figureData?.strokeWidth ?? 4}
								min={1}
								max={20}
								onChange={(next) =>
									tl.updateAnnotationLive(region.id, {
										figureData: {
											...(region.figureData ?? {
												arrowDirection: "right",
												color: "#34B27B",
											}),
											strokeWidth: next,
										},
									})
								}
								onCommit={() => void tl.commitAnnotationChange()}
								// The translated label already includes the value, so do not repeat it.
								showValue={false}
								flat
							/>
						</>
					) : null}
					{region.type === "blur" ? (
						<>
							{paneRow(
								ts("annotation.blurType"),
								<AppSelect
									value={region.blurData?.type ?? "mosaic"}
									onChange={(e) => {
										tl.updateAnnotationLive(region.id, {
											blurData: {
												...(region.blurData ?? BLUR_DEFAULTS),
												type: e.target.value as "blur" | "mosaic",
											},
										});
										void tl.commitAnnotationChange();
									}}
									style={selectStyle}
								>
									<option value="blur">{ts("annotation.blurTypeBlur")}</option>
									<option value="mosaic">{ts("annotation.blurTypeMosaic")}</option>
								</AppSelect>,
							)}
							{paneRow(
								ts("annotation.blurShape"),
								<AppSelect
									value={region.blurData?.shape ?? "rectangle"}
									onChange={(e) => {
										tl.updateAnnotationLive(region.id, {
											blurData: {
												...(region.blurData ?? BLUR_DEFAULTS),
												shape: e.target.value as "rectangle" | "oval" | "freehand",
											},
										});
										void tl.commitAnnotationChange();
									}}
									style={selectStyle}
								>
									<option value="rectangle">{ts("annotation.blurShapeRectangle")}</option>
									<option value="oval">{ts("annotation.blurShapeOval")}</option>
									{/* New freehand regions are disabled because the compositor covers only their
									    bounding box. Keep the option visible for existing projects and explain the
									    export behavior instead of silently changing stored annotations. */}
									{region.blurData?.shape === "freehand" ? (
										<option value="freehand">{ts("annotation.blurShapeFreehand")}</option>
									) : null}
								</AppSelect>,
							)}
							{region.blurData?.shape === "freehand" ? (
								// Say it rather than let the user discover it: the compositor masks the
								// bounding box for a freehand shape, deliberately over-covering instead
								// of leaving anything the user marked private visible in the export.
								<p
									style={{
										margin: 0,
										font: "400 11px/1.45 var(--font-sans)",
										color: "var(--fg-2)",
									}}
								>
									{te("inspector.freehandRendersAsBox")}
								</p>
							) : null}
						</>
					) : null}
					{region.type === "text"
						? paneRow(
								ts("annotation.size"),
								<input
									type="number"
									min={8}
									max={200}
									step={1}
									// The value is pixels at 1080p. Preview and export both scale it by frame height.
									value={region.style?.fontSize ?? 32}
									onChange={(e) =>
										tl.updateAnnotationLive(region.id, {
											style: {
												...region.style,
												fontSize: Number(e.target.value),
											},
										})
									}
									onBlur={commitAnnotation}
									style={{ ...selectStyle, width: 84, textAlign: "right" }}
								/>,
							)
						: null}
					{region.type === "text"
						? paneRow(
								ts("annotation.background"),
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									{/* Keep the stored color visible while the background is off. That is the
									    color which returns when the user turns the background on again. */}
									<ColorField
										label={ts("annotation.background")}
										value={textBackgroundColor(region.style)}
										onChange={(next) =>
											liveUpdate(region.id, {
												style: setTextBackgroundColor(region.style, next),
											})
										}
										onCommit={commitAnnotation}
									/>
									<Toggle
										checked={hasBackground}
										label={ts("annotation.background")}
										onChange={(next) => {
											tl.updateAnnotationLive(region.id, {
												style: toggleTextBackground(region.style, next),
											});
											void tl.commitAnnotationChange();
										}}
									/>
								</div>,
							)
						: null}
					{region.type === "text" || region.type === "image"
						? paneRow(
								ts("textAnimation.title"),
								// The schema, translations, and compositor already support all seven animations.
								<AppSelect
									aria-label={ts("textAnimation.selectAnimation")}
									value={region.style?.textAnimation ?? "none"}
									onChange={(e) => {
										tl.updateAnnotationLive(region.id, {
											style: {
												...region.style,
												textAnimation: e.target.value as AnnotationTextAnimation,
											},
										});
										void tl.commitAnnotationChange();
									}}
									style={selectStyle}
								>
									{TEXT_ANIMATION_VALUES.map((value) => (
										<option key={value} value={value}>
											{ts(`textAnimation.${value === "slide-left" ? "slideLeft" : value}`)}
										</option>
									))}
								</AppSelect>,
							)
						: null}
					{region.type === "text"
						? paneRow(
								ts("annotation.color"),
								<ColorField
									label={ts("annotation.color")}
									value={region.style?.color ?? "#ffffff"}
									onChange={(next) =>
										liveUpdate(region.id, {
											style: { ...region.style, color: next },
										})
									}
									onCommit={commitAnnotation}
								/>,
							)
						: null}
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						{ts("annotation.deleteAnnotation")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "cameraFullscreen") {
		const region = tl.cameraFullscreenRegions.find((c) => c.id === selection.id);
		if (!region) return null;
		const isEmphasis = region.mode === "emphasis";
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(
					<Maximize2 size={15} />,
					isEmphasis ? tt("labels.cameraEmphasis") : tt("labels.cameraFullscreen"),
					onClose,
					tc("actions.close"),
				)}
				<div style={bodyStyle}>
					<p
						style={{
							margin: 0,
							fontSize: 12,
							lineHeight: 1.5,
							color: "var(--muted)",
						}}
					>
						{isEmphasis
							? te("inspector.cameraEmphasisDescription")
							: te("inspector.cameraFullscreenDescription")}
					</p>
					{paneRow(
						ts("motion.title"),
						<AppSelect
							value={region.motionStyle ?? DEFAULT_CAMERA_MOTION_STYLE}
							onChange={(e) =>
								void tl.updateCameraMotionStyle(region.id, e.target.value as MotionStyle)
							}
							style={selectStyle}
						>
							{MOTION_STYLE_VALUES.map((style) => (
								<option key={style} value={style}>
									{ts(`motion.${style}`)}
								</option>
							))}
						</AppSelect>,
					)}
					{isEmphasis &&
						paneRow(
							te("inspector.cameraSize"),
							<AppSelect
								value={String(region.cameraScale ?? DEFAULT_CAMERA_EMPHASIS_SCALE)}
								onChange={(e) => void tl.updateCameraScale(region.id, Number(e.target.value))}
								style={selectStyle}
							>
								{cameraScaleOptions(region.cameraScale).map((scale) => (
									<option key={scale} value={String(scale)}>
										{scale.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×
									</option>
								))}
							</AppSelect>,
						)}
					{paneRow(
						ts("motion.speed"),
						<AppSelect
							value={normalizeMotionSpeed(region.motionSpeed)}
							disabled={region.motionStyle === "instant"}
							onChange={(e) => void tl.updateCameraMotionSpeed(region.id, Number(e.target.value))}
							style={
								region.motionStyle === "instant"
									? { ...selectStyle, opacity: 0.5, cursor: "not-allowed" }
									: selectStyle
							}
						>
							{MOTION_SPEED_VALUES.map((speed) => (
								<option key={speed} value={speed}>
									{speed}×
								</option>
							))}
						</AppSelect>,
					)}
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						{te("inspector.deleteRegion")}
					</button>
				</div>
			</div>
		);
	}

	// trim — a trim ventilated across a clip boundary is 2+ DSL rows that render
	// as one coalesced pill (see V4Timeline's trimPills), so the DURATION shown has to be
	// the group's, not the clicked row's. Deleting no longer needs the same expansion here:
	// `removeRegion` drops the whole pill for every kind (`dropTrimPillsByIds`), which is
	// what this pane used to have to arrange for itself.
	const trimGroup = coalescedTrimGroups(tl.trimRanges, tl.clips).find((g) =>
		g.ids.includes(selection.id),
	);
	if (!trimGroup) return null;
	const durationSec = Math.max(0, trimGroup.end - trimGroup.start);
	const deleteTrimGroup = () => {
		void tl.removeRegion("trim", selection.id);
		onClose();
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
			{paneHeader(<Scissors size={15} />, tt("labels.trim"), onClose, tc("actions.close"))}
			<div style={bodyStyle}>
				<p
					style={{
						margin: 0,
						fontSize: 12,
						lineHeight: 1.5,
						color: "var(--muted)",
					}}
				>
					{te("inspector.trimHiddenDuration", {
						duration: durationSec.toFixed(1),
					})}
				</p>
				<button type="button" onClick={deleteTrimGroup} style={deleteBtnStyle}>
					<Trash2 size={14} />
					{te("inspector.restoreDeleteTrim")}
				</button>
			</div>
		</div>
	);
}

const selectStyle: React.CSSProperties = {
	height: 34,
	padding: "0 9px",
	borderRadius: 8,
	border: "1px solid transparent",
	background: "var(--surface-2)",
	color: "var(--fg)",
	font: "500 12px var(--font-body)",
};

const secondaryBtnStyle: React.CSSProperties = {
	alignSelf: "flex-start",
	padding: "7px 10px",
	borderRadius: 8,
	border: "1px solid var(--border-soft)",
	background: "var(--surface-2)",
	color: "var(--fg-2)",
	font: "500 12px var(--font-body)",
	cursor: "pointer",
};

const advancedStyle: React.CSSProperties = {
	borderTop: "1px solid var(--border-soft)",
	paddingTop: 12,
};

const advancedSummaryStyle: React.CSSProperties = {
	cursor: "pointer",
	font: "600 12px var(--font-display)",
	color: "var(--fg-2)",
};

const advancedBodyStyle: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 14,
	paddingTop: 14,
};

function FacetBody({
	facet,
	onCollapse,
	transcriptProps,
	onPausePreview,
	onAdjustAutomatic,
}: {
	facet: Facet;
	onCollapse: () => void;
	transcriptProps: TranscriptProps;
	onPausePreview: (suggestions: SelectablePauseSuggestion[] | null) => void;
	onAdjustAutomatic: (member: { kind: "zoom" | "cameraFullscreen"; id: string }) => void;
}) {
	const te = useScopedT("editor");
	// A small collapse affordance floated over the reused pane header.
	const collapse = (
		<button
			type="button"
			title={te("inspector.collapseInspector")}
			aria-label={te("inspector.collapseInspector")}
			onClick={onCollapse}
			className={styles.inspectorCollapseButton}
		>
			<ChevronRight size={15} />
		</button>
	);

	if (facet === "background") return wrap(collapse, <BackgroundPane />);
	if (facet === "effects") return wrap(collapse, <VideoEffectsPane />);
	if (facet === "layout") return wrap(collapse, <LayoutPane />);
	if (facet === "cursor") return wrap(collapse, <CursorPane />);
	if (facet === "audio") {
		return wrap(collapse, <AudioPane onPreview={onPausePreview} />);
	}
	if (facet === "automatic")
		return wrap(
			collapse,
			<AutomaticDirectionPane onSeek={transcriptProps.onSeek} onAdjust={onAdjustAutomatic} />,
		);
	if (facet === "transcript") return wrap(collapse, <TranscriptPane {...transcriptProps} />);
	return wrap(collapse, <CaptionsPane />);
}

function wrap(collapse: React.ReactNode, body: React.ReactNode) {
	return (
		<div className={styles.inspectorPaneHost}>
			{collapse}
			{body}
		</div>
	);
}

/** Library-owned keyboard navigation; an empty value represents a collapsed/selection inspector. */
export function FacetNavigation({
	value,
	disabled,
	pauseAnalysisRunning,
	onValueChange,
}: {
	value: Facet | "";
	disabled: boolean;
	pauseAnalysisRunning: boolean;
	onValueChange: (value: Facet | "") => void;
}) {
	const ts = useScopedT("settings");
	return (
		<ToggleGroupPrimitive.Root
			type="single"
			orientation="vertical"
			value={value}
			disabled={disabled}
			className={styles.facetRailScroll}
			aria-label={ts("facets.navigation")}
			onValueChange={(next) => {
				if (next === "") onValueChange("");
				else {
					const facet = FACETS.find((item) => item.id === next);
					if (facet) onValueChange(facet.id);
				}
			}}
		>
			{FACETS.map(({ id, labelKey, icon: Icon }) => {
				const busy = id === "audio" && pauseAnalysisRunning;
				const label = busy ? `${ts(labelKey)} — ${ts("pauses.analyzing")}` : ts(labelKey);
				return (
					<ToggleGroupPrimitive.Item key={id} value={id} title={label} aria-label={label}>
						<Icon size={17} aria-hidden />
						<span className={styles.facetLabel}>{ts(labelKey)}</span>
						{busy ? (
							<Loader2
								className={`${styles.facetBusyIndicator} animate-spin`}
								size={10}
								aria-hidden
							/>
						) : null}
					</ToggleGroupPrimitive.Item>
				);
			})}
		</ToggleGroupPrimitive.Root>
	);
}
