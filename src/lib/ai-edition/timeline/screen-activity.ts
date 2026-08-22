import type { CursorRecordingData } from "@/native/contracts";
import type { PauseProtectionSpan } from "./pause-analysis";

export interface ScreenActivityPolicy {
	bucketMs: number;
	pathThreshold: number;
	maximumSampleGapMs: number;
	maximumSampleStep: number;
	preRollMs: number;
	holdMs: number;
}

export const DEFAULT_SCREEN_ACTIVITY_POLICY: ScreenActivityPolicy = {
	bucketMs: 250,
	pathThreshold: 0.018,
	maximumSampleGapMs: 350,
	maximumSampleStep: 0.35,
	preRollMs: 150,
	holdMs: 550,
};

/**
 * Convert privacy-safe pointer and keyboard telemetry into source-time spans that
 * must not be shortened. Private events contribute timing only; their geometry is
 * never inspected.
 */
export function buildScreenActivitySpans(
	data: CursorRecordingData | null | undefined,
	durationSec: number,
	policy: ScreenActivityPolicy = DEFAULT_SCREEN_ACTIVITY_POLICY,
): PauseProtectionSpan[] {
	if (!data || durationSec <= 0) return [];
	const durationMs = durationSec * 1_000;
	const bucketCount = Math.max(1, Math.ceil(durationMs / policy.bucketMs));
	const pathByBucket = new Float32Array(bucketCount);
	const active = new Uint8Array(bucketCount);
	for (const sample of data.samples) {
		if (sample.interactionType && sample.interactionType !== "move") {
			active[Math.min(bucketCount - 1, Math.floor(sample.timeMs / policy.bucketMs))] = 1;
		}
	}
	for (const sample of data.keyboardActivity ?? []) {
		active[Math.min(bucketCount - 1, Math.floor(sample.timeMs / policy.bucketMs))] = 1;
	}
	for (let index = 1; index < data.samples.length; index += 1) {
		const previous = data.samples[index - 1];
		const current = data.samples[index];
		if (previous.directionExcluded || current.directionExcluded) continue;
		const elapsed = current.timeMs - previous.timeMs;
		const step = Math.hypot(current.cx - previous.cx, current.cy - previous.cy);
		if (elapsed > 0 && elapsed <= policy.maximumSampleGapMs && step <= policy.maximumSampleStep) {
			const bucket = Math.min(bucketCount - 1, Math.floor(current.timeMs / policy.bucketMs));
			pathByBucket[bucket] += step;
		}
	}

	const spans: PauseProtectionSpan[] = [];
	for (let bucket = 0; bucket < bucketCount; bucket += 1) {
		if (!active[bucket] && pathByBucket[bucket] < policy.pathThreshold) continue;
		const span = {
			startSec: Math.max(0, (bucket * policy.bucketMs - policy.preRollMs) / 1_000),
			endSec: Math.min(durationSec, ((bucket + 1) * policy.bucketMs + policy.holdMs) / 1_000),
		};
		const current = spans.at(-1);
		if (current && span.startSec <= current.endSec)
			current.endSec = Math.max(current.endSec, span.endSec);
		else spans.push(span);
	}
	return spans;
}
