// Cursor-driven auto-zoom suggestions. Pure, no DOM/IPC.
//
// Ported from main's `src/components/video-editor/timeline/zoomSuggestionUtils.ts`
// (the legacy editor's "magic wand" auto-zoom) into the ai-edition timeline
// module. This is NOT an AI feature. The direction engine combines recorded
// clicks with deliberate cursor traces, ranks them globally, and returns a
// sparse set of ordinary editable zoom regions.

import type { ZoomFocus } from "@/components/video-editor/types";
import {
	DEFAULT_MOTION_SPEED,
	type MotionSpeed,
	NEW_ZOOM_MOTION_STYLE,
} from "@/lib/zoomMath/motionCurve";
import type { KeyboardActivitySample } from "@/native/contracts";
import { createId } from "../document/ids";
import { resolvePlaybackSegments } from "../document/timeline";
import type { AxcutClip, AxcutDocument, AxcutTrimRange } from "../schema";
import type { ConnectedClickPolicy } from "./connected-click-policy";
import {
	buildDirectionPlan,
	DEFAULT_DIRECTION_POLICY,
	type DirectionCursorSample,
	type DirectionPolicy,
	type DirectionZoomCandidate,
	detectDirectionCandidates,
	normalizeDirectionCursor,
	selectDirectionCandidates,
} from "./direction-engine";
import { anchorRegionsWithDerivedMs } from "./timelineMap";
import { buildTypingFocusAnchors, type TypingDirectionPolicy } from "./typing-direction";

export interface AutoZoomSuggestion {
	span: { start: number; end: number };
	focus: ZoomFocus;
	focusMode: "manual" | "auto";
	customScale: number;
	motionSpeed?: MotionSpeed;
	source: "auto";
	/** Local sequence identity. A plan namespaces it before persistence. */
	directionGroupId?: string;
}

/**
 * Build non-overlapping zoom suggestions from cursor events. The pure direction
 * engine decides timing, focus, scale, and density. This wrapper keeps the existing
 * editor and CLI call sites on one timeline-specific contract.
 */
export function buildAutoZoomSuggestions(options: {
	cursorTelemetry: DirectionCursorSample[];
	keyboardActivity?: KeyboardActivitySample[];
	totalMs: number;
	existingRegions: { startMs: number; endMs: number }[];
	defaultDurationMs: number;
	connectedClickPolicy?: ConnectedClickPolicy;
	typingDirectionPolicy?: TypingDirectionPolicy;
	directionPolicy?: DirectionPolicy;
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, totalMs, existingRegions, defaultDurationMs } = options;
	if (
		totalMs <= 0 ||
		(cursorTelemetry.length === 0 && (options.keyboardActivity?.length ?? 0) === 0) ||
		defaultDurationMs <= 0
	) {
		return [];
	}

	return buildDirectionPlan({
		cursor: cursorTelemetry,
		focusActivities: buildTypingFocusAnchors({
			keyboardActivity: options.keyboardActivity ?? [],
			cursorTelemetry,
			durationMs: totalMs,
			...(options.typingDirectionPolicy ? { policy: options.typingDirectionPolicy } : {}),
		}),
		durationMs: totalMs,
		occupiedZooms: existingRegions.map((region) => ({
			start: region.startMs,
			end: region.endMs,
		})),
		preferredZoomDurationMs: defaultDurationMs,
		...(options.directionPolicy ? { policy: options.directionPolicy } : {}),
		...(options.connectedClickPolicy ? { connectedClickPolicy: options.connectedClickPolicy } : {}),
	}).zooms.map((zoom) => ({
		span: zoom.span,
		focus: zoom.focus,
		focusMode: zoom.focusMode,
		customScale: zoom.customScale,
		motionSpeed: zoom.motionSpeed,
		source: "auto",
		...(zoom.sequenceId ? { directionGroupId: zoom.sequenceId } : {}),
	}));
}

/**
 * Store generated zooms as the same clip-anchored regions used by every manual
 * editor action. Undo, trim, reorder, resize, and delete therefore work without
 * any automatic-direction-specific timeline behavior.
 */
export function appendAutoZoomSuggestions(
	document: AxcutDocument,
	suggestions: AutoZoomSuggestion[],
	createRegionId: () => string = () => createId("zoom"),
): AxcutDocument {
	if (suggestions.length === 0) return document;
	const anchored = suggestions.flatMap((suggestion) =>
		anchorRegionsWithDerivedMs(
			[
				{
					id: createRegionId(),
					startMs: Math.round(suggestion.span.start),
					endMs: Math.round(suggestion.span.end),
					depth: 3 as const,
					focus: suggestion.focus,
					focusMode: suggestion.focusMode,
					customScale: suggestion.customScale,
					source: suggestion.source,
					motionStyle: NEW_ZOOM_MOTION_STYLE,
					motionSpeed: suggestion.motionSpeed ?? DEFAULT_MOTION_SPEED,
					...(suggestion.directionGroupId ? { directionGroupId: suggestion.directionGroupId } : {}),
				},
			],
			document.timeline.clips,
			createRegionId,
		),
	);
	return { ...document, zoomRanges: [...document.zoomRanges, ...anchored] };
}

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

function shiftCandidate(
	candidate: DirectionZoomCandidate,
	offsetMs: number,
	sequenceScope: string,
) {
	return {
		...candidate,
		...(candidate.sequenceId ? { sequenceId: `${sequenceScope}:${candidate.sequenceId}` } : {}),
		span: {
			start: candidate.span.start + offsetMs,
			end: candidate.span.end + offsetMs,
		},
		...(candidate.sequenceSpan
			? {
					sequenceSpan: {
						start: candidate.sequenceSpan.start + offsetMs,
						end: candidate.sequenceSpan.end + offsetMs,
					},
				}
			: {}),
		...(candidate.intentSpan
			? {
					intentSpan: {
						start: candidate.intentSpan.start + offsetMs,
						end: candidate.intentSpan.end + offsetMs,
					},
				}
			: {}),
	};
}

type PlaybackTimeSegment = {
	rawStart: number;
	rawEnd: number;
	playbackStart: number;
};

function projectSpanToPlayback(
	span: { start: number; end: number },
	segments: PlaybackTimeSegment[],
) {
	return segments.flatMap((segment) => {
		const rawStart = Math.max(span.start, segment.rawStart);
		const rawEnd = Math.min(span.end, segment.rawEnd);
		if (rawEnd <= rawStart) return [];
		return [
			{
				start: segment.playbackStart + rawStart - segment.rawStart,
				end: segment.playbackStart + rawEnd - segment.rawStart,
			},
		];
	});
}

/**
 * Project source-time telemetry onto every matching clip, then rank all clips
 * together. A project therefore gets one motion budget. The planner also sorts
 * each source once and uses binary slices, so cuts do not multiply sidecar work.
 */
export function buildAutoZoomSuggestionsForTimeline(options: {
	recordings: Array<{
		assetId: string;
		cursorTelemetry: DirectionCursorSample[];
		keyboardActivity?: KeyboardActivitySample[];
	}>;
	clips: AxcutClip[];
	trimRanges?: AxcutTrimRange[];
	/** Already-placed zoom spans, in raw timeline ms. */
	existingRegions: { startMs: number; endMs: number }[];
	/** Other direction effects that reserve attention but not the screen-Zoom budget. */
	occupiedDirections?: { startMs: number; endMs: number }[];
	maximumTotalDirectionsPerMinute?: number;
	defaultDurationMs: number;
	connectedClickPolicy?: ConnectedClickPolicy;
	typingDirectionPolicy?: TypingDirectionPolicy;
	directionPolicy?: DirectionPolicy;
}): AutoZoomSuggestion[] {
	const { recordings, clips, existingRegions, defaultDurationMs } = options;
	const trimRanges = options.trimRanges ?? [];
	const timelineDurationMs = Math.max(0, ...clips.map((clip) => clip.timelineEndSec * 1_000));
	if (timelineDurationMs <= 0 || defaultDurationMs <= 0) return [];
	const keptSegmentsByClip = new Map<string, AxcutClip[]>();
	const playbackTimeSegments: PlaybackTimeSegment[] = [];
	let visibleDurationMs = 0;
	for (const clip of [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec)) {
		const keptSegments = resolvePlaybackSegments([clip], trimRanges);
		keptSegmentsByClip.set(clip.id, keptSegments);
		for (const segment of keptSegments) {
			const durationMs =
				((segment.sourceEndSec ?? segment.sourceStartSec) - segment.sourceStartSec) * 1_000;
			const rawStartMs =
				(clip.timelineStartSec + segment.sourceStartSec - clip.sourceStartSec) * 1_000;
			playbackTimeSegments.push({
				rawStart: rawStartMs,
				rawEnd: rawStartMs + durationMs,
				playbackStart: visibleDurationMs,
			});
			visibleDurationMs += Math.max(0, durationMs);
		}
	}
	if (visibleDurationMs <= 0) return [];

	const directionPolicy = options.directionPolicy ?? DEFAULT_DIRECTION_POLICY;
	const preferredZoomDurationMs = Math.min(
		directionPolicy.maximumZoomDurationMs,
		Math.max(1_000, defaultDurationMs),
	);
	const candidates: DirectionZoomCandidate[] = [];
	for (const recording of recordings) {
		const matchingClips = clips.filter((clip) => clip.assetId === recording.assetId);
		const sourceDurationMs = Math.max(
			0,
			...matchingClips.map((clip) => (clip.sourceEndSec ?? clip.sourceStartSec) * 1_000),
		);
		if (sourceDurationMs <= 0) continue;
		const sourceCursor = normalizeDirectionCursor(recording.cursorTelemetry, sourceDurationMs);
		const sourceKeyboard = [...(recording.keyboardActivity ?? [])].sort(
			(left, right) => left.timeMs - right.timeMs,
		);
		if (sourceCursor.length === 0 && sourceKeyboard.length === 0) continue;

		for (const clip of matchingClips) {
			const keptSegments = keptSegmentsByClip.get(clip.id) ?? [];
			for (const [segmentIndex, segment] of keptSegments.entries()) {
				const sourceStartMs = segment.sourceStartSec * 1_000;
				const sourceEndMs = (segment.sourceEndSec ?? segment.sourceStartSec) * 1_000;
				const clipDurationMs = sourceEndMs - sourceStartMs;
				if (clipDurationMs < directionPolicy.minimumZoomDurationMs) continue;
				const first = lowerBoundSample(sourceCursor, sourceStartMs);
				const last = lowerBoundSample(sourceCursor, sourceEndMs);
				const clipCursor = sourceCursor
					.slice(first, last)
					.map((sample) => ({ ...sample, timeMs: sample.timeMs - sourceStartMs }));
				const firstKeyboard = lowerBoundSample(sourceKeyboard, sourceStartMs);
				const lastKeyboard = lowerBoundSample(sourceKeyboard, sourceEndMs);
				const keyboardActivity = sourceKeyboard
					.slice(firstKeyboard, lastKeyboard)
					.map((sample) => ({ ...sample, timeMs: sample.timeMs - sourceStartMs }));
				if (clipCursor.length === 0 && keyboardActivity.length === 0) continue;
				const timelineOffsetMs =
					(clip.timelineStartSec + segment.sourceStartSec - clip.sourceStartSec) * 1_000;
				const clipCandidates = detectDirectionCandidates({
					cursor: clipCursor,
					focusActivities: buildTypingFocusAnchors({
						keyboardActivity,
						cursorTelemetry: clipCursor,
						durationMs: clipDurationMs,
						...(options.typingDirectionPolicy ? { policy: options.typingDirectionPolicy } : {}),
					}),
					durationMs: clipDurationMs,
					preferredZoomDurationMs,
					policy: directionPolicy,
					...(options.connectedClickPolicy
						? { connectedClickPolicy: options.connectedClickPolicy }
						: {}),
				});
				candidates.push(
					...clipCandidates.map((candidate) =>
						shiftCandidate(candidate, timelineOffsetMs, `${clip.id}:${segmentIndex}`),
					),
				);
			}
		}
	}

	// Selection uses what the viewer experiences: trims consume no time. Keep the
	// raw candidate beside its compressed twin so the accepted region is still
	// stored on the editor's raw ruler.
	const rawByPlaybackCandidate = new Map<DirectionZoomCandidate, DirectionZoomCandidate>();
	const playbackCandidates = candidates.flatMap((candidate) => {
		const projected = projectSpanToPlayback(candidate.span, playbackTimeSegments);
		if (projected.length === 0) return [];
		const playbackSpan = projected.reduce((longest, span) =>
			span.end - span.start > longest.end - longest.start ? span : longest,
		);
		let sequenceMetadata: Pick<
			DirectionZoomCandidate,
			"sequenceId" | "sequenceSpan" | "intentSpan"
		> = {};
		if (candidate.sequenceId && candidate.sequenceSpan) {
			const projectedSequence = projectSpanToPlayback(candidate.sequenceSpan, playbackTimeSegments);
			const sequenceIndex = projectedSequence.findIndex(
				(span) => span.start <= playbackSpan.start && span.end >= playbackSpan.end,
			);
			if (sequenceIndex >= 0) {
				sequenceMetadata = {
					sequenceId: `${candidate.sequenceId}-visible-${sequenceIndex}`,
					sequenceSpan: projectedSequence[sequenceIndex],
				};
			}
		}
		if (candidate.intentSpan) {
			const projectedIntent = projectSpanToPlayback(candidate.intentSpan, playbackTimeSegments);
			const matchingIntent = projectedIntent.find(
				(span) => span.start <= playbackSpan.end && span.end >= playbackSpan.start,
			);
			if (matchingIntent) sequenceMetadata.intentSpan = matchingIntent;
		}
		const {
			sequenceId: _sequenceId,
			sequenceSpan: _sequenceSpan,
			intentSpan: _intentSpan,
			...baseCandidate
		} = candidate;
		const playbackCandidate = {
			...baseCandidate,
			...sequenceMetadata,
			span: playbackSpan,
		};
		rawByPlaybackCandidate.set(playbackCandidate, candidate);
		return [playbackCandidate];
	});
	const selected = selectDirectionCandidates({
		candidates: playbackCandidates,
		durationMs: visibleDurationMs,
		occupiedZooms: existingRegions.flatMap((region) =>
			projectSpanToPlayback({ start: region.startMs, end: region.endMs }, playbackTimeSegments),
		),
		occupiedDirections: (options.occupiedDirections ?? []).flatMap((region) =>
			projectSpanToPlayback({ start: region.startMs, end: region.endMs }, playbackTimeSegments),
		),
		maximumTotalDirectionsPerMinute: options.maximumTotalDirectionsPerMinute,
		policy: directionPolicy,
	}).flatMap((candidate) => {
		const raw = rawByPlaybackCandidate.get(candidate);
		return raw ? [raw] : [];
	});

	return selected.map((zoom) => ({
		span: zoom.span,
		focus: zoom.focus,
		focusMode: zoom.focusMode,
		customScale: zoom.customScale,
		motionSpeed: zoom.motionSpeed,
		source: "auto",
		...(zoom.sequenceId ? { directionGroupId: zoom.sequenceId } : {}),
	}));
}

/** Compatibility wrapper for callers that hold one recording. */
export function buildAutoZoomSuggestionsForClips(options: {
	cursorTelemetry: DirectionCursorSample[];
	keyboardActivity?: KeyboardActivitySample[];
	assetId: string;
	clips: AxcutClip[];
	trimRanges?: AxcutTrimRange[];
	existingRegions: { startMs: number; endMs: number }[];
	defaultDurationMs: number;
	connectedClickPolicy?: ConnectedClickPolicy;
	typingDirectionPolicy?: TypingDirectionPolicy;
	directionPolicy?: DirectionPolicy;
}): AutoZoomSuggestion[] {
	return buildAutoZoomSuggestionsForTimeline({
		recordings: [
			{
				assetId: options.assetId,
				cursorTelemetry: options.cursorTelemetry,
				keyboardActivity: options.keyboardActivity,
			},
		],
		clips: options.clips,
		trimRanges: options.trimRanges,
		existingRegions: options.existingRegions,
		defaultDurationMs: options.defaultDurationMs,
		connectedClickPolicy: options.connectedClickPolicy,
		typingDirectionPolicy: options.typingDirectionPolicy,
		directionPolicy: options.directionPolicy,
	});
}
