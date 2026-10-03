import { describe, expect, it, vi } from "vitest";
import { addNativeExportPaths } from "./nativeExportPaths";
import type { WorkloadTelemetryService } from "./workloadTelemetry";

describe("export workload media paths", () => {
	it("reports preserved video without claiming software encoding or hardware fallback", () => {
		const telemetry = { addMediaPath: vi.fn(), addFallback: vi.fn() };
		addNativeExportPaths(telemetry as unknown as WorkloadTelemetryService, "export", {
			encoderName: "stream-copy/h264",
			encoderHardware: false,
			encoderFallback: false,
			decoderPath: "packet-copy",
			compositorBackend: "bypassed-identity-scene",
		});
		expect(telemetry.addMediaPath.mock.calls).toEqual([
			["export", "stream-copy"],
			["export", "packet-copy"],
			["export", "identity-bypass"],
		]);
		expect(telemetry.addFallback).not.toHaveBeenCalled();
	});
	it.each([
		[
			"h264_videotoolbox",
			true,
			"videotoolbox",
			"metal",
			["videotoolbox-hardware", "videotoolbox-decoder", "metal"],
		],
		[
			"h264_videotoolbox",
			false,
			"software",
			"software",
			["videotoolbox-software", "software-decoder", "software"],
		],
		["libopenh264", false, "mixed", "d3d11", ["libopenh264-software", "mixed-decoder", "d3d11"]],
		["hevc_nvenc", true, "d3d11va", "vulkan", ["nvenc-hardware", "d3d11va-decoder", "vulkan"]],
	] as const)("preserves existing encoder/decoder/compositor reporting for %s", (encoderName, encoderHardware, decoderPath, compositorBackend, expected) => {
		const telemetry = { addMediaPath: vi.fn(), addFallback: vi.fn() };
		addNativeExportPaths(telemetry as unknown as WorkloadTelemetryService, "export", {
			encoderName,
			encoderHardware,
			encoderFallback: !encoderHardware,
			decoderPath,
			compositorBackend,
		});
		expect(telemetry.addMediaPath.mock.calls.map((call) => call[1])).toEqual(expected);
		if (!encoderHardware)
			expect(telemetry.addFallback).toHaveBeenCalledWith("export", "encoder-hardware-to-software");
		else expect(telemetry.addFallback).not.toHaveBeenCalled();
	});
});
