import type { AgentNativeFrameEvidence } from "../../src/lib/ai-edition/agent/agentTransport";
// Phase-4 observe command `shot`: what is on screen at one instant, and is it
// live? Resolves --at/--words on all three time bases with the phase-3
// resolver, then composes existing seams instead of duplicating them: live
// inspect (dirty/revision context), state (visible layers, nearest cuts),
// staged (proposals in range), the saved document (transcript ±5 s), and one
// image — the saved render by default, or with --live a transport seek plus a
// canvas frame grab that awaits the wave-5 settle handshake. The reply's
// image.source says which; for a live grab, image.frame_settled/freshness
// says whether the pixels are proven to postdate the seek (false on older
// shells — never silent). Pure module: no Electron imports, so tests load it
// without the app.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AxcutDocument, AxcutWord } from "../../src/lib/ai-edition/schema";
import { findPhrase } from "../../src/lib/ai-edition/timeline/overlayAnchors";
import { renderAgentFrames } from "./agentFrames";
import { loadAgentDocument } from "./agentInspection";
import type { AgentPreviewLaunch } from "./agentPreview";
import {
	type ResolvedInstant,
	resolveTimelineInstant,
	TIME_BASE_LABELS,
	type TimeInput,
	timeInputSchema,
} from "./agentTimeBase";
import type { ProposalFlowReply, ProposalFlowRequest } from "./agentWriteFlow";

export const SHOT_WINDOW_SEC = 5;

export const shotCommandInput = z
	.strictObject({
		project_id: z.string().min(1).max(256),
		// Suffixed syntax from the phase-3 resolver: 1:43/103e edited, 125.3r raw,
		// 10.4s source. Bare numbers are edited.
		at: timeInputSchema("edited").optional(),
		words: z.string().min(1).max(4000).optional(),
		live: z.boolean().default(false),
	})
	.refine((input) => (input.at !== undefined) !== (input.words !== undefined), {
		message: "Use --at or --words.",
	});

export type ShotCommandInput = z.infer<typeof shotCommandInput>;

export interface ShotDeps {
	request: ProposalFlowRequest;
	projectsDirectory: string;
	previewLaunch?: AgentPreviewLaunch;
	cacheDirectory?: string;
	/** Saved-render seam; defaults to the real frame renderer. */
	renderFrame?: typeof renderAgentFrames;
	/** Live-grab transport polling; seams keep tests synchronous. */
	pollIntervalMs?: number;
	deadlineMs?: number;
}

interface StagedCut {
	id: string;
	clipId: string;
	kind: string;
	origin: string;
	selected: boolean;
	sourceStartSec: number;
	sourceEndSec: number;
	editedStartSec: number;
	editedEndSec: number;
}

const failed = (code: string, message: string): ProposalFlowReply => ({
	status: "failed",
	error: { code, message, retryable: false, field_errors: [] },
});

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The sentence rule from `transcript --all`: punctuation end or a >= 0.8 s gap. */
function sentenceAt(words: AxcutWord[], sourceSec: number) {
	const sentences: { start: number; end: number; text: string }[] = [];
	let first = 0;
	words.forEach((word, index) => {
		const next = words[index + 1];
		if (!next || /[.!?]["'”’)]*$/.test(word.text.trim()) || next.startSec - word.endSec >= 0.8) {
			sentences.push({
				start: words[first].startSec,
				end: word.endSec,
				text: words
					.slice(first, index + 1)
					.map((item) => item.text)
					.join(" "),
			});
			first = index + 1;
		}
	});
	if (!sentences.length) return null;
	return (
		sentences.find((sentence) => sourceSec >= sentence.start && sourceSec <= sentence.end) ??
		sentences.reduce((nearest, sentence) =>
			Math.min(Math.abs(sentence.start - sourceSec), Math.abs(sentence.end - sourceSec)) <
			Math.min(Math.abs(nearest.start - sourceSec), Math.abs(nearest.end - sourceSec))
				? sentence
				: nearest,
		)
	);
}

/** Transcript ±5 s around the instant, in source seconds, from the saved document. */
function transcriptWindow(
	document: AxcutDocument,
	clipId: string | null,
	sourceSec: number | null,
) {
	const clip = document.timeline.clips.find((candidate) => candidate.id === clipId);
	if (!clip || sourceSec === null)
		return { status: "unavailable" as const, reason: "The instant is outside kept media." };
	const asset = document.assets.find((candidate) => candidate.id === clip.assetId);
	const transcript =
		document.transcripts.find((candidate) => candidate.assetId === clip.assetId) ??
		(document.transcript?.assetId === clip.assetId ? document.transcript : null);
	if (!transcript)
		return {
			status: asset?.transcriptionFailure ? ("unavailable" as const) : ("not_stored" as const),
			failure: asset?.transcriptionFailure?.kind ?? null,
		};
	const clipEnd = clip.sourceEndSec ?? Number.POSITIVE_INFINITY;
	const words = transcript.words
		.filter((word) => word.endSec > clip.sourceStartSec && word.startSec < clipEnd)
		.sort((a, b) => a.startSec - b.startSec);
	const inWindow = words.filter(
		(word) =>
			word.endSec > sourceSec - SHOT_WINDOW_SEC && word.startSec < sourceSec + SHOT_WINDOW_SEC,
	);
	const sentence = sentenceAt(words, sourceSec);
	const round = (value: number) => Number(value.toFixed(3));
	return {
		status: "stored" as const,
		clip_id: clip.id,
		window_sec: SHOT_WINDOW_SEC,
		words: inWindow.slice(0, 100).map((word) => ({
			start: round(word.startSec),
			end: round(word.endSec),
			text: word.text,
		})),
		words_truncated: inWindow.length > 100,
		sentence: sentence
			? { start: round(sentence.start), end: round(sentence.end), text: sentence.text }
			: null,
	};
}

async function collectStagedInRange(
	request: ProposalFlowRequest,
	projectId: string,
	editedSec: number,
): Promise<{
	reply?: ProposalFlowReply;
	lane_count?: number;
	in_range?: StagedCut[];
	truncated?: boolean;
}> {
	const cuts: StagedCut[] = [];
	let laneCount = 0;
	let offset = 0;
	let truncated = false;
	for (let page = 0; page < 10; page++) {
		const reply = await request("staged", { projectId, ...(offset ? { offset } : {}) });
		if (reply.status !== "completed" || !reply.data) return { reply };
		laneCount = typeof reply.data.lane_count === "number" ? reply.data.lane_count : laneCount;
		if (Array.isArray(reply.data.cuts)) cuts.push(...(reply.data.cuts as StagedCut[]));
		const next = reply.data.next_offset;
		if (typeof next !== "number") break;
		offset = next;
		if (page === 9) truncated = true;
	}
	return {
		lane_count: laneCount,
		in_range: cuts.filter(
			(cut) =>
				cut.editedStartSec <= editedSec + SHOT_WINDOW_SEC &&
				cut.editedEndSec >= editedSec - SHOT_WINDOW_SEC,
		),
		truncated,
	};
}

const JPEG_PREFIX = "data:image/jpeg;base64,";

/** --live: seek the editor to the instant and grab the composited canvas frame. */
async function grabLiveImage(
	input: ShotCommandInput,
	instant: ResolvedInstant,
	deps: ShotDeps,
	directory: string,
) {
	const runId = randomUUID();
	// Seek in raw seconds (the transport wire's documented legacy meaning):
	// already resolved locally by the phase-3 resolver, compatible with every
	// broker generation, and the broker still attaches resolved_seeks.
	// No blind settle wait: a frame sample awaits the wave-5 settle handshake
	// itself (FRAME_SETTLE_BUDGET_MS) and reports frameSettled, so the reply can
	// tell a proven-fresh frame from a possibly-stale one.
	const steps = [
		{ op: "seek", sec: instant.raw_sec },
		{ op: "sample", label: "shot", frame: true },
	];
	const deadline = Date.now() + (deps.deadlineMs ?? 30_000);
	let reply: ProposalFlowReply;
	for (;;) {
		reply = await deps.request("transport", { projectId: input.project_id, runId, steps });
		if (reply.status !== "completed" || !reply.data)
			return { source: "live_preview", status: "failed", error: "transport request failed" };
		if (reply.data.status === "ready") break;
		if (reply.data.status === "error")
			return { source: "live_preview", status: "failed", error: String(reply.data.error) };
		if (Date.now() >= deadline)
			return {
				source: "live_preview",
				status: "failed",
				error: "EDITOR_TIMEOUT: live grab did not finish",
			};
		await new Promise((resolve) => setTimeout(resolve, deps.pollIntervalMs ?? 500));
	}
	const result = reply.data.result as
		| {
				samples?: {
					label: string;
					frame?: string | null;
					currentTimeSec?: number;
					videoTimeSec?: number | null;
					/** Set by the wave-5 settle handshake; absent on older shells. */
					frameSettled?: boolean;
					nativeFrame?: AgentNativeFrameEvidence | null;
				}[];
		  }
		| undefined;
	const sample =
		result?.samples?.find((candidate) => candidate.label === "shot") ??
		result?.samples?.find((candidate) => candidate.frame);
	if (!sample?.frame || !sample.frame.startsWith(JPEG_PREFIX))
		return {
			source: "live_preview",
			status: "unavailable",
			reason: "The editor canvas returned no frame (no composited preview at this instant).",
		};
	const file = path.join(
		directory,
		`shot-${input.project_id}-${Math.round(instant.edited_sec * 1000)}-live.jpg`,
	);
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(file, Buffer.from(sample.frame.slice(JPEG_PREFIX.length), "base64"));
	// Freshness is never silent: true only when the settle handshake proved the
	// painted frame postdates the seek; false when the wait expired or the
	// shell predates the handshake (the editorSession wrapper already reports
	// false for those, an absent flag means an even older broker).
	const frameSettled = sample.frameSettled === true;
	return {
		source: "live_preview",
		status: "ok",
		path: file,
		frame_settled: frameSettled,
		freshness: frameSettled ? ("settled" as const) : ("possibly_stale" as const),
		...(frameSettled
			? {}
			: {
					freshness_note:
						sample.frameSettled === false
							? "The settle wait expired before the canvas showed a frame composed under this seek; the pixels may predate the requested instant. Re-run or cross-check with the saved render before trusting this image."
							: "This shell predates the settle handshake, so frame freshness is unproven; the pixels may predate the requested instant. Cross-check with the saved render before trusting this image.",
				}),
		captured: {
			current_time_sec: sample.currentTimeSec ?? null,
			video_time_sec: sample.videoTimeSec ?? null,
			native_frame: sample.nativeFrame ?? null,
		},
		...(Array.isArray(reply.data.resolved_seeks)
			? { resolved_seek: reply.data.resolved_seeks[0] }
			: {}),
	};
}

async function renderSavedImage(
	instant: ResolvedInstant,
	deps: ShotDeps,
	projectPath: string,
	directory: string,
) {
	if (!deps.previewLaunch)
		return {
			source: "saved_render",
			status: "unavailable",
			reason: "PREVIEW_UNAVAILABLE: trusted app launch configuration is required.",
		};
	try {
		const rendered = await (deps.renderFrame ?? renderAgentFrames)({
			projectPath,
			at: [{ seconds: instant.edited_sec, base: "edited" }],
			cacheDirectory: directory,
			launch: deps.previewLaunch,
			sheet: false,
		});
		const frame = rendered.frames[0];
		return {
			source: "saved_render",
			status: "ok",
			path: frame?.path ?? null,
			elapsed_ms: frame?.elapsedMs ?? null,
		};
	} catch (error) {
		return { source: "saved_render", status: "failed", error: errorMessage(error) };
	}
}

/**
 * One terminal reply for `shot`. Domain failures return failed replies (the
 * caller maps them to contract exit codes); broker failures pass through.
 */
export async function runAgentShot(
	input: ShotCommandInput,
	deps: ShotDeps,
): Promise<Record<string, unknown>> {
	if (!/^[A-Za-z0-9_-]+$/.test(input.project_id))
		return failed("INVALID_PROJECT_ID", "Bad project id.");
	const projectPath = path.join(deps.projectsDirectory, `${input.project_id}.klippt`);
	let loaded: Awaited<ReturnType<typeof loadAgentDocument>>;
	try {
		loaded = await loadAgentDocument(projectPath);
	} catch (error) {
		return failed(
			errorMessage(error).startsWith("ENOENT") || (error as NodeJS.ErrnoException).code === "ENOENT"
				? "NOT_FOUND"
				: "INVALID_PROJECT",
			errorMessage(error),
		);
	}
	if (loaded.document.project.id !== input.project_id)
		return failed("PROJECT_MISMATCH", "The saved project has a different ID.");

	// Resolve the instant on all three clocks against the saved document; --words
	// must match exactly one phrase.
	let at: TimeInput;
	let clipScope: string | undefined;
	let matchedWords: Record<string, unknown> | undefined;
	if (input.at !== undefined) {
		at = input.at;
	} else {
		const matches = findPhrase(loaded.document, input.words ?? "");
		if (matches.length === 0)
			return failed(
				"NOT_FOUND",
				`No stored transcript contains "${input.words}". Run klippt agent transcribe --project_id ${input.project_id} first.`,
			);
		if (matches.length > 1)
			return failed(
				"INVALID_INPUT",
				`"${input.words}" matches ${matches.length} times: ${matches
					.map((match) => `${match.clipId}@${match.sourceStartSec.toFixed(3)}s`)
					.join(", ")}. Use --at instead.`,
			);
		const match = matches[0];
		at = { seconds: (match.sourceStartSec + match.sourceEndSec) / 2, base: "source" };
		clipScope = match.clipId;
		matchedWords = {
			text: input.words,
			clip_id: match.clipId,
			source_start: match.sourceStartSec,
			source_end: match.sourceEndSec,
		};
	}
	let instant: ResolvedInstant;
	try {
		instant = resolveTimelineInstant(loaded.document, at, { clipId: clipScope });
	} catch (error) {
		const message = errorMessage(error);
		const code = /^[A-Z][A-Z0-9_]{2,}/.exec(message)?.[0] ?? "INVALID_INPUT";
		return failed(code, message);
	}

	// Live editor state: dirty flag, then layers/cuts at the resolved instant.
	const inspect = await deps.request("inspect", {});
	if (inspect.status !== "completed" || !inspect.data) return inspect;
	const live = inspect.data;
	const state = await deps.request("state", {
		projectId: input.project_id,
		at: instant.edited_sec,
	});
	if (state.status !== "completed" || !state.data) return state;
	const staged = await collectStagedInRange(deps.request, input.project_id, instant.edited_sec);
	if (staged.reply) return staged.reply;

	const directory =
		deps.cacheDirectory ?? path.join(path.dirname(deps.projectsDirectory), "cache", "agent-media");
	const image = input.live
		? await grabLiveImage(input, instant, deps, directory)
		: await renderSavedImage(instant, deps, projectPath, directory);

	const stateData = state.data as {
		revision?: unknown;
		documentHash?: unknown;
		state?: {
			clip?: unknown;
			cuts?: unknown;
			layout?: unknown;
			regions?: unknown;
		};
	};
	return {
		status: "completed",
		snapshot: loaded.snapshot,
		data: {
			project: {
				id: input.project_id,
				title: typeof live.title === "string" ? live.title : null,
				revision: stateData.revision ?? null,
				dirty: live.dirty === true,
				document_hash: stateData.documentHash ?? null,
			},
			live_editor: {
				current_time_sec: live.currentTimeSec ?? null,
				busy: live.busy === true,
				sync_pending: live.syncPending === true,
			},
			instant,
			...(matchedWords ? { matched_words: matchedWords } : {}),
			layers: {
				clip: stateData.state?.clip ?? null,
				layout: stateData.state?.layout ?? null,
				regions: stateData.state?.regions ?? [],
			},
			cuts: stateData.state?.cuts ?? null,
			staged: {
				lane_count: staged.lane_count ?? 0,
				in_range: staged.in_range ?? [],
				truncated: staged.truncated === true,
				range: `edited ±${SHOT_WINDOW_SEC}s`,
			},
			transcript: {
				source: "saved_project",
				...transcriptWindow(loaded.document, instant.clip_id, instant.source_sec),
			},
			image,
			evidence: {
				state: "live_editor",
				transcript: "saved_project",
				image: image.source,
			},
			time_bases: {
				current_time_sec: TIME_BASE_LABELS.raw,
				"instant.*": "resolved on all three clocks; see instant.time_base",
				"cuts.at/distanceSec": TIME_BASE_LABELS.edited,
				"staged.in_range.editedStartSec/editedEndSec": TIME_BASE_LABELS.edited,
				"staged.in_range.sourceStartSec/sourceEndSec": TIME_BASE_LABELS.source,
				"transcript.words.start/end": TIME_BASE_LABELS.source,
				"image.captured.video_time_sec": TIME_BASE_LABELS.source,
			},
		},
		warnings: loaded.warnings,
	};
}
