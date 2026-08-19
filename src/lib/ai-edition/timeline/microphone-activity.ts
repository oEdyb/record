/** A high-confidence span of sustained activity on the isolated microphone track. */
export interface MicrophoneActivitySpan {
	startMs: number;
	endMs: number;
}

export interface MicrophoneActivityPolicy {
	frameMs: number;
	bridgeGapMs: number;
	minimumBurstMs: number;
	absoluteFloor: number;
	noiseQuantile: number;
	noiseThresholdMultiplier: number;
	floorThresholdMultiplier: number;
	variationLowQuantile: number;
	variationHighQuantile: number;
	minimumHighFloorMultiplier: number;
	minimumVariationRatio: number;
	variationOffset: number;
}

export const DEFAULT_MICROPHONE_ACTIVITY_POLICY: MicrophoneActivityPolicy = {
	frameMs: 50,
	bridgeGapMs: 450,
	minimumBurstMs: 180,
	absoluteFloor: 0.006,
	noiseQuantile: 0.2,
	noiseThresholdMultiplier: 2.8,
	floorThresholdMultiplier: 0.5,
	variationLowQuantile: 0.15,
	variationHighQuantile: 0.85,
	minimumHighFloorMultiplier: 1.5,
	minimumVariationRatio: 1.35,
	variationOffset: 0.001,
};

function quantile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const ordered = [...values].sort((a, b) => a - b);
	return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

/**
 * Turn cached min/max waveform blocks into conservative microphone-activity spans.
 * This is deliberately not transcription. It only runs on the isolated microphone
 * track and requires both sustained level and speech-like level variation, which
 * rejects silence, isolated keyboard hits, and steady room/fan noise.
 */
export function buildMicrophoneActivitySpans(
	peaks: Float32Array,
	durationMs: number,
	policy: MicrophoneActivityPolicy = DEFAULT_MICROPHONE_ACTIVITY_POLICY,
): MicrophoneActivitySpan[] {
	const blockCount = Math.floor(peaks.length / 2);
	if (blockCount === 0 || durationMs <= 0) return [];
	const blockMs = durationMs / blockCount;
	const blocksPerFrame = Math.max(1, Math.round(policy.frameMs / blockMs));
	const frames: Array<{ startMs: number; endMs: number; amplitude: number }> = [];
	for (let block = 0; block < blockCount; block += blocksPerFrame) {
		const end = Math.min(blockCount, block + blocksPerFrame);
		let power = 0;
		for (let index = block; index < end; index += 1) {
			const amplitude = Math.max(Math.abs(peaks[index * 2]), Math.abs(peaks[index * 2 + 1]));
			power += amplitude * amplitude;
		}
		frames.push({
			startMs: block * blockMs,
			endMs: end * blockMs,
			amplitude: Math.sqrt(power / Math.max(1, end - block)),
		});
	}

	const amplitudes = frames.map((frame) => frame.amplitude);
	const noise = quantile(amplitudes, policy.noiseQuantile);
	let strongSignal = 0;
	for (const amplitude of amplitudes) strongSignal = Math.max(strongSignal, amplitude);
	if (strongSignal < policy.absoluteFloor) return [];
	const threshold = Math.max(
		policy.absoluteFloor,
		noise * policy.noiseThresholdMultiplier +
			policy.absoluteFloor * policy.floorThresholdMultiplier,
	);
	const activeFrames = frames.filter((frame) => frame.amplitude >= threshold);
	if (activeFrames.length === 0) return [];

	const spans: Array<MicrophoneActivitySpan & { amplitudes: number[] }> = [];
	for (const frame of activeFrames) {
		const current = spans.at(-1);
		if (current && frame.startMs - current.endMs <= policy.bridgeGapMs) {
			current.endMs = frame.endMs;
			current.amplitudes.push(frame.amplitude);
		} else {
			spans.push({
				startMs: frame.startMs,
				endMs: frame.endMs,
				amplitudes: [frame.amplitude],
			});
		}
	}

	return spans
		.filter((span) => span.endMs - span.startMs >= policy.minimumBurstMs)
		.filter((span) => {
			const low = quantile(span.amplitudes, policy.variationLowQuantile);
			const high = quantile(span.amplitudes, policy.variationHighQuantile);
			return (
				high >= policy.absoluteFloor * policy.minimumHighFloorMultiplier &&
				high >= low * policy.minimumVariationRatio + policy.variationOffset
			);
		})
		.map(({ startMs, endMs }) => ({
			startMs: Math.max(0, Math.round(startMs)),
			endMs: Math.min(durationMs, Math.round(endMs)),
		}));
}
