import type { ExportParamsInput } from "../native/compositor-view/addon";

/** Level 5.2, the highest H.264 level: 36,864 macroblocks per frame (4096×2304).
 * Apple's H.264 encoders refuse larger frames; their HEVC encoders go to 8K. */
const H264_MAX_MACROBLOCKS = 36_864;

export function exceedsH264FrameLimit(width: number, height: number): boolean {
	return Math.ceil(width / 16) * Math.ceil(height / 16) > H264_MAX_MACROBLOCKS;
}

/** The codec a rendered export actually encodes with. A 5K or 6K source-sized
 * export asked for as H.264 is encoded as HEVC instead of failing to start. */
export function renderedExportCodec(params: ExportParamsInput | undefined): "h264" | "h265" {
	if (params?.codec === "h265") return "h265";
	const width = Math.max(2, params?.width ?? 1920) & ~1;
	const height = Math.max(2, params?.height ?? 1080) & ~1;
	return exceedsH264FrameLimit(width, height) ? "h265" : "h264";
}
