import type { ExportParamsInput } from "../native/compositor-view/addon";

/** Apple's H.264 hardware encoder refuses a frame wider or taller than 4096 pixels
 * (measured on M5, macOS 26.6: 4096×4096 encodes, 4098×1080 and 1080×4098 fail with
 * -12903). Its HEVC encoder goes to 8K. */
const H264_MAX_SIDE = 4096;

export function exceedsH264FrameLimit(width: number, height: number): boolean {
	return width > H264_MAX_SIDE || height > H264_MAX_SIDE;
}

/** The codec a rendered export actually encodes with. A 5K or 6K source-sized
 * export asked for as H.264 is encoded as HEVC instead of failing to start. */
export function renderedExportCodec(params: ExportParamsInput | undefined): "h264" | "h265" {
	if (params?.codec === "h265") return "h265";
	const width = Math.max(2, params?.width ?? 1920) & ~1;
	const height = Math.max(2, params?.height ?? 1080) & ~1;
	return exceedsH264FrameLimit(width, height) ? "h265" : "h264";
}
