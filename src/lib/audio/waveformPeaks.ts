/** Five-millisecond source blocks preserve useful edit detail at normal zoom. */
export const WAVEFORM_PEAK_BLOCKS_PER_SEC = 200;

/**
 * Keep full five-millisecond detail for recordings up to one hour. The paired
 * Float32 min/max envelope is about 5.5 MiB at this limit. Longer recordings
 * stay bounded and use progressively wider source blocks.
 */
export const MAX_WAVEFORM_PEAK_BLOCKS = 60 * 60 * WAVEFORM_PEAK_BLOCKS_PER_SEC;

export function waveformPeakBlockCount(durationSec: number): number {
	return Math.min(
		MAX_WAVEFORM_PEAK_BLOCKS,
		Math.max(1, Math.ceil(durationSec * WAVEFORM_PEAK_BLOCKS_PER_SEC)),
	);
}
