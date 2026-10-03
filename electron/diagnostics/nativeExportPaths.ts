import type { WorkloadMediaPath, WorkloadTelemetryService } from "./workloadTelemetry";

function nativeEncoderPath(name: string, hardware: boolean): WorkloadMediaPath {
	if (name.startsWith("stream-copy/")) return "stream-copy";
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
	if (name === "packet-copy") return "packet-copy";
	if (name === "videotoolbox") return "videotoolbox-decoder";
	if (name === "d3d11va") return "d3d11va-decoder";
	if (name === "software") return "software-decoder";
	if (name === "mixed") return "mixed-decoder";
	return "unknown";
}

function nativeCompositorPath(name: string): WorkloadMediaPath {
	if (name === "bypassed-identity-scene") return "identity-bypass";
	if (name === "metal") return "metal";
	if (name === "d3d11") return "d3d11";
	if (name === "vulkan") return "vulkan";
	if (name === "software") return "software";
	return "unknown";
}

export function addNativeExportPaths(
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
