import type { CheckRun } from "../../src/lib/ai-edition/agent/agentCheckAnalysis";
import { resolveStateReport } from "../../src/lib/ai-edition/agent/effectiveState";
import { type CheckResult, runChecks } from "../../src/lib/ai-edition/checks";
import {
	type AudioObservation,
	buildResolvedEdit,
	type Span,
} from "../../src/lib/ai-edition/checks/context";
import type { Finding } from "../../src/lib/ai-edition/checks/types";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { rawTimeToPlaybackTime } from "../../src/lib/ai-edition/timeline/timelineMap";
import { trimAppliesToClip } from "../../src/lib/ai-edition/timeline/trim-mapping";

function rows(document: AxcutDocument) {
	return [
		...document.annotations,
		...(document.videoOverlays ?? []),
		...document.zoomRanges,
		...(Array.isArray(document.legacyEditor?.cameraFullscreenRegions)
			? document.legacyEditor.cameraFullscreenRegions
			: []),
		...(Array.isArray(document.legacyEditor?.speedRegions)
			? document.legacyEditor.speedRegions
			: []),
	];
}
export function touchedSpan(before: AxcutDocument, after: AxcutDocument): Span {
	before = documentSchema.parse(before);
	after = documentSchema.parse(after);
	const contexts = [buildResolvedEdit(before), buildResolvedEdit(after)];
	const spans: Span[] = [];
	const changed = <T extends { id: string }>(left: T[], right: T[]) => {
		const a = new Map(left.map((row) => [row.id, JSON.stringify(row)]));
		const b = new Map(right.map((row) => [row.id, JSON.stringify(row)]));
		return new Set([...a.keys(), ...b.keys()].filter((id) => a.get(id) !== b.get(id)));
	};
	const regions = changed(rows(before), rows(after));
	const clips = changed(before.timeline.clips, after.timeline.clips);
	const trims = changed(before.timeline.trimRanges, after.timeline.trimRanges);
	const audio = changed(before.timeline.audioClips ?? [], after.timeline.audioClips ?? []);
	for (const id of new Set([
		...Object.keys(before.clipLayouts ?? {}),
		...Object.keys(after.clipLayouts ?? {}),
	]))
		if (JSON.stringify(before.clipLayouts?.[id]) !== JSON.stringify(after.clipLayouts?.[id]))
			clips.add(id);
	for (const context of contexts) {
		const doc = context.document;
		for (const region of context.authored.filter((r) => regions.has(r.id))) {
			spans.push(...region.pieces.map((p) => p.edited));
			if (!region.pieces.length) spans.push({ startSec: region.at, endSec: region.at + 0.001 });
		}
		for (const clip of doc.timeline.clips) {
			const edited = (source: number) =>
				rawTimeToPlaybackTime(
					clip.timelineStartSec +
						((source - clip.sourceStartSec) * (clip.timelineEndSec - clip.timelineStartSec)) /
							Math.max(0.001, (clip.sourceEndSec ?? clip.sourceStartSec) - clip.sourceStartSec),
					context.projection,
				);
			if (clips.has(clip.id))
				spans.push({
					startSec: rawTimeToPlaybackTime(clip.timelineStartSec, context.projection),
					endSec: rawTimeToPlaybackTime(clip.timelineEndSec, context.projection),
				});
			for (const trim of doc.timeline.trimRanges.filter(
				(t) => trims.has(t.id) && trimAppliesToClip(t, clip),
			))
				spans.push({
					startSec: Math.max(0, edited(trim.startSec) - 3),
					endSec: edited(trim.endSec) + 3,
				});
		}
		for (const clip of doc.timeline.audioClips ?? [])
			if (audio.has(clip.id)) spans.push({ startSec: clip.startSec, endSec: clip.endSec });
	}
	const settings = (doc: AxcutDocument) => {
		const {
			cameraFullscreenRegions: _camera,
			speedRegions: _speed,
			...rest
		} = doc.legacyEditor ?? {};
		return rest;
	};
	if (JSON.stringify(settings(before)) !== JSON.stringify(settings(after)) || !spans.length)
		return { startSec: 0, endSec: Math.max(...contexts.map((c) => c.durationSec)) };
	return {
		startSec: Math.min(...spans.map((s) => s.startSec)),
		endSec: Math.max(...spans.map((s) => s.endSec)),
	};
}
export function rangeForDocument(document: AxcutDocument, span: Span) {
	const duration = buildResolvedEdit(document).durationSec;
	if (!duration) return undefined;
	const endSec = Math.min(duration, Math.max(0.001, span.endSec));
	// Clamp BOTH ends: union spans from touchedSpan carry playback-projection
	// float noise (a -5e-8 startSec on an anchored-at-zero overlay) and removed
	// footage past a shortened candidate's end.
	return { startSec: Math.min(Math.max(0, span.startSec), Math.max(0, endSec - 0.001)), endSec };
}
export function planChecks(
	document: AxcutDocument,
	span: Span,
	files: Readonly<Record<string, boolean | null>> = {},
	audio?: ReadonlyMap<string, AudioObservation>,
) {
	return runChecks(
		buildResolvedEdit(document, {
			files,
			...(audio ? { audio, audioAssets: new Set(audio.keys()) } : {}),
		}),
		{ range: rangeForDocument(document, span) },
	);
}
export class PlanCheckError extends Error {
	constructor(readonly findings: Finding[]) {
		super("CHECK_ERRORS: Plan has error findings; apply their fixes or use --force.");
	}
}
export function assertPlanChecks(checks: ReturnType<typeof planChecks>, force: boolean) {
	if (checks.counts.error && !force)
		throw new PlanCheckError(checks.findings.filter((f) => f.severity === "error"));
}
/** Edited-time spans shift with every trim, so a finding is identified by what it says, not where it sits. */
const findingKey = (f: Finding) => JSON.stringify([f.rule, f.clip, f.message, f.fix]);
/** Findings the candidate adds over the current document; pre-existing ones never block a write. */
export function introducedFindings(baseline: CheckResult, result: CheckResult): Finding[] {
	const before = new Set(baseline.findings.map(findingKey));
	return result.findings.filter((f) => !before.has(findingKey(f)));
}
export function assertIntroducedChecks(baseline: CheckResult, checks: CheckResult, force: boolean) {
	const errors = introducedFindings(baseline, checks).filter((f) => f.severity === "error");
	if (errors.length && !force) throw new PlanCheckError(errors);
}
const time = (seconds: number) =>
	`${Math.floor(seconds / 60)}:${(Math.floor((seconds % 60) * 10) / 10).toFixed(1).padStart(4, "0")}`;
export function buildVerify(
	before: AxcutDocument,
	after: AxcutDocument,
	span: Span,
	beforeRun?: CheckRun,
	afterRun?: CheckRun,
) {
	const baseline = beforeRun?.result ?? planChecks(before, span);
	const result = afterRun?.result ?? planChecks(after, span);
	const key = findingKey;
	const complete =
		beforeRun?.status === "ready" &&
		afterRun?.status === "ready" &&
		baseline.findings.length === baseline.total &&
		result.findings.length === result.total;
	const deltaBefore = complete ? baseline : planChecks(before, span);
	const deltaAfter = complete ? result : planChecks(after, span);
	const beforeKeys = new Set(deltaBefore.findings.map(key));
	const afterKeys = new Set(deltaAfter.findings.map(key));
	const newFindings = deltaAfter.findings.filter((f) => !beforeKeys.has(key(f)));
	const resolved = deltaBefore.findings.filter((f) => !afterKeys.has(key(f)));
	const range = rangeForDocument(after, span);
	return {
		range: range ?? { startSec: 0, endSec: 0 },
		state: resolveStateReport(buildResolvedEdit(after), {
			at: range?.startSec ?? 0,
			...(range ? { range } : {}),
		}),
		checks: {
			status: afterRun?.status ?? "analyzing",
			before: baseline.counts,
			after: result.counts,
			new: newFindings,
			resolved,
			deltasComplete: complete,
			deltaScope: complete
				? "all"
				: "structural/transcript; audio and files require complete check pages",
			audio: afterRun?.audio ?? { ready: 0, pending: 0 },
			notes: [...new Set([...baseline.notes, ...result.notes])],
			...(afterRun?.error ? { error: afterRun.error } : {}),
		},
		next_actions: [
			...new Set([
				...[...newFindings]
					.sort(
						(a, b) =>
							({ error: 0, warning: 1, info: 2 })[a.severity] -
								{ error: 0, warning: 1, info: 2 }[b.severity] || a.at - b.at,
					)
					.map(
						(f) =>
							`check ${f.rule} at ${time(f.at)} → ${f.fix ? "plan the supplied fix" : f.rule === "text.over-camera" ? "move text outside the camera box" : "inspect the finding and adjust placement"}`,
					),
				...(!complete
					? [
							`check ${range ? `--range ${range.startSec} ${range.endSec}` : "--all"}; poll until ready and read all pages`,
						]
					: []),
				`export slice ${time(range?.startSec ?? 0)}–${time(range?.endSec ?? 0)} to confirm`,
			]),
		].slice(0, 6),
	};
}

export function boundAgentReply<T>(value: T): T | unknown {
	if (Buffer.byteLength(JSON.stringify(value)) < 47 * 1024) return value;
	for (const limit of [20, 5, 1, 0]) {
		const counts: Record<string, number> = {};
		function compact(item: unknown, path: string): unknown {
			if (typeof item === "string")
				return item.length > 512 ? `${item.slice(0, 512)} [truncated]` : item;
			if (Array.isArray(item)) {
				if (item.length > limit) counts[path] = item.length;
				return item.slice(0, limit).map((v, i) => compact(v, `${path}.${i}`));
			}
			if (item && typeof item === "object")
				return Object.fromEntries(
					Object.entries(item).map(([k, v]) => [
						k,
						k === "fix"
							? Buffer.byteLength(JSON.stringify(v)) <= 4096
								? v
								: null
							: compact(v, `${path}.${k}`),
					]),
				);
			return item;
		}
		const result = {
			...Object(compact(value, "reply")),
			truncated: true,
			truncation: {
				firstItems: limit,
				counts,
				note: "Use state/check/history for full detail; large strings shortened.",
			},
		};
		if (Buffer.byteLength(JSON.stringify(result)) < 47 * 1024) return result;
	}
	throw new Error("REPLY_TOO_LARGE: Cannot bound reply.");
}
