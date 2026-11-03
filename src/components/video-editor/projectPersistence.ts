import {
	normalizeWebcamAspectRatio,
	normalizeWebcamCornerRadius,
	type WebcamAspectRatio,
} from "@/components/video-editor/types";
import { directionProvenanceFields } from "@/lib/ai-edition/schema/automatic-direction-review";
import { normalizeTextAnimation } from "@/lib/annotationTextAnimation";
import { normalizeBlurColor, normalizeBlurType } from "@/lib/blurEffects";
import {
	MAX_WEBCAM_BLOCK_CAMERA_SHARE,
	MAX_WEBCAM_SIZE_PERCENT,
	MIN_WEBCAM_BLOCK_CAMERA_SHARE,
	MIN_WEBCAM_SIZE_PERCENT,
} from "@/lib/compositeLayout";
import { normalizeCursorThemeId } from "@/lib/cursor/cursorThemes";
import type { ExportFormat, ExportQuality, GifFrameRate, GifSizePreset } from "@/lib/exporter";
import { fromKlipptMediaUrl, toKlipptMediaUrl } from "@/lib/localMediaUrl";
import type { ProjectMedia } from "@/lib/recordingSession";
import { normalizeProjectMedia } from "@/lib/recordingSession";
import { DEFAULT_WALLPAPER, WALLPAPER_PATHS } from "@/lib/wallpaper";
import { isMotionSpeed, isMotionStyle } from "@/lib/zoomMath/motionCurve";
import { type AspectRatio, isAspectRatio, isPortraitAspectRatio } from "@/utils/aspectRatioUtils";
import { clamp } from "@/utils/math";
import {
	DEFAULT_EDITOR_APPEARANCE_SETTINGS,
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
	DEFAULT_GIF_SETTINGS,
	DEFAULT_WEBCAM_SETTINGS,
} from "./editorDefaults";
import {
	type AnnotationRegion,
	type CameraFullscreenRegion,
	type CropRegion,
	clampPlaybackSpeed,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_BLUR_BLOCK_SIZE,
	DEFAULT_BLUR_DATA,
	DEFAULT_BLUR_FREEHAND_POINTS,
	DEFAULT_BLUR_INTENSITY,
	DEFAULT_FIGURE_DATA,
	DEFAULT_PLAYBACK_SPEED,
	DEFAULT_WEBCAM_FOCAL_POINT,
	DEFAULT_WEBCAM_MIRRORED,
	DEFAULT_WEBCAM_REACTIVE_ZOOM,
	DEFAULT_WEBCAM_ZOOM,
	DEFAULT_ZOOM_DEPTH,
	DEFAULT_ZOOM_MOTION_BLUR,
	MAX_BLUR_BLOCK_SIZE,
	MAX_BLUR_INTENSITY,
	MAX_PLAYBACK_SPEED,
	MAX_WEBCAM_ZOOM,
	MIN_BLUR_BLOCK_SIZE,
	MIN_BLUR_INTENSITY,
	MIN_PLAYBACK_SPEED,
	MIN_WEBCAM_ZOOM,
	type SpeedRegion,
	type TrimRegion,
	type WebcamBlockCameraShare,
	type WebcamBlockOrder,
	type WebcamFocalPoint,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type WebcamPosition,
	type WebcamSizePreset,
	type WebcamZoom,
	type ZoomRegion,
} from "./types";

const VALID_BLUR_SHAPES = new Set(["rectangle", "oval", "freehand"] as const);

// Old projects persisted machine-specific file:// URLs for bundled wallpapers.
// Match only the known install layouts (packaged resources/[assets/]wallpapers,
// dev public/wallpapers) so a user's own file under some "wallpapers" folder isn't
// silently replaced.
const LEGACY_FILE_WALLPAPER_RE =
	/^file:\/\/.*?\/(?:resources\/(?:assets\/)?|public\/)wallpapers\/(wallpaper\d+\.jpg)$/i;
const CANONICAL_WALLPAPERS = new Set(WALLPAPER_PATHS);

function normalizeWallpaperValue(value: string): string {
	const match = LEGACY_FILE_WALLPAPER_RE.exec(value);
	if (!match) return value;
	const canonical = `/wallpapers/${match[1]}`;
	return CANONICAL_WALLPAPERS.has(canonical) ? canonical : DEFAULT_WALLPAPER;
}

export const PROJECT_VERSION = 2;

export interface ProjectEditorState {
	wallpaper: string;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	borderRadius: number;
	padding: number;
	cropRegion: CropRegion;
	zoomRegions: ZoomRegion[];
	cameraFullscreenRegions: CameraFullscreenRegion[];
	autoZoomEnabled: boolean;
	autoFocusAll: boolean;
	trimRegions: TrimRegion[];
	speedRegions: SpeedRegion[];
	annotationRegions: AnnotationRegion[];
	aspectRatio: AspectRatio;
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamBlockOrder: WebcamBlockOrder;
	webcamBlockCameraShare: WebcamBlockCameraShare;
	webcamMaskShape: WebcamMaskShape;
	webcamCornerRadius?: number;
	webcamAspectRatio?: WebcamAspectRatio;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: WebcamSizePreset;
	webcamZoom: WebcamZoom;
	webcamFocalPoint: WebcamFocalPoint;
	webcamPosition: WebcamPosition | null;
	exportQuality: ExportQuality;
	exportFormat: ExportFormat;
	gifFrameRate: GifFrameRate;
	gifLoop: boolean;
	gifSizePreset: GifSizePreset;
	cursorTheme: string;
}

export interface EditorProjectData {
	version: number;
	media?: ProjectMedia;
	editor: ProjectEditorState;
	videoPath?: string;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function computeNormalizedWebcamLayoutPreset(
	webcamLayoutPreset: Partial<ProjectEditorState>["webcamLayoutPreset"],
	normalizedAspectRatio: AspectRatio,
): WebcamLayoutPreset {
	switch (webcamLayoutPreset) {
		case "picture-in-picture":
		case "no-webcam":
			return webcamLayoutPreset;
		case "vertical-stack":
			return isPortraitAspectRatio(normalizedAspectRatio)
				? webcamLayoutPreset
				: DEFAULT_WEBCAM_SETTINGS.layoutPreset;
		case "dual-frame":
			return isPortraitAspectRatio(normalizedAspectRatio)
				? DEFAULT_WEBCAM_SETTINGS.layoutPreset
				: webcamLayoutPreset;
		default:
			return DEFAULT_WEBCAM_SETTINGS.layoutPreset;
	}
}

export function toFileUrl(filePath: string): string {
	// Browser-mode assets are already usable. Local paths use the main-process
	// allowlist instead of exposing Chromium's unrestricted file:// loader.
	if (/^(https?|blob|data|klippt):/.test(filePath)) {
		return filePath;
	}
	return toKlipptMediaUrl(fromFileUrl(filePath));
}

/** A literal `%` in a saved path is not an escape; keep it instead of throwing. */
function decodeFilePath(encodedPath: string): string {
	try {
		return decodeURIComponent(encodedPath);
	} catch {
		return encodedPath.replace(/(?:%[0-9a-fA-F]{2})+/g, (escaped) => {
			try {
				return decodeURIComponent(escaped);
			} catch {
				return escaped;
			}
		});
	}
}

function fromFileUrl(fileUrl: string): string {
	const protocolPath = fromKlipptMediaUrl(fileUrl);
	if (protocolPath !== null) {
		return protocolPath;
	}
	if (!fileUrl.startsWith("file://")) {
		return fileUrl;
	}

	try {
		const url = new URL(fileUrl);
		const pathname = decodeFilePath(url.pathname);

		if (url.host && url.host !== "localhost") {
			return `//${url.host}${pathname}`;
		}

		if (/^\/[a-zA-Z]:/.test(pathname)) {
			return pathname.slice(1);
		}

		return pathname;
	} catch {
		const fallbackPath = decodeFilePath(fileUrl.replace(/^file:\/\//, ""));
		return fallbackPath.replace(/^\/([a-zA-Z]:)/, "$1");
	}
}

export function validateProjectData(candidate: unknown): candidate is EditorProjectData {
	if (!candidate || typeof candidate !== "object") return false;
	const project = candidate as Partial<EditorProjectData>;
	if (typeof project.version !== "number") return false;
	if (!resolveProjectMedia(project)) return false;
	if (!project.editor || typeof project.editor !== "object") return false;
	return true;
}

export function resolveProjectMedia(
	candidate: Partial<EditorProjectData> | { media?: unknown; videoPath?: unknown },
): ProjectMedia | null {
	const media = normalizeProjectMedia(candidate.media);
	if (media) {
		return media;
	}

	if (typeof candidate.videoPath === "string" && candidate.videoPath.trim()) {
		return { screenVideoPath: candidate.videoPath };
	}

	return null;
}

export function normalizeProjectEditor(editor: Partial<ProjectEditorState>): ProjectEditorState {
	// Any well-formed "W:H" is valid, not just the presets — the ratio picker also stores the
	// clips' own native shapes ("Original"), which can be e.g. "64:27". A membership test against
	// the preset list would silently reset those projects to 16:9 on load.
	const normalizedAspectRatio: AspectRatio = isAspectRatio(editor.aspectRatio)
		? editor.aspectRatio
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio;
	const normalizedWebcamLayoutPreset = computeNormalizedWebcamLayoutPreset(
		editor.webcamLayoutPreset,
		normalizedAspectRatio,
	);
	const normalizedWebcamPosition: WebcamPosition | null =
		normalizedWebcamLayoutPreset === "picture-in-picture" &&
		editor.webcamPosition &&
		typeof editor.webcamPosition === "object" &&
		isFiniteNumber((editor.webcamPosition as WebcamPosition).cx) &&
		isFiniteNumber((editor.webcamPosition as WebcamPosition).cy)
			? {
					cx: clamp((editor.webcamPosition as WebcamPosition).cx, 0, 1),
					cy: clamp((editor.webcamPosition as WebcamPosition).cy, 0, 1),
				}
			: DEFAULT_WEBCAM_SETTINGS.position;
	const normalizedWebcamFocalPoint: WebcamFocalPoint =
		editor.webcamFocalPoint &&
		typeof editor.webcamFocalPoint === "object" &&
		isFiniteNumber(editor.webcamFocalPoint.cx) &&
		isFiniteNumber(editor.webcamFocalPoint.cy)
			? {
					cx: clamp(editor.webcamFocalPoint.cx, 0, 1),
					cy: clamp(editor.webcamFocalPoint.cy, 0, 1),
				}
			: DEFAULT_WEBCAM_FOCAL_POINT;

	const normalizedZoomRegions: ZoomRegion[] = Array.isArray(editor.zoomRegions)
		? editor.zoomRegions
				.filter((region): region is ZoomRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);

					const validPreset =
						region.rotationPreset === "iso" ||
						region.rotationPreset === "left" ||
						region.rotationPreset === "right"
							? region.rotationPreset
							: undefined;
					return {
						id: region.id,
						startMs,
						endMs,
						depth: [1, 2, 3, 4, 5, 6].includes(region.depth) ? region.depth : DEFAULT_ZOOM_DEPTH,
						focus: {
							cx: clamp(isFiniteNumber(region.focus?.cx) ? region.focus.cx : 0.5, 0, 1),
							cy: clamp(isFiniteNumber(region.focus?.cy) ? region.focus.cy : 0.5, 0, 1),
						},
						focusMode: region.focusMode === "auto" ? "auto" : "manual",
						source: region.source === "auto" ? "auto" : "manual",
						...(isFiniteNumber(region.customScale)
							? { customScale: clamp(region.customScale, 1, 5) }
							: {}),
						...(isMotionStyle(region.motionStyle) ? { motionStyle: region.motionStyle } : {}),
						...(isMotionSpeed(region.motionSpeed) ? { motionSpeed: region.motionSpeed } : {}),
						...(validPreset ? { rotationPreset: validPreset } : {}),
						...directionProvenanceFields(region.automaticDirection),
						...(typeof region.directionGroupId === "string" && region.directionGroupId.length > 0
							? { directionGroupId: region.directionGroupId }
							: {}),
					};
				})
		: [];

	const normalizedCameraFullscreenRegions: CameraFullscreenRegion[] = Array.isArray(
		editor.cameraFullscreenRegions,
	)
		? editor.cameraFullscreenRegions
				.filter((region): region is CameraFullscreenRegion =>
					Boolean(region && typeof region.id === "string"),
				)
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);
					return {
						id: region.id,
						startMs,
						endMs,
						...(region.mode === "emphasis" ? { mode: "emphasis" as const } : {}),
						...(region.mode === "emphasis" && isFiniteNumber(region.cameraScale)
							? { cameraScale: clamp(region.cameraScale, 1, 1.6) }
							: {}),
						...(isMotionStyle(region.motionStyle) ? { motionStyle: region.motionStyle } : {}),
						...(isMotionSpeed(region.motionSpeed) ? { motionSpeed: region.motionSpeed } : {}),
						...(region.source === "auto" ? { source: "auto" as const } : {}),
						...directionProvenanceFields(region.automaticDirection),
						...(typeof region.directionGroupId === "string" && region.directionGroupId.length > 0
							? { directionGroupId: region.directionGroupId }
							: {}),
					};
				})
		: [];

	const normalizedTrimRegions: TrimRegion[] = Array.isArray(editor.trimRegions)
		? editor.trimRegions
				.filter((region): region is TrimRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);
					return {
						id: region.id,
						startMs,
						endMs,
					};
				})
		: [];

	const normalizedSpeedRegions: SpeedRegion[] = Array.isArray(editor.speedRegions)
		? editor.speedRegions
				.filter((region): region is SpeedRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);

					const speed =
						isFiniteNumber(region.speed) &&
						region.speed >= MIN_PLAYBACK_SPEED &&
						region.speed <= MAX_PLAYBACK_SPEED
							? clampPlaybackSpeed(region.speed)
							: DEFAULT_PLAYBACK_SPEED;

					return {
						id: region.id,
						startMs,
						endMs,
						speed,
					};
				})
		: [];

	const normalizedAnnotationRegions: AnnotationRegion[] = Array.isArray(editor.annotationRegions)
		? editor.annotationRegions
				.filter((region): region is AnnotationRegion =>
					Boolean(region && typeof region.id === "string"),
				)
				.map((region, index) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);
					const blurShape =
						typeof region.blurData?.shape === "string" &&
						VALID_BLUR_SHAPES.has(region.blurData.shape)
							? region.blurData.shape
							: DEFAULT_BLUR_DATA.shape;
					const blurType = normalizeBlurType(region.blurData?.type);
					const blurColor = normalizeBlurColor(region.blurData?.color);

					return {
						id: region.id,
						startMs,
						endMs,
						type:
							region.type === "image" || region.type === "figure" || region.type === "blur"
								? region.type
								: "text",
						content: typeof region.content === "string" ? region.content : "",
						textContent: typeof region.textContent === "string" ? region.textContent : undefined,
						imageContent: typeof region.imageContent === "string" ? region.imageContent : undefined,
						annotationSource:
							region.annotationSource === "auto-caption" ? ("auto-caption" as const) : undefined,
						position: {
							x: clamp(
								isFiniteNumber(region.position?.x)
									? region.position.x
									: DEFAULT_ANNOTATION_POSITION.x,
								0,
								100,
							),
							y: clamp(
								isFiniteNumber(region.position?.y)
									? region.position.y
									: DEFAULT_ANNOTATION_POSITION.y,
								0,
								100,
							),
						},
						size: {
							width: clamp(
								isFiniteNumber(region.size?.width)
									? region.size.width
									: DEFAULT_ANNOTATION_SIZE.width,
								1,
								200,
							),
							height: clamp(
								isFiniteNumber(region.size?.height)
									? region.size.height
									: DEFAULT_ANNOTATION_SIZE.height,
								1,
								200,
							),
						},
						style: {
							...DEFAULT_ANNOTATION_STYLE,
							...(region.style && typeof region.style === "object" ? region.style : {}),
							textAnimation: normalizeTextAnimation(region.style?.textAnimation),
						},
						zIndex: isFiniteNumber(region.zIndex) ? region.zIndex : index + 1,
						figureData: region.figureData
							? {
									...DEFAULT_FIGURE_DATA,
									...region.figureData,
								}
							: undefined,
						blurData:
							region.blurData && typeof region.blurData === "object"
								? {
										...DEFAULT_BLUR_DATA,
										...region.blurData,
										type: blurType,
										shape: blurShape,
										color: blurColor,
										intensity: isFiniteNumber(region.blurData.intensity)
											? clamp(region.blurData.intensity, MIN_BLUR_INTENSITY, MAX_BLUR_INTENSITY)
											: DEFAULT_BLUR_INTENSITY,
										blockSize: isFiniteNumber(region.blurData.blockSize)
											? clamp(region.blurData.blockSize, MIN_BLUR_BLOCK_SIZE, MAX_BLUR_BLOCK_SIZE)
											: DEFAULT_BLUR_BLOCK_SIZE,
										freehandPoints: Array.isArray(region.blurData.freehandPoints)
											? region.blurData.freehandPoints
													.filter(
														(
															point,
														): point is {
															x: number;
															y: number;
														} =>
															Boolean(
																point &&
																	isFiniteNumber((point as { x?: unknown }).x) &&
																	isFiniteNumber((point as { y?: unknown }).y),
															),
													)
													.map((point) => ({
														x: clamp(point.x, 0, 100),
														y: clamp(point.y, 0, 100),
													}))
											: DEFAULT_BLUR_FREEHAND_POINTS,
									}
								: undefined,
					};
				})
		: [];

	const rawCropX = isFiniteNumber(editor.cropRegion?.x)
		? editor.cropRegion.x
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.x;
	const rawCropY = isFiniteNumber(editor.cropRegion?.y)
		? editor.cropRegion.y
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.y;
	const rawCropWidth = isFiniteNumber(editor.cropRegion?.width)
		? editor.cropRegion.width
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.width;
	const rawCropHeight = isFiniteNumber(editor.cropRegion?.height)
		? editor.cropRegion.height
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.height;

	const cropX = clamp(rawCropX, 0, 1);
	const cropY = clamp(rawCropY, 0, 1);
	const cropWidth = clamp(rawCropWidth, 0.01, 1 - cropX);
	const cropHeight = clamp(rawCropHeight, 0.01, 1 - cropY);

	return {
		cursorTheme: normalizeCursorThemeId(editor.cursorTheme),
		wallpaper:
			typeof editor.wallpaper === "string"
				? normalizeWallpaperValue(editor.wallpaper)
				: DEFAULT_EDITOR_LAYOUT_SETTINGS.wallpaper,
		shadowIntensity:
			typeof editor.shadowIntensity === "number"
				? editor.shadowIntensity
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.shadowIntensity,
		showBlur:
			typeof editor.showBlur === "boolean"
				? editor.showBlur
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.showBlur,
		motionBlurAmount: isFiniteNumber(editor.motionBlurAmount)
			? clamp(editor.motionBlurAmount, 0, 1)
			: typeof (editor as { motionBlurEnabled?: unknown }).motionBlurEnabled === "boolean"
				? (editor as { motionBlurEnabled?: boolean }).motionBlurEnabled
					? DEFAULT_ZOOM_MOTION_BLUR
					: DEFAULT_EDITOR_APPEARANCE_SETTINGS.motionBlurAmount
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.motionBlurAmount,
		borderRadius:
			typeof editor.borderRadius === "number"
				? editor.borderRadius
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.borderRadius,
		padding: isFiniteNumber(editor.padding)
			? clamp(editor.padding, 0, 100)
			: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
		cropRegion: {
			x: cropX,
			y: cropY,
			width: cropWidth,
			height: cropHeight,
		},
		zoomRegions: normalizedZoomRegions,
		cameraFullscreenRegions: normalizedCameraFullscreenRegions,
		// Default on for legacy projects so re-opens match the new default. The
		// on-load auto-suggest pass is gated separately, so this won't add zooms.
		autoZoomEnabled: typeof editor.autoZoomEnabled === "boolean" ? editor.autoZoomEnabled : true,
		autoFocusAll: typeof editor.autoFocusAll === "boolean" ? editor.autoFocusAll : false,
		trimRegions: normalizedTrimRegions,
		speedRegions: normalizedSpeedRegions,
		annotationRegions: normalizedAnnotationRegions,
		aspectRatio: normalizedAspectRatio,
		webcamLayoutPreset: normalizedWebcamLayoutPreset,
		webcamBlockOrder:
			editor.webcamBlockOrder === "camera-first"
				? "camera-first"
				: DEFAULT_WEBCAM_SETTINGS.blockOrder,
		webcamBlockCameraShare:
			typeof editor.webcamBlockCameraShare === "number" &&
			isFiniteNumber(editor.webcamBlockCameraShare)
				? Math.max(
						MIN_WEBCAM_BLOCK_CAMERA_SHARE,
						Math.min(MAX_WEBCAM_BLOCK_CAMERA_SHARE, editor.webcamBlockCameraShare),
					)
				: DEFAULT_WEBCAM_SETTINGS.blockCameraShare,
		webcamMaskShape:
			editor.webcamMaskShape === "rectangle" ||
			editor.webcamMaskShape === "circle" ||
			editor.webcamMaskShape === "square" ||
			editor.webcamMaskShape === "rounded" ||
			editor.webcamMaskShape === "squircle"
				? editor.webcamMaskShape
				: DEFAULT_WEBCAM_SETTINGS.maskShape,
		webcamCornerRadius: normalizeWebcamCornerRadius(editor.webcamCornerRadius),
		webcamAspectRatio: normalizeWebcamAspectRatio(editor.webcamAspectRatio),
		webcamMirrored:
			typeof editor.webcamMirrored === "boolean" ? editor.webcamMirrored : DEFAULT_WEBCAM_MIRRORED,
		webcamReactiveZoom:
			typeof editor.webcamReactiveZoom === "boolean"
				? editor.webcamReactiveZoom
				: DEFAULT_WEBCAM_REACTIVE_ZOOM,
		webcamSizePreset:
			typeof editor.webcamSizePreset === "number" && isFiniteNumber(editor.webcamSizePreset)
				? Math.max(
						MIN_WEBCAM_SIZE_PERCENT,
						Math.min(MAX_WEBCAM_SIZE_PERCENT, editor.webcamSizePreset),
					)
				: DEFAULT_WEBCAM_SETTINGS.sizePreset,
		webcamZoom:
			typeof editor.webcamZoom === "number" && isFiniteNumber(editor.webcamZoom)
				? Math.max(MIN_WEBCAM_ZOOM, Math.min(MAX_WEBCAM_ZOOM, editor.webcamZoom))
				: DEFAULT_WEBCAM_ZOOM,
		webcamFocalPoint: normalizedWebcamFocalPoint,
		webcamPosition: normalizedWebcamPosition,
		exportQuality:
			editor.exportQuality === "medium" || editor.exportQuality === "source"
				? editor.exportQuality
				: DEFAULT_EXPORT_SETTINGS.quality,
		exportFormat: editor.exportFormat === "gif" ? "gif" : DEFAULT_EXPORT_SETTINGS.format,
		gifFrameRate:
			editor.gifFrameRate === 15 ||
			editor.gifFrameRate === 20 ||
			editor.gifFrameRate === 25 ||
			editor.gifFrameRate === 30
				? editor.gifFrameRate
				: DEFAULT_GIF_SETTINGS.frameRate,
		gifLoop: typeof editor.gifLoop === "boolean" ? editor.gifLoop : DEFAULT_GIF_SETTINGS.loop,
		gifSizePreset:
			editor.gifSizePreset === "medium" ||
			editor.gifSizePreset === "large" ||
			editor.gifSizePreset === "original"
				? editor.gifSizePreset
				: DEFAULT_GIF_SETTINGS.sizePreset,
	};
}

export function createProjectData(
	media: ProjectMedia,
	editor: ProjectEditorState,
): EditorProjectData {
	return {
		version: PROJECT_VERSION,
		media,
		editor,
	};
}

export function createProjectSnapshot(
	media: ProjectMedia,
	editor: Partial<ProjectEditorState>,
): string {
	return JSON.stringify(createProjectData(media, normalizeProjectEditor(editor)));
}

export function hasProjectUnsavedChanges(
	currentSnapshot: string | null,
	baselineSnapshot: string | null,
): boolean {
	return Boolean(
		currentSnapshot !== null && baselineSnapshot !== null && currentSnapshot !== baselineSnapshot,
	);
}
