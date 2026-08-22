import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { DEFAULT_MOTION_SPEED, NEW_CAMERA_MOTION_STYLE } from "@/lib/zoomMath/motionCurve";
import { CHAINED_ZOOM_PAN_GAP_MS } from "@/lib/zoomMath/zoomRegionUtils";
import type { KeyboardActivitySample } from "@/native/contracts";
import { createId } from "../document/ids";
import { resolvePlaybackSegments } from "../document/timeline";
import type { AxcutClip, AxcutDocument, AxcutTrimRange } from "../schema";
import { type DirectionCursorSample, normalizeDirectionCursor } from "./direction-engine";
import type { MicrophoneActivitySpan } from "./microphone-activity";
import { anchorRegionsWithDerivedMs } from "./timelineMap";

export interface AutoCameraEmphasisSuggestion {
	span: { start: number; end: number };
	mode: "emphasis";
	cameraScale: number;
	source: "auto";
	/** Stable ownership after a plan namespaces and persists this suggestion. */
	directionGroupId?: string;
}

export interface CameraEmphasisPolicy {
	/** Speech required before hindsight analysis accepts the moment. Not a visible delay. */
	speechConfidenceMs: number;
	/** Start the visual movement shortly before detected speech when the screen was already quiet. */
	speechPreRollMs: number;
	cursorQuietMs: number;
	cursorActivityPreRollMs: number;
	cursorMaximumSampleGapMs: number;
	cursorMaximumSampleStep: number;
	minimumDurationMs: number;
	motionBucketMs: number;
	motionPathThreshold: number;
	maxPerMinute: number;
	maxTotalDirectionPerMinute: number;
	/** Extra visible gap after a screen Zoom; cursor quiet is enforced separately. */
	screenToCameraSpacingMs: number;
	minimumSpacingMs: number;
	cameraScale: number;
}

export const DEFAULT_CAMERA_EMPHASIS_POLICY: CameraEmphasisPolicy = {
	speechConfidenceMs: 2_500,
	speechPreRollMs: 250,
	cursorQuietMs: 1_500,
	cursorActivityPreRollMs: 150,
	cursorMaximumSampleGapMs: 350,
	cursorMaximumSampleStep: 0.35,
	minimumDurationMs: 3_500,
	motionBucketMs: 250,
	motionPathThreshold: 0.018,
	maxPerMinute: 2,
	maxTotalDirectionPerMinute: 5,
	screenToCameraSpacingMs: 500,
	minimumSpacingMs: 4_000,
	cameraScale: 1.35,
};

type Span = { start: number; end: number };

type PlaybackTimeSegment = {
	rawStart: number;
	rawEnd: number;
	playbackStart: number;
	segmentKey: string;
};

type PlaybackSpan = Span & { segmentKey: string };

const overlaps = (a: Span, b: Span) => a.end > b.start && a.start < b.end;
const gapBetween = (a: Span, b: Span) =>
	Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));

function lowerBoundSample(samples: DirectionCursorSample[], timeMs: number) {
	let low = 0;
	let high = samples.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (samples[middle].timeMs < timeMs) low = middle + 1;
		else high = middle;
	}
	return low;
}

function detectCursorActivity(
	cursor: DirectionCursorSample[],
	durationMs: number,
	policy: CameraEmphasisPolicy,
	keyboardActivity: KeyboardActivitySample[] = [],
): Span[] {
	if (cursor.length === 0 && keyboardActivity.length === 0) return [];
	const bucketCount = Math.max(1, Math.ceil(durationMs / policy.motionBucketMs));
	const pathByBucket = new Float32Array(bucketCount);
	const clicked = new Uint8Array(bucketCount);
	for (const sample of cursor) {
		if (sample.directionExcluded) continue;
		if (!sample.interactionType || sample.interactionType === "move") continue;
		const bucket = Math.min(bucketCount - 1, Math.floor(sample.timeMs / policy.motionBucketMs));
		clicked[bucket] = 1;
	}
	for (const sample of keyboardActivity) {
		// A private target cannot provide a Zoom focus, but its key timing still
		// proves that the creator is working on the screen. Use only the timing as
		// a Camera Emphasis blocker; never read its target or position here.
		const bucket = Math.min(bucketCount - 1, Math.floor(sample.timeMs / policy.motionBucketMs));
		clicked[bucket] = 1;
	}
	for (let index = 1; index < cursor.length; index += 1) {
		const previous = cursor[index - 1];
		const current = cursor[index];
		const bucket = Math.min(bucketCount - 1, Math.floor(current.timeMs / policy.motionBucketMs));
		const elapsed = current.timeMs - previous.timeMs;
		const step = Math.hypot(current.cx - previous.cx, current.cy - previous.cy);
		if (
			!previous.directionExcluded &&
			!current.directionExcluded &&
			elapsed > 0 &&
			elapsed <= policy.cursorMaximumSampleGapMs &&
			step <= policy.cursorMaximumSampleStep
		) {
			pathByBucket[bucket] += step;
		}
	}

	const spans: Span[] = [];
	for (let bucket = 0; bucket < bucketCount; bucket += 1) {
		if (!clicked[bucket] && pathByBucket[bucket] < policy.motionPathThreshold) continue;
		const start = Math.max(0, bucket * policy.motionBucketMs - policy.cursorActivityPreRollMs);
		const end = Math.min(durationMs, (bucket + 1) * policy.motionBucketMs + policy.cursorQuietMs);
		const current = spans.at(-1);
		if (current && start <= current.end) current.end = Math.max(current.end, end);
		else spans.push({ start, end });
	}
	return spans;
}

function subtractSpans(span: Span, blockers: Span[]): Span[] {
	let pieces = [span];
	for (const blocker of blockers) {
		pieces = pieces.flatMap((piece) => {
			if (!overlaps(piece, blocker)) return [piece];
			const out: Span[] = [];
			if (blocker.start > piece.start) out.push({ start: piece.start, end: blocker.start });
			if (blocker.end < piece.end) out.push({ start: blocker.end, end: piece.end });
			return out;
		});
	}
	return pieces;
}

function projectSpanToPlayback(span: Span, segments: PlaybackTimeSegment[]): PlaybackSpan[] {
	return segments.flatMap((segment) => {
		const rawStart = Math.max(span.start, segment.rawStart);
		const rawEnd = Math.min(span.end, segment.rawEnd);
		if (rawEnd <= rawStart) return [];
		return [
			{
				start: segment.playbackStart + rawStart - segment.rawStart,
				end: segment.playbackStart + rawEnd - segment.rawStart,
				segmentKey: segment.segmentKey,
			},
		];
	});
}

function countSequences(spans: Span[]) {
	return sequenceCenters(spans).length;
}

function mergeConnectedSpans(spans: PlaybackSpan[], maximumGapMs: number) {
	const merged: PlaybackSpan[] = [];
	for (const span of [...spans].sort((left, right) => left.start - right.start)) {
		const previous = merged.at(-1);
		if (
			previous &&
			previous.segmentKey === span.segmentKey &&
			span.start <= previous.end + maximumGapMs
		) {
			previous.end = Math.max(previous.end, span.end);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

function sequenceCenters(spans: Array<Span & { segmentKey?: string }>) {
	const centers: number[] = [];
	let occupiedFrom = Number.NEGATIVE_INFINITY;
	let occupiedUntil = Number.NEGATIVE_INFINITY;
	let occupiedSegmentKey: string | undefined;
	for (const span of [...spans].sort((a, b) => a.start - b.start)) {
		if (span.segmentKey !== occupiedSegmentKey || span.start > occupiedUntil + 1) {
			if (Number.isFinite(occupiedFrom)) centers.push((occupiedFrom + occupiedUntil) / 2);
			occupiedFrom = span.start;
			occupiedSegmentKey = span.segmentKey;
		}
		occupiedUntil = Math.max(occupiedUntil, span.end);
	}
	if (Number.isFinite(occupiedFrom)) centers.push((occupiedFrom + occupiedUntil) / 2);
	return centers;
}

function staysWithinRollingBudget(spans: Span[], maximumPerMinute: number) {
	const centers = sequenceCenters(spans);
	let left = 0;
	for (let right = 0; right < centers.length; right += 1) {
		while (centers[right] - centers[left] >= 60_000) left += 1;
		if (right - left + 1 > maximumPerMinute) return false;
	}
	return true;
}

/**
 * Find sparse "speaker is talking, screen is quiet" moments. Cursor movement and
 * existing screen zooms are hard blockers. Each accepted result is an ordinary,
 * editable camera-layout region rather than a hidden playback rule.
 */
export function buildAutoCameraEmphasisSuggestionsForTimeline(options: {
	recordings: Array<{
		assetId: string;
		microphoneActivity: MicrophoneActivitySpan[];
		cursorTelemetry: DirectionCursorSample[];
		keyboardActivity?: KeyboardActivitySample[];
	}>;
	cameraAssetIds: ReadonlySet<string>;
	clips: AxcutClip[];
	trimRanges?: AxcutTrimRange[];
	occupiedScreenDirections?: Span[];
	existingCameraRegions?: { startMs: number; endMs: number }[];
	policy?: CameraEmphasisPolicy;
}): AutoCameraEmphasisSuggestion[] {
	const policy = options.policy ?? DEFAULT_CAMERA_EMPHASIS_POLICY;
	const trimRanges = options.trimRanges ?? [];
	const occupiedScreen = options.occupiedScreenDirections ?? [];
	const existingCamera = (options.existingCameraRegions ?? []).map((region) => ({
		start: region.startMs,
		end: region.endMs,
	}));
	let visibleDurationMs = 0;
	const playbackTimeSegments: PlaybackTimeSegment[] = [];
	const keptSegmentsByClip = new Map<string, AxcutClip[]>();
	const candidates: Array<AutoCameraEmphasisSuggestion & { score: number }> = [];

	for (const clip of [...options.clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec)) {
		const kept = resolvePlaybackSegments([clip], trimRanges);
		keptSegmentsByClip.set(clip.id, kept);
		for (const [segmentIndex, segment] of kept.entries()) {
			const durationMs = Math.max(
				0,
				((segment.sourceEndSec ?? segment.sourceStartSec) - segment.sourceStartSec) * 1_000,
			);
			const rawStart =
				(clip.timelineStartSec + segment.sourceStartSec - clip.sourceStartSec) * 1_000;
			playbackTimeSegments.push({
				rawStart,
				rawEnd: rawStart + durationMs,
				playbackStart: visibleDurationMs,
				segmentKey: `${clip.id}:${segmentIndex}`,
			});
			visibleDurationMs += durationMs;
		}
	}
	if (visibleDurationMs <= 0) return [];

	for (const recording of options.recordings) {
		if (
			!options.cameraAssetIds.has(recording.assetId) ||
			recording.microphoneActivity.length === 0 ||
			recording.cursorTelemetry.length < 2
		) {
			continue;
		}
		const matchingClips = options.clips.filter((clip) => clip.assetId === recording.assetId);
		const sourceDurationMs = Math.max(
			0,
			...matchingClips.map((clip) => (clip.sourceEndSec ?? clip.sourceStartSec) * 1_000),
		);
		const sourceCursor = normalizeDirectionCursor(recording.cursorTelemetry, sourceDurationMs);
		const sourceKeyboard = [...(recording.keyboardActivity ?? [])].sort(
			(left, right) => left.timeMs - right.timeMs,
		);
		for (const clip of matchingClips) {
			for (const segment of keptSegmentsByClip.get(clip.id) ?? []) {
				const sourceStartMs = segment.sourceStartSec * 1_000;
				const sourceEndMs = (segment.sourceEndSec ?? segment.sourceStartSec) * 1_000;
				const durationMs = sourceEndMs - sourceStartMs;
				if (durationMs < Math.max(policy.speechConfidenceMs, policy.minimumDurationMs)) continue;
				const first = lowerBoundSample(sourceCursor, sourceStartMs);
				const last = lowerBoundSample(sourceCursor, sourceEndMs);
				const localCursor = sourceCursor
					.slice(first, last)
					.map((sample) => ({ ...sample, timeMs: sample.timeMs - sourceStartMs }));
				const firstKeyboard = lowerBoundSample(sourceKeyboard, sourceStartMs);
				const lastKeyboard = lowerBoundSample(sourceKeyboard, sourceEndMs);
				const localKeyboard = sourceKeyboard
					.slice(firstKeyboard, lastKeyboard)
					.map((sample) => ({ ...sample, timeMs: sample.timeMs - sourceStartMs }));
				const blockers = detectCursorActivity(localCursor, durationMs, policy, localKeyboard);
				const timelineOffsetMs =
					(clip.timelineStartSec + segment.sourceStartSec - clip.sourceStartSec) * 1_000;

				for (const activity of recording.microphoneActivity) {
					const micStart = Math.max(sourceStartMs, activity.startMs) - sourceStartMs;
					const micEnd = Math.min(sourceEndMs, activity.endMs) - sourceStartMs;
					if (micEnd <= micStart) continue;
					const speechReady = micStart + policy.speechConfidenceMs;
					for (const quiet of subtractSpans({ start: micStart, end: micEnd }, blockers)) {
						// Confirm that speech remains useful after the confidence window, but
						// place the finished effect at the start of the speech. Analysis runs
						// after recording, so confidence does not need to become visible lag.
						if (quiet.end < speechReady) continue;
						if (quiet.end - quiet.start < policy.minimumDurationMs) continue;
						const startsWithSpeech = quiet.start === micStart;
						const proposedPreRoll = Math.max(0, quiet.start - policy.speechPreRollMs);
						const preRollIsQuiet = !blockers.some((blocker) =>
							overlaps(blocker, { start: proposedPreRoll, end: quiet.start }),
						);
						const start = startsWithSpeech && preRollIsQuiet ? proposedPreRoll : quiet.start;
						candidates.push({
							span: {
								start: Math.round(timelineOffsetMs + start),
								end: Math.round(timelineOffsetMs + quiet.end),
							},
							mode: "emphasis",
							cameraScale: policy.cameraScale,
							source: "auto",
							score: quiet.end - quiet.start,
						});
					}
				}
			}
		}
	}

	const cameraLimit = Math.max(1, Math.ceil((visibleDurationMs / 60_000) * policy.maxPerMinute));
	const totalLimit = Math.max(
		1,
		Math.ceil((visibleDurationMs / 60_000) * policy.maxTotalDirectionPerMinute),
	);
	const visibleExistingCamera = existingCamera.flatMap((span) =>
		projectSpanToPlayback(span, playbackTimeSegments),
	);
	const visibleOccupiedScreen = occupiedScreen.flatMap((span) =>
		projectSpanToPlayback(span, playbackTimeSegments),
	);
	const visibleScreenSequences = mergeConnectedSpans(
		visibleOccupiedScreen,
		CHAINED_ZOOM_PAN_GAP_MS,
	);
	const existingCameraCount = countSequences(visibleExistingCamera);
	const existingDirectionCount = countSequences([
		...visibleScreenSequences,
		...visibleExistingCamera,
	]);
	const available = Math.max(
		0,
		Math.min(cameraLimit - existingCameraCount, totalLimit - existingDirectionCount),
	);
	if (available === 0) return [];
	const selected: typeof candidates = [];
	const hardBlockers = [...occupiedScreen, ...existingCamera];
	for (const candidate of candidates.sort(
		(a, b) => b.score - a.score || a.span.start - b.span.start,
	)) {
		if (selected.length >= available) break;
		if (hardBlockers.some((span) => overlaps(span, candidate.span))) continue;
		if (selected.some((other) => overlaps(other.span, candidate.span))) continue;
		const selectedPlayback = selected.flatMap((item) =>
			projectSpanToPlayback(item.span, playbackTimeSegments),
		);
		const candidatePlayback = projectSpanToPlayback(candidate.span, playbackTimeSegments);
		if (candidatePlayback.length === 0) continue;
		// Repeated camera emphasis needs more breathing room than a return from
		// screen focus. Cursor quiet is already required before this shorter
		// screen-to-camera handoff. A later screen Zoom remains an intentional
		// focus handoff, so it blocks overlap but does not require an extra gap.
		const visibleCameraDirection = [...visibleExistingCamera, ...selectedPlayback];
		if (
			candidatePlayback.some(
				(candidateSpan) =>
					visibleCameraDirection.some(
						(cameraSpan) => gapBetween(candidateSpan, cameraSpan) < policy.minimumSpacingMs,
					) ||
					visibleScreenSequences
						.filter((screenSpan) => screenSpan.end <= candidateSpan.start)
						.some(
							(screenSpan) =>
								gapBetween(candidateSpan, screenSpan) < policy.screenToCameraSpacingMs,
						),
			)
		) {
			continue;
		}
		if (
			!staysWithinRollingBudget(
				[...visibleExistingCamera, ...selectedPlayback, ...candidatePlayback],
				policy.maxPerMinute,
			) ||
			!staysWithinRollingBudget(
				[
					...visibleScreenSequences,
					...visibleExistingCamera,
					...selectedPlayback,
					...candidatePlayback,
				],
				policy.maxTotalDirectionPerMinute,
			)
		) {
			continue;
		}
		selected.push(candidate);
	}
	return selected
		.sort((a, b) => a.span.start - b.span.start)
		.map(({ score: _score, ...suggestion }) => suggestion);
}

export function appendAutoCameraEmphasisSuggestions(
	document: AxcutDocument,
	suggestions: AutoCameraEmphasisSuggestion[],
	createRegionId: () => string = () => createId("camfull"),
): AxcutDocument {
	if (suggestions.length === 0) return document;
	const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
	const current = (legacy.cameraFullscreenRegions as CameraFullscreenRegion[] | undefined) ?? [];
	const anchored = suggestions.flatMap((suggestion) =>
		anchorRegionsWithDerivedMs(
			[
				{
					id: createRegionId(),
					startMs: suggestion.span.start,
					endMs: suggestion.span.end,
					mode: suggestion.mode,
					cameraScale: suggestion.cameraScale,
					source: suggestion.source,
					motionStyle: NEW_CAMERA_MOTION_STYLE,
					motionSpeed: DEFAULT_MOTION_SPEED,
					...(suggestion.directionGroupId ? { directionGroupId: suggestion.directionGroupId } : {}),
				},
			],
			document.timeline.clips,
			createRegionId,
		),
	);
	return {
		...document,
		legacyEditor: { ...legacy, cameraFullscreenRegions: [...current, ...anchored] },
	};
}
