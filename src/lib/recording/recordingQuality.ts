export type RecordingQuality = "high" | "standard";

export const DEFAULT_RECORDING_QUALITY: RecordingQuality = "high";
export const STANDARD_CAPTURE_BITRATE = 68_000_000;
export const HIGH_CAPTURE_BITRATE = 136_000_000;

export function normalizeRecordingQuality(value: unknown): RecordingQuality {
	return value === "standard" ? "standard" : DEFAULT_RECORDING_QUALITY;
}

/** Both profiles keep native pixels. H.264 keeps originals broadly compatible. */
export function recordingQualityBitrate(quality: RecordingQuality): number {
	return quality === "standard" ? STANDARD_CAPTURE_BITRATE : HIGH_CAPTURE_BITRATE;
}
