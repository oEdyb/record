import type { HandoffSpan, MarkerColor, TimelineMarker } from "./sourceTimeline";

/** A stretch the clean cut keeps, in its recording's source seconds, listed in edit order. */
export interface CleanCutKeep {
	assetId: string;
	startSec: number;
	endSec: number;
}

/** A marker at the start of the kept stretch `keepIndex`, i.e. right after the cut it explains. */
export interface CleanCutMarker {
	keepIndex: number;
	name: string;
	comment: string;
	color: MarkerColor;
}

export interface CleanCut {
	keep: CleanCutKeep[];
	markers: CleanCutMarker[];
}

function sourceEnd(span: HandoffSpan) {
	return span.sourceEndSec ?? span.sourceStartSec + (span.timelineEndSec - span.timelineStartSec);
}

/**
 * Lays the clean cut out as timeline spans. Each kept stretch is clipped to what the project
 * itself keeps, so a clean cut never brings back material the creator already removed.
 */
export function cleanCutTimeline(retained: HandoffSpan[], cut: CleanCut) {
	const spans: HandoffSpan[] = [];
	const firstSpanOf = new Map<number, number>();
	let at = 0;
	for (const [keepIndex, keep] of cut.keep.entries()) {
		const pieces = retained
			.filter((span) => span.assetId === keep.assetId)
			.map((span) => ({
				span,
				start: Math.max(keep.startSec, span.sourceStartSec),
				end: Math.min(keep.endSec, sourceEnd(span)),
			}))
			.filter((piece) => piece.end > piece.start)
			.sort((a, b) => a.start - b.start);
		for (const piece of pieces) {
			if (!firstSpanOf.has(keepIndex)) firstSpanOf.set(keepIndex, spans.length);
			const length = piece.end - piece.start;
			spans.push({
				id: `${piece.span.id}:clean-${spans.length}`,
				assetId: keep.assetId,
				sourceStartSec: piece.start,
				sourceEndSec: piece.end,
				timelineStartSec: at,
				timelineEndSec: at + length,
			});
			at += length;
		}
	}
	const markers: TimelineMarker[] = cut.markers.flatMap((marker) => {
		const index = firstSpanOf.get(marker.keepIndex);
		if (index === undefined) return [];
		const { keepIndex: _, ...rest } = marker;
		return [{ ...rest, timelineSec: spans[index]!.timelineStartSec }];
	});
	return { spans, markers };
}

const COLORS = ["RED", "ORANGE", "YELLOW", "GREEN", "CYAN", "BLUE", "PURPLE", "PINK"] as const;
const MAX_TEXT = 500;

/** Checks a clean cut that arrives from the renderer before it shapes any exported file. */
export function parseCleanCut(input: unknown): CleanCut | undefined {
	if (input === undefined || input === null) return undefined;
	const fail = () => {
		throw new Error("The clean cut sent with this export is not valid.");
	};
	const value = input as { keep?: unknown; markers?: unknown };
	if (!Array.isArray(value.keep) || !Array.isArray(value.markers)) fail();
	const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
	const text = (s: unknown): s is string => typeof s === "string";
	// Long notes are shortened, not rejected: a note is only a label on the timeline.
	const short = (s: string) => (s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT - 1)}…`);
	const keep = (value.keep as unknown[]).map((item) => {
		const k = item as Record<string, unknown>;
		if (
			!text(k.assetId) ||
			k.assetId.length > MAX_TEXT ||
			!finite(k.startSec) ||
			!finite(k.endSec) ||
			k.endSec < k.startSec ||
			k.startSec < 0
		)
			fail();
		return {
			assetId: k.assetId as string,
			startSec: k.startSec as number,
			endSec: k.endSec as number,
		};
	});
	const markers = (value.markers as unknown[]).map((item) => {
		const m = item as Record<string, unknown>;
		if (
			!Number.isInteger(m.keepIndex) ||
			!text(m.name) ||
			!text(m.comment) ||
			!(COLORS as readonly unknown[]).includes(m.color)
		)
			fail();
		return {
			keepIndex: m.keepIndex as number,
			name: short(m.name as string),
			comment: short(m.comment as string),
			color: m.color as MarkerColor,
		};
	});
	return { keep, markers };
}
