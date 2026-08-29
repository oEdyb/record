import { describe, expect, it } from "vitest";
import { parseNativeWindowsCaptureTelemetry } from "./nativeWindowsCaptureTelemetry";

describe("parseNativeWindowsCaptureTelemetry", () => {
	it("extracts delivered frame rate, drops, and cumulative stop phase durations", () => {
		const output = [
			"[pacing] frames=1800 elapsed_ms=30100",
			"[frame-drops] gpu_bridge_contended=4",
			"[stop-timing] step=encoder-finalize elapsed_ms=210 phase=begin deadline_ms=8000",
			"[stop-timing] step=encoder-finalize elapsed_ms=360",
			"[stop-timing] step=webcam-encoder-finalize elapsed_ms=370 phase=begin deadline_ms=8000",
			"[stop-timing] step=webcam-encoder-finalize elapsed_ms=430",
			"[stop-timing] step=wgc-session-close elapsed_ms=450 phase=begin deadline_ms=1000",
			"[stop-timing] step=wgc-session-close elapsed_ms=470",
		].join("\n");

		expect(parseNativeWindowsCaptureTelemetry(output)).toEqual({
			frames: 1800,
			elapsedMs: 30100,
			deliveredFps: (1800 * 1_000) / 30100,
			gpuBridgeContendedFrames: 4,
			encoderFinalizeMs: 150,
			webcamEncoderFinalizeMs: 60,
			stopTotalMs: 470,
		});
	});

	it("ignores malformed and private helper output", () => {
		const output = [
			"[pacing] frames=no elapsed_ms=100",
			"Recording stopped. Output path: /private/video.mp4",
			"[stop-timing] step=encoder-finalize elapsed_ms=200 phase=begin",
			"[stop-timing] step=encoder-finalize elapsed_ms=150",
		].join("\n");

		expect(parseNativeWindowsCaptureTelemetry(output)).toEqual({});
	});

	it("uses the newest complete pacing result", () => {
		const output = [
			"[pacing] frames=60 elapsed_ms=1000",
			"[pacing] frames=119 elapsed_ms=2000",
		].join("\n");

		expect(parseNativeWindowsCaptureTelemetry(output).deliveredFps).toBe(59.5);
	});
});
