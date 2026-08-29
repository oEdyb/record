import type { ExportQuality, ExportVideoCodec } from "./types";

export interface Mp4ExportSettings {
	width: number;
	height: number;
	bitrate: number;
}

interface ExportDurationClip {
	sourceStartSec: number;
	sourceEndSec: number;
}

interface ExportSpeedRegion {
	startSec: number;
	endSec: number;
	speed: number;
	clipIndex?: number | null;
}

const AAC_AUDIO_BITRATE = 384_000;
const MP4_CONTAINER_OVERHEAD = 1.02;
const SOURCE_QUALITY_HEADROOM = 1.25;
const HIGH_FRAME_RATE_HEADROOM = 1.5;
const H265_BITRATE_FACTOR = 0.6;

// YouTube's SDR H.264 upload recommendations at 24–30 FPS. Interpolation keeps
// custom and portrait canvases from jumping between coarse resolution buckets.
const H264_BITRATE_ANCHORS = [
	{ pixels: 854 * 480, bitrate: 2_500_000 },
	{ pixels: 1280 * 720, bitrate: 5_000_000 },
	{ pixels: 1920 * 1080, bitrate: 8_000_000 },
	{ pixels: 2560 * 1440, bitrate: 16_000_000 },
	{ pixels: 3840 * 2160, bitrate: 45_000_000 },
	{ pixels: 7680 * 4320, bitrate: 160_000_000 },
] as const;

interface SourceCropRegion {
	width: number;
	height: number;
}

interface Dims {
	width: number;
	height: number;
}

/**
 * Would rendering a `source`-sized clip into an `output`-sized frame stretch it past its own
 * resolution?
 *
 * The clip is CONTAIN-fitted into the output frame, so the answer is that fit scale — not a
 * comparison of short sides, which counts letterbox rows as if they were stretched pixels. A
 * 1920x1032 window capture in a 16:9 project gives a 1920x1080 frame whose 48 extra rows are
 * wallpaper, at scale 1.0: nothing is upscaled. The short-side test called that frame an
 * upscale under the "1080p" tier while "Source" produced the exact same frame unflagged.
 */
export function wouldUpscale(output: Dims, source: Dims): boolean {
	return Math.min(output.width / source.width, output.height / source.height) > 1;
}

const MEDIUM_SHORT_SIDE = 1080;
const HIGH_SHORT_SIDE = 1440;

function even(value: number) {
	return Math.floor(value / 2) * 2;
}

function evenUp(value: number) {
	return Math.ceil(value / 2) * 2;
}

function atLeastEven(value: number) {
	return Math.max(2, even(value));
}

export function calculateEffectiveSourceDimensions(
	sourceWidth: number,
	sourceHeight: number,
	cropRegion?: SourceCropRegion,
) {
	const cropWidth = cropRegion?.width ?? 1;
	const cropHeight = cropRegion?.height ?? 1;

	return {
		width: atLeastEven(Math.round(sourceWidth * cropWidth)),
		height: atLeastEven(Math.round(sourceHeight * cropHeight)),
	};
}

function calculateDimensionsForShortSide(targetShortSide: number, aspectRatioValue: number) {
	if (aspectRatioValue >= 1) {
		const height = even(targetShortSide);
		return {
			width: even(height * aspectRatioValue),
			height,
		};
	}

	const width = even(targetShortSide);
	return {
		width,
		height: even(width / aspectRatioValue),
	};
}

function calculateSourceDimensions(
	sourceWidth: number,
	sourceHeight: number,
	aspectRatioValue: number,
) {
	const width = Math.max(2, sourceWidth);
	const height = Math.max(2, sourceHeight);
	const sourceAspectRatio = width / height;

	// Highest is source-preserving. Change only the canvas dimension needed to fit the
	// selected aspect ratio, then CONTAIN-fit the unscaled source over the background.
	if (aspectRatioValue >= sourceAspectRatio) {
		return {
			width: evenUp(height * aspectRatioValue),
			height: evenUp(height),
		};
	}

	return {
		width: evenUp(width),
		height: evenUp(width / aspectRatioValue),
	};
}

function interpolateH264Bitrate(totalPixels: number): number {
	const first = H264_BITRATE_ANCHORS[0];
	if (totalPixels <= first.pixels) {
		return first.bitrate * Math.max(0.4, totalPixels / first.pixels);
	}

	for (let index = 1; index < H264_BITRATE_ANCHORS.length; index += 1) {
		const lower = H264_BITRATE_ANCHORS[index - 1];
		const upper = H264_BITRATE_ANCHORS[index];
		if (totalPixels <= upper.pixels) {
			const position = (totalPixels - lower.pixels) / (upper.pixels - lower.pixels);
			return lower.bitrate + (upper.bitrate - lower.bitrate) * position;
		}
	}

	const last = H264_BITRATE_ANCHORS.at(-1)!;
	return last.bitrate * (totalPixels / last.pixels);
}

function calculateBitrate(
	width: number,
	height: number,
	quality: ExportQuality,
	fps: number,
	codec: ExportVideoCodec,
) {
	const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
	const frameRateFactor =
		safeFps > 30 ? 1 + ((safeFps - 30) / 30) * (HIGH_FRAME_RATE_HEADROOM - 1) : 1;
	const qualityFactor = quality === "source" ? SOURCE_QUALITY_HEADROOM : 1;
	const codecFactor = codec === "h265" ? H265_BITRATE_FACTOR : 1;
	const bitrate =
		interpolateH264Bitrate(Math.max(1, width * height)) *
		frameRateFactor *
		qualityFactor *
		codecFactor;

	return Math.min(200_000_000, Math.max(1_000_000, Math.round(bitrate / 100_000) * 100_000));
}

/**
 * Matches the native timeline walk's output-duration math. Speed regions are in source time
 * and can belong to one clip. When old data omits clipIndex, the region applies to every
 * overlapping clip, which is the native compatibility rule too.
 */
export function calculateEffectiveExportDuration(
	clips: ExportDurationClip[],
	speedRegions: ExportSpeedRegion[] = [],
): number {
	return clips.reduce((total, clip, clipIndex) => {
		const start = Math.max(0, clip.sourceStartSec);
		const end = Math.max(start, clip.sourceEndSec);
		const regions = speedRegions
			.filter(
				(region) =>
					(region.clipIndex == null || region.clipIndex === clipIndex) &&
					region.startSec < end &&
					region.endSec > start,
			)
			.sort((a, b) => a.startSec - b.startSec);

		let duration = 0;
		let cursor = start;
		for (const region of regions) {
			const regionStart = Math.max(start, region.startSec, cursor);
			const regionEnd = Math.min(end, region.endSec);
			if (regionStart > cursor) duration += regionStart - cursor;
			if (regionEnd > regionStart) {
				const speed = Number.isFinite(region.speed) && region.speed > 0 ? region.speed : 1;
				duration += (regionEnd - regionStart) / speed;
				cursor = regionEnd;
			}
		}
		if (cursor < end) duration += end - cursor;
		return total + duration;
	}, 0);
}

/** A bitrate-based estimate. The native MP4 pipeline adds 384 kbps AAC when audio exists. */
export function estimateMp4FileSizeBytes({
	durationSec,
	videoBitrate,
	hasAudio,
}: {
	durationSec: number;
	videoBitrate: number;
	hasAudio: boolean;
}): number {
	if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
	if (!Number.isFinite(videoBitrate) || videoBitrate <= 0) return 0;
	const totalBitrate = videoBitrate + (hasAudio ? AAC_AUDIO_BITRATE : 0);
	return Math.ceil((totalBitrate * durationSec * MP4_CONTAINER_OVERHEAD) / 8);
}

/** Conservative indexed-colour GIF estimate used by GUI, CLI, and main-process preflight. */
export function estimateGifFileSizeBytes({
	durationSec,
	width,
	height,
	fps,
}: {
	durationSec: number;
	width: number;
	height: number;
	fps: number;
}): number {
	if (![durationSec, width, height, fps].every((value) => Number.isFinite(value) && value > 0)) {
		return 0;
	}
	return Math.ceil(durationSec * width * height * fps * 0.35);
}

export function formatBitrate(bitrate: number): string {
	if (!Number.isFinite(bitrate) || bitrate <= 0) return "—";
	return `${Number((bitrate / 1_000_000).toFixed(1))} Mbps`;
}

/** A compact clock for a remaining-time label: m:ss below one hour, then h:mm:ss. */
export function formatExportEta(totalSeconds: number): string {
	const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.ceil(totalSeconds)) : 0;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder
			.toString()
			.padStart(2, "0")}`;
	}
	return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

/** Export an exact, user-selected canvas size with the same bitrate policy as the presets. */
export function calculateMp4ExportSettingsForResolution({
	quality,
	width,
	height,
	fps = 30,
	codec = "h264",
}: {
	quality: ExportQuality;
	width: number;
	height: number;
	fps?: number;
	codec?: ExportVideoCodec;
}): Mp4ExportSettings {
	const dimensions = {
		width: atLeastEven(width),
		height: atLeastEven(height),
	};
	return {
		...dimensions,
		bitrate: calculateBitrate(dimensions.width, dimensions.height, quality, fps, codec),
	};
}

export function calculateMp4ExportSettings({
	quality,
	sourceWidth,
	sourceHeight,
	aspectRatioValue,
	fps = 30,
	codec = "h264",
}: {
	quality: ExportQuality;
	sourceWidth: number;
	sourceHeight: number;
	aspectRatioValue: number;
	fps?: number;
	codec?: ExportVideoCodec;
}): Mp4ExportSettings {
	if (quality === "medium") {
		const dimensions = calculateDimensionsForShortSide(MEDIUM_SHORT_SIDE, aspectRatioValue);
		return {
			...dimensions,
			bitrate: calculateBitrate(dimensions.width, dimensions.height, quality, fps, codec),
		};
	}

	if (quality === "good") {
		const dimensions = calculateDimensionsForShortSide(HIGH_SHORT_SIDE, aspectRatioValue);
		return {
			...dimensions,
			bitrate: calculateBitrate(dimensions.width, dimensions.height, quality, fps, codec),
		};
	}

	const sourceDimensions = calculateSourceDimensions(sourceWidth, sourceHeight, aspectRatioValue);
	return {
		...sourceDimensions,
		bitrate: calculateBitrate(sourceDimensions.width, sourceDimensions.height, quality, fps, codec),
	};
}
