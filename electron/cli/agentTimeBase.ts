// Phase-3 time base for the Klippt agent CLI: one parser for every time flag
// and one resolver between the timeline's clocks. Pure module: no Electron
// imports, so parser and broker tests can load it.
//
// Clocks (see technical-documentation/architecture/timeline-model.md):
//   edited — the trim-compressed playback ruler; what an agent means by "3:50".
//   raw    — the stable document clock; trims still occupy their space.
//   source — a clip's own media time; what trims, cutpoint and decoders use.
//   output — the speed-adjusted export clock (`preview --time`); only ever a
//            default or a label, never a suffix.
//
// Input syntax: bare number or m:ss.s in the command's default base, plus an
// explicit suffix: `103e` edited, `125.3r` raw, `10.4s` source. The default
// base is per command for compatibility: state/placement/frame(s) default to
// edited (already documented), cutpoint/geometry default to source, transport
// seek defaults to raw, preview defaults to output.

import { z } from "zod";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	buildTimelinePlaybackProjection,
	playbackTimeToRawTime,
	rawTimeToPlaybackTime,
	resolveNativePosition,
} from "../../src/lib/ai-edition/timeline/timelineMap";
import { buildExportTimeMap } from "../../src/lib/exporter/mp4ExportSettings";
import {
	buildCompositorClipInputs,
	buildSceneDescription,
	resolveVisibleClips,
} from "../../src/native/sceneDescription";

export const TIME_BASES = ["edited", "raw", "source", "output"] as const;
export type TimeBase = (typeof TIME_BASES)[number];

/** A parsed time flag: a value plus the clock the caller wrote it in. */
export interface TimeInput {
	seconds: number;
	base: TimeBase;
}

/** Canonical reply labels for each clock, next to the values they describe. */
export const TIME_BASE_LABELS: Record<TimeBase, string> = {
	edited: "edited_seconds (trim-compressed playback clock)",
	raw: "raw_virtual_seconds (document clock; trims still occupy their space)",
	source: "source_seconds (the clip's own media time)",
	output: "export_output_seconds (speed-adjusted output clock)",
};

const TIME_PATTERN = /^(\d+(?:\.\d+)?|\d+:[0-5]?\d(?:\.\d+)?)([ers])?$/;
const SUFFIX_BASE = { e: "edited", r: "raw", s: "source" } as const;

export function parseTimeInput(
	value: string | number | TimeInput,
	defaultBase: TimeBase = "edited",
): TimeInput {
	if (typeof value === "object" && value !== null) {
		const { seconds, base } = value;
		if (
			Number.isFinite(seconds) &&
			seconds >= 0 &&
			(TIME_BASES as readonly string[]).includes(base)
		)
			return { seconds, base };
		throw new Error(`INVALID_INPUT: Malformed time input ${JSON.stringify(value)}`);
	}
	if (typeof value === "number") {
		if (Number.isFinite(value) && value >= 0) return { seconds: value, base: defaultBase };
		throw new Error(`INVALID_INPUT: Time must be a nonnegative number, got ${value}`);
	}
	const match = TIME_PATTERN.exec(value.trim());
	if (!match)
		throw new Error(
			`INVALID_INPUT: Time must be seconds or m:ss.s with optional suffix e (edited), r (raw) or s (source); got "${value}"`,
		);
	const body = match[1];
	const seconds = body.includes(":")
		? body.split(":").reduce((total, part) => total * 60 + Number(part), 0)
		: Number(body);
	if (!Number.isFinite(seconds)) throw new Error(`INVALID_INPUT: Time is not finite: "${value}"`);
	// m:ss.s is a timecode, and timecodes are edited everywhere — only bare
	// numbers fall back to the command's default base.
	const base = match[2]
		? SUFFIX_BASE[match[2] as keyof typeof SUFFIX_BASE]
		: body.includes(":")
			? "edited"
			: defaultBase;
	return { seconds, base };
}

/** Already-parsed form on the CLI↔broker wire; re-parsing stays idempotent. */
export const timeInputObjectSchema = z.strictObject({
	seconds: z.number().finite().nonnegative(),
	base: z.enum(TIME_BASES),
});

/**
 * Zod schema for one time flag. Accepts a bare number (the command's default
 * base), an m:ss.s or seconds string with optional e/r/s suffix, or the parsed
 * object form (broker relay and double-parse of CLI output).
 */
export const timeInputSchema = (defaultBase: TimeBase = "edited") =>
	z
		.union([z.number().finite().nonnegative(), z.string().min(1).max(32), timeInputObjectSchema])
		.transform((value) => parseTimeInput(value, defaultBase));

/** The resolved instant on every timeline clock at once. */
export interface ResolvedInstant {
	edited_sec: number;
	raw_sec: number;
	source_sec: number | null;
	/** Raw (unsplit) document clip holding the instant. */
	clip_id: string | null;
	/** Index into the trim-compressed visible segment list (native clip_index). */
	clip_index: number | null;
	input_seconds: number;
	input_base: TimeBase;
	time_base: {
		edited_sec: string;
		raw_sec: string;
		source_sec: string;
	};
}

const round = (value: number) => Number(value.toFixed(3));

/**
 * Resolve one instant from any clock into all three timeline clocks. `clipId`
 * scopes source input to that clip (cutpoint); without it, source input needs
 * exactly one clip whose source range contains the value. Edited input lands
 * on a kept instant by construction; raw input inside removed media resolves
 * to the seam, matching playbackTimeToRawTime/rawTimeToPlaybackTime.
 */
export function resolveTimelineInstant(
	document: AxcutDocument,
	input: TimeInput,
	options: { clipId?: string; affinity?: "before" | "after" } = {},
): ResolvedInstant {
	if (input.base === "output")
		throw new Error(
			"INVALID_INPUT: The export/output clock has no timeline position; use edited, raw or source.",
		);
	const clips = document.timeline.clips;
	const visible = resolveVisibleClips(document);
	const projection = buildTimelinePlaybackProjection(visible, clips);
	if (projection.length === 0)
		throw new Error("TIME_OUTSIDE_PROJECT: The timeline has no kept media.");
	let raw: number;
	let edited: number;
	if (input.base === "edited") {
		edited = input.seconds;
		const end = projection.at(-1)?.playbackEndSec ?? 0;
		if (edited > end + 0.000_001)
			throw new Error(
				`TIME_OUTSIDE_PROJECT: ${round(edited)}s is past the edited duration ${round(end)}s.`,
			);
		raw = playbackTimeToRawTime(edited, projection, options.affinity ?? "after");
	} else if (input.base === "raw") {
		raw = input.seconds;
		edited = rawTimeToPlaybackTime(raw, projection);
	} else {
		const clip = options.clipId
			? clips.find((candidate) => candidate.id === options.clipId)
			: undefined;
		if (options.clipId && !clip) throw new Error(`NOT_FOUND: No clip with id ${options.clipId}.`);
		if (
			clip &&
			(input.seconds < clip.sourceStartSec ||
				input.seconds > (clip.sourceEndSec ?? clip.sourceStartSec))
		)
			throw new Error(
				`TIME_OUTSIDE_PROJECT: Source ${round(input.seconds)}s is outside ${clip.id}.`,
			);
		const containing = clip
			? [clip]
			: clips.filter(
					(candidate) =>
						input.seconds >= candidate.sourceStartSec &&
						input.seconds <= (candidate.sourceEndSec ?? candidate.sourceStartSec),
				);
		if (containing.length === 0)
			throw new Error(
				`TIME_OUTSIDE_PROJECT: Source ${round(input.seconds)}s is outside ${options.clipId ?? "every clip"}.`,
			);
		const holder = containing[0];
		raw = holder.timelineStartSec + (input.seconds - holder.sourceStartSec);
		edited = rawTimeToPlaybackTime(raw, projection);
	}
	const position = resolveNativePosition(raw, visible, clips);
	const part = position ? projection[position.clipIndex] : undefined;
	return {
		edited_sec: round(edited),
		raw_sec: round(raw),
		source_sec: position ? round(position.sourceTimeSec) : null,
		clip_id: part?.rawClipId ?? null,
		clip_index: position?.clipIndex ?? null,
		input_seconds: input.seconds,
		input_base: input.base,
		time_base: {
			edited_sec: TIME_BASE_LABELS.edited,
			raw_sec: TIME_BASE_LABELS.raw,
			source_sec: TIME_BASE_LABELS.source,
		},
	};
}

/** Edited playback seconds for a time flag in any base; placement/state input. */
export function resolveEditedSeconds(document: AxcutDocument, input: TimeInput): number {
	return input.base === "edited"
		? input.seconds
		: resolveTimelineInstant(document, input).edited_sec;
}

/**
 * The export clock: speed-adjusted output seconds for an edited instant.
 * Moved here from agentFrames so agentPreview can convert suffixed --time
 * input without an import cycle. `frame(s) --at` converts the editor clock
 * through this map; `preview --time` already IS this clock.
 */
export function editedToExportTime(document: AxcutDocument, at: number) {
	const visible = resolveVisibleClips(document);
	const projection = buildTimelinePlaybackProjection(visible, document.timeline.clips);
	if (!Number.isFinite(at) || at < 0 || at >= (projection.at(-1)?.playbackEndSec ?? 0))
		throw new Error("FRAME_TIME_OUTSIDE_PROJECT");
	const raw = playbackTimeToRawTime(at, projection);
	const position = resolveNativePosition(raw, visible, document.timeline.clips);
	if (!position) throw new Error("FRAME_TIME_OUTSIDE_PROJECT");
	const spans = buildExportTimeMap(
		buildCompositorClipInputs(document),
		buildSceneDescription(document).speedRegions,
	);
	let framesBefore = 0;
	for (const span of spans) {
		const duration = span.sourceEndSec - span.sourceStartSec;
		const speed = duration / (span.outputEndSec - span.outputStartSec);
		const frames =
			duration <= 0.0001 ? 0 : Math.max(0, Math.ceil(((duration - 0.001) / speed) * 60));
		if (
			span.clipIndex === position.clipIndex &&
			position.sourceTimeSec >= span.sourceStartSec &&
			position.sourceTimeSec < span.sourceEndSec
		) {
			return (
				(framesBefore +
					Math.min(
						Math.max(0, frames - 1),
						Math.floor(((position.sourceTimeSec - span.sourceStartSec) / speed) * 60),
					)) /
				60
			);
		}
		framesBefore += frames;
	}
	throw new Error("FRAME_TIME_OUTSIDE_PROJECT");
}

/** Output/export seconds for a time flag in any base; preview input. */
export function resolveExportSeconds(document: AxcutDocument, input: TimeInput): number {
	return input.base === "output"
		? input.seconds
		: editedToExportTime(document, resolveEditedSeconds(document, input));
}

/**
 * The `check --rule reply.time-base` rule: audits a reply payload for
 * camelCase `*Sec` fields whose containing object — or any ancestor — carries
 * no time_base label. CLI-local by design: it scans replies, not documents,
 * so it is not part of the editor's document check rule list.
 */
export const REPLY_TIME_BASE_RULE = {
	id: "reply.time-base",
	severity: "warning" as const,
	describe:
		"Flags any reply field named *Sec whose object carries no time_base label (a time_base, timeBase or time_bases key on it or an ancestor). Durations and offsets are exempt.",
	fix: "Label the field's clock with a time_base sibling, as state and inspect already do.",
};

const BASE_KEYS = new Set(["time_base", "timeBase", "time_bases"]);
const DURATIONISH =
	/duration|saved|remaining|distance|offset|gap|pause|pad|fade|elapsed|timeout|interval|wait|minimum|maximum|expires|transition|kept|shortened/i;

export function findUnbasedSecFields(value: unknown, limit = 50): string[] {
	const out: string[] = [];
	const walk = (node: unknown, path: string, labeled: boolean) => {
		if (out.length >= limit || node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const [index, item] of node.entries()) walk(item, `${path}[${index}]`, labeled);
			return;
		}
		const record = node as Record<string, unknown>;
		const here = labeled || Object.keys(record).some((key) => BASE_KEYS.has(key));
		for (const [key, item] of Object.entries(record)) {
			if (typeof item === "number" && /Sec$/.test(key) && !here && !DURATIONISH.test(key))
				out.push(`${path}.${key}`);
			walk(item, `${path}.${key}`, here);
		}
	};
	walk(value, "$", false);
	return out;
}
