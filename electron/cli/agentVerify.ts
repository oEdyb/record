// Phase-6 wiring half: `verify --range a b` plus the --deep content pass inside
// check and apply. The detector (agentContentVerify.ts) takes media-file-clock
// times; this module owns the translation from the document's edited clock to
// per-asset source times, the mapping of detector findings onto the check
// finding shape, and the merge into paged check output. Pure module: no
// Electron imports, so parser and broker tests can load it.
//
// Gating is deliberate: `cut.clipped-word` findings are errors in check output,
// but they never join planChecks, so the plan/apply check gate is unchanged.
// RMS is supporting evidence, not proof — the finding tells the agent to listen
// or sample frames at the edge; it does not block a write by itself.

import { z } from "zod";
import type { CheckResult } from "../../src/lib/ai-edition/checks";
import { buildResolvedEdit, type Span } from "../../src/lib/ai-edition/checks/context";
import type { Finding, Severity } from "../../src/lib/ai-edition/checks/types";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	type AudioProvenance,
	type ContentFinding,
	type ContentVerifyEdge,
	verifyContentAtEdges,
} from "./agentContentVerify";
import { TIME_BASE_LABELS, timeInputObjectSchema, timeInputSchema } from "./agentTimeBase";

/** CLI input for `verify` (registered in agentContracts by the integrator). */
export const verifyCommandInput = z.strictObject({
	project_id: z.string().min(1).max(256),
	range: z
		.tuple([timeInputSchema("edited"), timeInputSchema("edited")])
		.refine(([from, to]) => to.seconds > from.seconds, "Range end must exceed start"),
	out: z.string().min(1).max(4096).optional(),
});

/** Broker wire input: bare numbers are edited seconds; the object form carries the base. */
export const verifyBrokerInput = z.strictObject({
	projectId: z.string().min(1).max(256),
	range: z
		.strictObject({
			startSec: z.union([z.number().finite().nonnegative(), timeInputObjectSchema]),
			endSec: z.union([z.number().finite().nonnegative(), timeInputObjectSchema]),
		})
		.refine((value) => {
			const seconds = (time: number | { seconds: number }) =>
				typeof time === "number" ? time : time.seconds;
			return seconds(value.endSec) > seconds(value.startSec);
		}),
	out: z.string().min(1).max(4096).optional(),
});

/** Check-rule descriptors for the findings content verification can add. */
export const CONTENT_VERIFY_RULES: readonly {
	id: string;
	severity: Severity;
	describe: string;
}[] = [
	{
		id: "cut.clipped-word",
		severity: "error",
		describe:
			"Decodes the microphone track around each cut edge with ffmpeg; an edge is consistent with clipped speech when the level 0–120 ms after it stays within 15 dB of the word tail. RMS is supporting evidence: listen or read the filmstrip before re-cutting.",
	},
	{
		id: "frame.black",
		severity: "warning",
		describe: "Samples the real frame at each cut and overlay edge; flags fully black frames.",
	},
	{
		id: "frame.identical",
		severity: "warning",
		describe:
			"Flags an edge frame byte-identical to the previous sampled frame: the picture does not change across the edge.",
	},
	{
		id: "content.unavailable",
		severity: "error",
		describe:
			"Content verification was requested but could not decode the required audio track (ffmpeg error, timeout, decode failure, or the track role missing from the media). Nothing was verified for the named edge; the verify block must not read as a pass.",
	},
];

/** One edge to verify, correlated back to the edited timeline for reporting. */
export interface ResolvedVerifyEdge {
	edge: ContentVerifyEdge;
	assetId: string;
	mediaPath: string;
	/** Edited playback seconds of the cut/overlay boundary. */
	editedAtSec: number;
	/** Owning clip or overlay id for the check finding's `clip` field. */
	ownerId: string;
}

const EPSILON = 1e-6;

/**
 * Every cut edge (both sides of every fragment boundary) and every visible
 * overlay edge inside the edited-time range, with media-file-clock times for
 * the detector. Contiguous fragments of one asset (a split with nothing
 * removed) are not cuts and are skipped.
 */
export function contentVerifyEdges(document: AxcutDocument, range: Span): ResolvedVerifyEdge[] {
	const resolved = buildResolvedEdit(document);
	const inRange = (editedSec: number) =>
		editedSec >= range.startSec - EPSILON && editedSec <= range.endSec + EPSILON;
	const edges: ResolvedVerifyEdge[] = [];
	const mediaPath = (assetId: string) =>
		document.assets.find((asset) => asset.id === assetId)?.originalPath ?? null;
	for (const cut of resolved.cuts) {
		if (!inRange(cut.at)) continue;
		const { left, right } = cut;
		if (
			left.assetId === right.assetId &&
			Math.abs(left.source.endSec - right.source.startSec) < EPSILON
		)
			continue;
		const leftPath = mediaPath(left.assetId);
		if (leftPath)
			edges.push({
				edge: { timeSec: left.source.endSec, label: `out:${left.clip}`, kind: "cut" },
				assetId: left.assetId,
				mediaPath: leftPath,
				editedAtSec: cut.at,
				ownerId: left.clip,
			});
		const rightPath = mediaPath(right.assetId);
		if (rightPath)
			edges.push({
				edge: { timeSec: right.source.startSec, label: `in:${right.clip}`, kind: "cut" },
				assetId: right.assetId,
				mediaPath: rightPath,
				editedAtSec: cut.at,
				ownerId: right.clip,
			});
	}
	// Overlay edges sample frames only. Overlay media time advances 1:1 from
	// sourceOffsetSec across the authored raw span; piece.raw locates each
	// visible fragment inside that span.
	for (const authored of resolved.authored) {
		if (authored.kind !== "video-overlay") continue;
		const overlay = (document.videoOverlays ?? []).find((row) => row.id === authored.id);
		const path = overlay ? mediaPath(overlay.assetId) : null;
		if (!overlay || !path) continue;
		const seen = new Set<number>();
		for (const piece of authored.pieces) {
			for (const [editedAtSec, rawSec] of [
				[piece.edited.startSec, piece.raw.startSec],
				[piece.edited.endSec, piece.raw.endSec],
			] as const) {
				if (!inRange(editedAtSec)) continue;
				const mediaSec = overlay.sourceOffsetSec + Math.max(0, rawSec - authored.raw.startSec);
				const key = Math.round(mediaSec * 1000);
				if (seen.has(key)) continue;
				seen.add(key);
				edges.push({
					edge: { timeSec: mediaSec, label: `overlay:${overlay.id}`, kind: "overlay" },
					assetId: overlay.assetId,
					mediaPath: path,
					editedAtSec,
					ownerId: overlay.id,
				});
			}
		}
	}
	return edges.sort((a, b) => a.editedAtSec - b.editedAtSec);
}

/** Detector finding mapped onto the check finding shape, in edited seconds. */
export function contentFindingToCheckFinding(
	finding: ContentFinding,
	edge: ResolvedVerifyEdge | undefined,
): Finding {
	const at = edge?.editedAtSec ?? finding.at;
	return {
		rule: finding.rule,
		severity: finding.severity,
		at,
		span: { startSec: Math.max(0, at - 0.001), endSec: at + 0.001 },
		clip: edge?.ownerId ?? null,
		message: edge
			? `${finding.message} (media ${finding.at.toFixed(3)}s of asset ${edge.assetId}; edited ${at.toFixed(3)}s)`
			: finding.message,
		fix: null,
	};
}

export interface ContentVerifySummary {
	/** `unavailable` means at least one required edge could not be analyzed. */
	status: "ok" | "ffmpeg-missing" | "no-edges" | "unavailable";
	/** Edited-time range the edges were collected from. */
	range: Span;
	time_base: { range: string; findings_at: string };
	edges_in_range: number;
	edges_analyzed: number;
	findings: Finding[];
	counts: { error: number; warning: number };
	/** Compact per-edge audio verdicts; full RMS buckets stay on disk in the filmstrip directory. */
	analyses: {
		label?: string;
		edited_sec: number;
		media_sec: number;
		asset_id: string;
		/** `unavailable` = nothing verified for this edge; `error` says why. */
		status: "ok" | "no-audio" | "unavailable";
		error?: string;
		tail_dbfs: number | null;
		post_dbfs: number | null;
		delta_db: number | null;
		clipped: boolean;
	}[];
	frames_sampled: number;
	filmstrip: string | null;
	notes: string[];
}

const MAX_ANALYSES_IN_REPLY = 50;
/**
 * Each edge is a synchronous ffmpeg decode; the broker runs on the app's main
 * process, so one verify pass stays bounded and the GUI cannot freeze for
 * minutes on a long recording. Narrow --range to cover the rest.
 */
export const MAX_VERIFY_EDGES_PER_RUN = 100;

/**
 * Run the phase-6 detector over every edge in the edited range. One
 * `verifyContentAtEdges` call per media file; findings come back in the check
 * shape (edited clock) so they can join check output directly. The speech
 * analysis decodes the `microphone` role by default — the isolated speech
 * track on native recordings. Failure is loud: a media file the detector
 * rejects or an edge whose required track cannot be decoded adds an
 * error-level `content.unavailable` finding instead of passing silently, and
 * the summary status becomes `unavailable`.
 */
export function runContentVerification(
	document: AxcutDocument,
	range: Span,
	options: { outDirectory?: string; ffmpeg?: string | null; audio?: AudioProvenance } = {},
): ContentVerifySummary {
	const allEdges = contentVerifyEdges(document, range);
	const edges = allEdges.slice(0, MAX_VERIFY_EDGES_PER_RUN);
	const base: ContentVerifySummary = {
		status: "ok",
		range,
		time_base: {
			range: TIME_BASE_LABELS.edited,
			findings_at: "findings.at is edited_seconds; analyses carry both edited_sec and media_sec",
		},
		edges_in_range: allEdges.length,
		edges_analyzed: edges.length,
		findings: [],
		counts: { error: 0, warning: 0 },
		analyses: [],
		frames_sampled: 0,
		filmstrip: null,
		notes:
			allEdges.length > edges.length
				? [
						`Range holds ${allEdges.length} edges; analyzed the first ${edges.length} (MAX_VERIFY_EDGES_PER_RUN). Narrow --range to cover the rest.`,
					]
				: [],
	};
	if (!edges.length) return { ...base, status: "no-edges" };
	const byMedia = new Map<string, ResolvedVerifyEdge[]>();
	for (const edge of edges) {
		const group = byMedia.get(edge.mediaPath) ?? [];
		group.push(edge);
		byMedia.set(edge.mediaPath, group);
	}
	const lookup = new Map(
		edges.map((resolved) => [`${resolved.edge.label ?? ""}|${resolved.edge.timeSec}`, resolved]),
	);
	/** Error-level finding for an edge whose audio could not be verified. */
	const unavailableFinding = (resolved: ResolvedVerifyEdge, reason: string): Finding => ({
		rule: "content.unavailable",
		severity: "error",
		at: resolved.editedAtSec,
		span: {
			startSec: Math.max(0, resolved.editedAtSec - 0.001),
			endSec: resolved.editedAtSec + 0.001,
		},
		clip: resolved.ownerId,
		message: `Content verification unavailable at edited ${resolved.editedAtSec.toFixed(3)}s (asset ${resolved.assetId}): ${reason}. Nothing was verified at this edge.`,
		fix: null,
	});
	let unavailableEdges = 0;
	let omitted = 0;
	for (const [mediaPath, group] of byMedia) {
		let result: ReturnType<typeof verifyContentAtEdges>;
		try {
			result = verifyContentAtEdges(
				mediaPath,
				group.map((resolved) => resolved.edge),
				{
					audio: options.audio ?? { role: "microphone" },
					...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}),
					...(options.outDirectory ? { outDirectory: options.outDirectory } : {}),
				},
			);
		} catch (error) {
			// A rejected asset is unavailable verification, not verified absence.
			const reason = error instanceof Error ? error.message : String(error);
			for (const resolved of group) {
				if ((resolved.edge.kind ?? "cut") !== "cut") continue;
				unavailableEdges += 1;
				base.findings.push(unavailableFinding(resolved, reason));
				base.counts.error += 1;
			}
			base.notes.push(`Skipped ${mediaPath}: ${reason}`);
			continue;
		}
		if (result.status === "ffmpeg-missing") return { ...base, status: "ffmpeg-missing" };
		for (const analysis of result.analyses) {
			const resolved = lookup.get(`${analysis.edge.label ?? ""}|${analysis.edge.timeSec}`);
			if (analysis.status === "unavailable") {
				unavailableEdges += 1;
				base.findings.push(
					unavailableFinding(
						resolved ?? {
							edge: analysis.edge,
							assetId: "",
							mediaPath,
							editedAtSec: analysis.edge.timeSec,
							ownerId: analysis.edge.label ?? "",
						},
						analysis.error ?? "decode unavailable",
					),
				);
				base.counts.error += 1;
			}
			if (base.analyses.length < MAX_ANALYSES_IN_REPLY)
				base.analyses.push({
					...(analysis.edge.label ? { label: analysis.edge.label } : {}),
					edited_sec: resolved?.editedAtSec ?? analysis.edge.timeSec,
					media_sec: analysis.edge.timeSec,
					asset_id: resolved?.assetId ?? "",
					status: analysis.status,
					...(analysis.error ? { error: analysis.error } : {}),
					tail_dbfs: analysis.tailDbFs,
					post_dbfs: analysis.postDbFs,
					delta_db: analysis.deltaDb,
					clipped: analysis.clipped,
				});
			else omitted += 1;
		}
		base.frames_sampled += result.frames.filter((frame) => frame.status === "ok").length;
		if (result.filmstrip && !base.filmstrip) base.filmstrip = result.filmstrip;
		for (const finding of result.findings) {
			const resolved = lookup.get(`${finding.label ?? ""}|${finding.at}`);
			const mapped = contentFindingToCheckFinding(finding, resolved);
			base.findings.push(mapped);
			base.counts[mapped.severity === "error" ? "error" : "warning"] += 1;
		}
	}
	if (omitted) base.notes.push(`${omitted} further edge analyses omitted from this reply.`);
	base.findings.sort((a, b) => a.at - b.at || a.rule.localeCompare(b.rule));
	if (unavailableEdges) {
		base.notes.push(
			`${unavailableEdges} edge(s) could not be verified (see content.unavailable findings); this range is not fully verified.`,
		);
		return { ...base, status: "unavailable" };
	}
	return base;
}

/**
 * Merge content findings into a (possibly paged) check result: counts, byRule,
 * total and the rule list all move together. The merge lands on the current
 * page; the note says so.
 */
export function mergeContentFindings(result: CheckResult, findings: Finding[]): CheckResult {
	if (!findings.length) return result;
	const counts: CheckResult["counts"] = {
		...result.counts,
		byRule: { ...result.counts.byRule },
	};
	for (const finding of findings) {
		counts[finding.severity] += 1;
		counts.byRule[finding.rule] = (counts.byRule[finding.rule] ?? 0) + 1;
	}
	const rules = [...result.rules];
	for (const rule of CONTENT_VERIFY_RULES)
		if (
			findings.some((finding) => finding.rule === rule.id) &&
			!rules.some((row) => row.id === rule.id)
		)
			rules.push({ id: rule.id, severity: rule.severity, describe: rule.describe });
	return {
		...result,
		findings: [...result.findings, ...findings].sort(
			(a, b) => a.at - b.at || a.rule.localeCompare(b.rule),
		),
		counts,
		total: result.total + findings.length,
		notes: [
			...result.notes,
			"cut.clipped-word/frame.black/frame.identical/content.unavailable findings come from a broker-side ffmpeg decode of the real media at each edge in range; they are merged into this page.",
		],
		rules,
	};
}

/** Result shape of the broker's contentVerification helper (summary or failure). */
export type DeepContentOutcome = ContentVerifySummary | { status: "error"; error: string };

/**
 * The findings a requested --deep pass contributes to a verify block or check
 * page. Unavailable passes contribute an error-level `content.unavailable`
 * finding — an incomplete verification must never read as a pass. A verified
 * no-audio edge is not a failure and adds nothing.
 */
export function deepContentFindings(content: DeepContentOutcome, span: Span): Finding[] {
	const findings = "findings" in content ? [...content.findings] : [];
	const reason =
		content.status === "ffmpeg-missing"
			? "ffmpeg is not available, so no edge audio was decoded"
			: content.status === "error"
				? content.error
				: null;
	if (reason)
		findings.push({
			rule: "content.unavailable",
			severity: "error",
			at: span.startSec,
			span: { startSec: span.startSec, endSec: span.endSec },
			clip: null,
			message: `Content verification was requested but is unavailable: ${reason}. The touched span was not content-verified.`,
			fix: null,
		});
	return findings;
}
