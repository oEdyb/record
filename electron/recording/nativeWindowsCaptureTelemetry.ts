export type NativeWindowsCaptureTelemetry = {
	frames?: number;
	elapsedMs?: number;
	deliveredFps?: number;
	gpuBridgeContendedFrames?: number;
	encoderFinalizeMs?: number;
	webcamEncoderFinalizeMs?: number;
	stopTotalMs?: number;
};

const finiteNonNegative = (value: string | undefined): number | undefined => {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Parses the helper's fixed, path-free performance lines. Unknown text is ignored. */
export function parseNativeWindowsCaptureTelemetry(output: string): NativeWindowsCaptureTelemetry {
	let frames: number | undefined;
	let elapsedMs: number | undefined;
	let gpuBridgeContendedFrames: number | undefined;
	const stopBegins = new Map<string, number>();
	const stopEnds = new Map<string, number>();

	for (const line of output.split(/\r?\n/)) {
		const pacing = line.match(/^\[pacing\] frames=(\d+) elapsed_ms=(\d+)$/);
		if (pacing) {
			frames = finiteNonNegative(pacing[1]);
			elapsedMs = finiteNonNegative(pacing[2]);
			continue;
		}

		const drops = line.match(/^\[frame-drops\] gpu_bridge_contended=(\d+)$/);
		if (drops) {
			gpuBridgeContendedFrames = finiteNonNegative(drops[1]);
			continue;
		}

		const stop = line.match(
			/^\[stop-timing\] step=([a-z-]+) elapsed_ms=(\d+)(?:\s+phase=([a-z-]+))?/,
		);
		if (!stop) continue;
		const value = finiteNonNegative(stop[2]);
		if (value === undefined) continue;
		if (stop[3] === "begin") stopBegins.set(stop[1], value);
		else if (!stop[3]) stopEnds.set(stop[1], value);
	}

	const phaseDuration = (step: string): number | undefined => {
		const start = stopBegins.get(step);
		const end = stopEnds.get(step);
		return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
	};
	const deliveredFps =
		frames !== undefined && elapsedMs !== undefined && elapsedMs > 0
			? (frames * 1_000) / elapsedMs
			: undefined;
	const encoderFinalizeMs = phaseDuration("encoder-finalize");
	const webcamEncoderFinalizeMs = phaseDuration("webcam-encoder-finalize");
	const stopTotalMs = stopEnds.get("wgc-session-close");

	return {
		...(frames !== undefined ? { frames } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(deliveredFps !== undefined ? { deliveredFps } : {}),
		...(gpuBridgeContendedFrames !== undefined ? { gpuBridgeContendedFrames } : {}),
		...(encoderFinalizeMs !== undefined ? { encoderFinalizeMs } : {}),
		...(webcamEncoderFinalizeMs !== undefined ? { webcamEncoderFinalizeMs } : {}),
		...(stopTotalMs !== undefined ? { stopTotalMs } : {}),
	};
}
