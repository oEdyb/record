// End-state grader for the fresh-agent evaluation harness (plan phase 7).
// Pure functions only: no editor, no CLI, no network. The runner collects
// evidence; this module decides pass/fail from end state plus the declared
// outcome/safety assertions.
//
// Grading semantics (wave-1 review findings 2–4):
// - Evidence extractors consume the real CLI reply shapes: check counts live at
//   data.result.counts (page-independent), transcript --all pages carry
//   data.clips[].words with words_offset continuations, staged totals are
//   data.lane_count with a possibly truncated cuts page.
// - Unavailable evidence (analysis still running, missing transcripts, an
//   unreadable document, a truncated lane page, no agent transcript) makes the
//   affected check "incomplete" and the grade "incomplete" — never "pass".
// - A proven failure outranks incomplete evidence: fail > incomplete > pass.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HASH_MODES = ["unchanged", "changed", "restored", "content_restored"];
export const GRADE_STATUSES = ["pass", "fail", "incomplete"];
const FRAME_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** sha256 of a file, hex. The project-file identity check used by every case. */
export function sha256File(filePath) {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Content equality ignores embedded recovery metadata, project.updatedAt and JSON key order. */
export function projectContentEvidence(filePath) {
	try {
		const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!document || typeof document !== "object" || !Number.isInteger(document.schemaVersion))
			return null;
		const metadata = document._klipptTransactions;
		delete document._klipptTransactions;
		if (document.project) delete document.project.updatedAt;
		const canonical = (value) =>
			Array.isArray(value)
				? value.map(canonical)
				: value && typeof value === "object"
					? Object.fromEntries(
							Object.keys(value)
								.sort()
								.map((key) => [key, canonical(value[key])]),
						)
					: value;
		return {
			contentHash: sha256Text(JSON.stringify(canonical(document))),
			receiptRequestIds: Array.isArray(metadata?.receipts)
				? metadata.receipts
						.map((receipt) => receipt.requestId)
						.filter((id) => typeof id === "string")
				: [],
		};
	} catch {
		return null;
	}
}

/** A receipt read goes through the app's real metadata/hash validation. */
export function extractRecoveredReceiptId(envelope) {
	const receipt = envelope?.data?.receipt;
	return envelope?.status === "completed" &&
		typeof receipt?.requestId === "string" &&
		/^[a-f0-9]{64}$/.test(receipt.payloadHash ?? "") &&
		typeof receipt.operationId === "string" &&
		receipt.operationId.length > 0 &&
		typeof receipt.revision === "string" &&
		receipt.revision.length > 0 &&
		typeof receipt.changed === "boolean"
		? receipt.requestId
		: null;
}

/** sha256 of a string, hex. Used to fingerprint collected transcripts. */
export function sha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The CLI prints one terminal JSON envelope per invocation on stdout, but older
 * builds can print a leading `planned` envelope first. Take the last parseable
 * JSON line; everything else is progress noise.
 */
export function parseTerminalEnvelope(stdout) {
	const lines = String(stdout ?? "").split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) continue;
		try {
			return JSON.parse(line);
		} catch {
			// not a JSON line; keep scanning upward
		}
	}
	return null;
}

function envelopeData(envelope) {
	if (!envelope || typeof envelope !== "object") return null;
	return envelope.data && typeof envelope.data === "object" ? envelope.data : envelope;
}

/**
 * Staged proposal total from a `staged` reply. The real shape is
 * { lane_count, rejected_earlier, offset, next_offset, cuts: [...] };
 * lane_count is the lane total while cuts can be a truncated page.
 */
export function extractStagedCount(envelope) {
	const data = envelopeData(envelope);
	if (!data) return null;
	if (Number.isInteger(data.lane_count)) return data.lane_count;
	for (const key of ["cuts", "staged", "proposals", "items"]) {
		if (Array.isArray(data[key])) return data[key].length;
	}
	for (const key of ["total", "count", "staged_count"]) {
		if (Number.isInteger(data[key])) return data[key];
	}
	return null;
}

/**
 * The staged cuts page for outcome checks. Returns null when the reply is
 * unavailable or truncated (next_offset set): a partial page cannot prove a
 * proposed removal.
 */
export function extractStagedCuts(envelope) {
	const data = envelopeData(envelope);
	if (!data || !Array.isArray(data.cuts)) return null;
	if (data.next_offset) return null;
	return data.cuts;
}

/**
 * Error/warning finding counts from a `check` reply. The real shape is
 * data.status "analyzing" | "ready" | "error" with totals at
 * data.result.counts.{error,warning}. Counts are computed over all findings and
 * are identical on every page (result.page/pages only paginate the findings
 * list), so one ready reply is enough. An analyzing or error reply is
 * unavailable evidence: { errors: null, warnings: null }.
 */
export function extractCheckCounts(envelope) {
	const data = envelopeData(envelope);
	if (!data) return { errors: null, warnings: null };
	if (typeof data.status === "string" && data.status !== "ready") {
		return { errors: null, warnings: null };
	}
	const result = data.result && typeof data.result === "object" ? data.result : null;
	const counts = result?.counts && typeof result.counts === "object" ? result.counts : null;
	if (counts) {
		const errors = counts.error;
		const warnings = counts.warning;
		if (Number.isInteger(errors) || Number.isInteger(warnings)) {
			return {
				errors: Number.isInteger(errors) ? errors : 0,
				warnings: Number.isInteger(warnings) ? warnings : 0,
			};
		}
	}
	return { errors: null, warnings: null };
}

/**
 * Flat text from a single-clip `transcript --clip` reply: data.words[].text
 * joined. Null when the clip has no stored transcript (status not_stored or
 * unavailable) or the reply is not a transcript reply.
 */
export function extractTranscriptText(envelope) {
	const data = envelopeData(envelope);
	if (!data) return null;
	if (
		data.transcript &&
		typeof data.transcript === "object" &&
		data.transcript.status !== "stored"
	) {
		return null;
	}
	if (Array.isArray(data.words)) {
		return data.words.map((w) => String(w?.text ?? "")).join(" ");
	}
	return null;
}

/**
 * One page of a `transcript --all` reply. Real shape: data.clips[] with
 * per-clip { id, status, words[], words_offset } (a clip's words continue on
 * the next page at words_offset), data.missing[] for clips without a stored
 * transcript, plus page/pages/next_page/missing_count. Null when the envelope
 * is not an --all reply (error envelope, wrong command).
 */
export function extractTranscriptAllPage(envelope) {
	const data = envelopeData(envelope);
	if (!data || !Array.isArray(data.clips)) return null;
	return {
		page: Number.isInteger(data.page) ? data.page : null,
		pages: Number.isInteger(data.pages) ? data.pages : null,
		nextPage: Number.isInteger(data.next_page) ? data.next_page : null,
		missingCount: Number.isInteger(data.missing_count) ? data.missing_count : null,
		missing: data.missing && Array.isArray(data.missing) ? data.missing : [],
		clips: data.clips.map((clip) => ({
			id: String(clip?.id ?? ""),
			status: String(clip?.status ?? ""),
			wordsOffset: Number.isInteger(clip?.words_offset) ? clip.words_offset : 0,
			words: (Array.isArray(clip?.words) ? clip.words : []).map((w) => ({
				text: String(w?.text ?? ""),
				part: Number.isInteger(w?.part) ? w.part : null,
				parts: Number.isInteger(w?.parts) ? w.parts : null,
			})),
		})),
	};
}

/**
 * Merge transcript --all pages into one comparable text: per clip, in timeline
 * order, `# <clipId> [status]` followed by the words; missing clips are listed
 * with their status so a lost transcript changes the fingerprint. A clip's
 * continuation page must start exactly where the previous page stopped
 * (words_offset); a gap means a page was lost and the merge is incomplete.
 * Words split by the reply budget (part/parts) are reassembled.
 * Returns { text, missingCount, complete }.
 */
export function mergeTranscriptPages(pages) {
	if (!pages.length || pages.some((page) => page === null)) {
		return { text: null, missingCount: null, complete: false };
	}
	const order = [];
	const byClip = new Map();
	const missing = [];
	let missingCount = null;
	let complete = true;
	for (const page of pages) {
		if (page.missingCount !== null) missingCount = page.missingCount;
		missing.push(...page.missing);
		for (const clip of page.clips) {
			if (!byClip.has(clip.id)) {
				byClip.set(clip.id, { status: clip.status, words: [] });
				order.push(clip.id);
			}
			const entry = byClip.get(clip.id);
			if (clip.wordsOffset !== entry.words.length) complete = false;
			entry.words.push(...clip.words);
		}
	}
	const lines = [];
	for (const id of order) {
		const entry = byClip.get(id);
		const words = [];
		let buffer = null;
		for (const word of entry.words) {
			if (word.parts && word.parts > 1) {
				buffer = buffer ?? [];
				buffer.push(word.text);
				if (word.part === word.parts) {
					words.push(buffer.join(""));
					buffer = null;
				}
			} else {
				if (buffer) {
					words.push(buffer.join(""));
					buffer = null;
					complete = false;
				}
				words.push(word.text);
			}
		}
		if (buffer) {
			words.push(buffer.join(""));
			complete = false;
		}
		lines.push(`# ${id} [${entry.status}]`, words.join(" "));
	}
	for (const m of missing) {
		lines.push(`# missing ${String(m?.id ?? "")} [${String(m?.status ?? "")}]`);
	}
	return { text: lines.join("\n"), missingCount, complete };
}

/** Transcript comparison. `firstDifference` is a short context string, not a full diff. */
export function diffTranscript(before, after) {
	if (before === null || after === null) {
		return { changed: before !== after, firstDifference: null, incomplete: true };
	}
	if (before === after) return { changed: false, firstDifference: null, incomplete: false };
	let i = 0;
	while (i < before.length && i < after.length && before[i] === after[i]) i += 1;
	const start = Math.max(0, i - 40);
	return {
		changed: true,
		firstDifference: `offset ${i}: …${JSON.stringify(before.slice(start, i + 40))} → …${JSON.stringify(after.slice(start, i + 40))}`,
		incomplete: false,
	};
}

/** Count rendered images, including native preview subdirectories. Do not follow symlinks. */
export function countFrames(framesDir) {
	if (!framesDir || !fs.existsSync(framesDir)) return 0;
	return fs.readdirSync(framesDir, { withFileTypes: true }).reduce((count, entry) => {
		if (entry.isDirectory()) return count + countFrames(path.join(framesDir, entry.name));
		return (
			count + Number(entry.isFile() && FRAME_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
		);
	}, 0);
}

/**
 * Read-only projection of a canonical saved project file for outcome checks:
 * asset id → { label, originalPath, durationSec } and the video overlays with
 * raw-timeline ranges. Returns null for unreadable or legacy (pre-schemaVersion)
 * files; the CLI's inspection replies do not expose overlays, and grading must
 * not migrate or write, so a legacy project is incomplete evidence.
 */
export function projectDocumentEvidence(filePath) {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || !Number.isInteger(raw.schemaVersion)) return null;
	const assets = {};
	for (const asset of Array.isArray(raw.assets) ? raw.assets : []) {
		if (!asset || typeof asset.id !== "string") continue;
		assets[asset.id] = {
			label: typeof asset.label === "string" ? asset.label : null,
			originalPath: typeof asset.originalPath === "string" ? asset.originalPath : null,
			durationSec: typeof asset.durationSec === "number" ? asset.durationSec : null,
		};
	}
	const overlays = (Array.isArray(raw.videoOverlays) ? raw.videoOverlays : [])
		.filter((overlay) => overlay && typeof overlay.id === "string")
		.map((overlay) => ({
			id: overlay.id,
			assetId: typeof overlay.assetId === "string" ? overlay.assetId : null,
			startSec: typeof overlay.startMs === "number" ? overlay.startMs / 1000 : null,
			endSec: typeof overlay.endMs === "number" ? overlay.endMs / 1000 : null,
			placement: overlay.placement ?? null,
			motion: overlay.motion ?? null,
			opacity: typeof overlay.opacity === "number" ? overlay.opacity : 1,
			fit: typeof overlay.fit === "string" ? overlay.fit : "cover",
		}));
	return { schemaVersion: raw.schemaVersion, assets, overlays };
}

/**
 * Agent history entries from a `history` reply (newest first), projected to the
 * fields the safety checks need. Null when the reply is unavailable.
 */
export function extractHistoryEntries(envelope) {
	const data = envelopeData(envelope);
	if (!data || !Array.isArray(data.entries)) return null;
	return data.entries.map((entry) => ({
		applyId: String(entry?.applyId ?? ""),
		requestId: typeof entry?.requestId === "string" ? entry.requestId : null,
		kind: String(entry?.kind ?? ""),
		targetCount: Array.isArray(entry?.targetIds) ? entry.targetIds.length : null,
		planSummary: typeof entry?.planSummary === "string" ? entry.planSummary : "",
	}));
}

function addCheck(checks, name, pass, expected, actual, incomplete = false) {
	checks.push({ name, pass, expected, actual, ...(incomplete ? { incomplete: true } : {}) });
}

const nearly = (a, b, epsilon = 0.001) => a !== null && b !== null && Math.abs(a - b) <= epsilon;

const samePlacement = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function assetPath(asset) {
	return asset && typeof asset.originalPath === "string" ? asset.originalPath : "";
}

/** outcome.new_overlay: a new overlay from the given media directory at the intended range. */
function gradeNewOverlay(spec, baseline, after) {
	if (!Array.isArray(spec.range_raw_sec) || spec.range_raw_sec.length !== 2) {
		throw new Error(
			"outcome.new_overlay: range_raw_sec must be [startSec, endSec] on the raw timeline",
		);
	}
	if (typeof spec.asset_path_prefix !== "string" || spec.asset_path_prefix.length === 0) {
		throw new Error("outcome.new_overlay: asset_path_prefix is required");
	}
	if (!baseline.document || !after.document) {
		return {
			pass: false,
			expected: "new overlay evidence",
			actual: "document unavailable",
			incomplete: true,
		};
	}
	const tolerance = typeof spec.tolerance_sec === "number" ? spec.tolerance_sec : 1.5;
	const [start, end] = spec.range_raw_sec;
	const baselineIds = new Set(baseline.document.overlays.map((overlay) => overlay.id));
	const fresh = after.document.overlays.filter((overlay) => !baselineIds.has(overlay.id));
	const fromPrefix = fresh.filter((overlay) =>
		assetPath(after.document.assets[overlay.assetId]).startsWith(spec.asset_path_prefix),
	);
	const matches = fromPrefix.filter(
		(overlay) =>
			nearly(overlay.startSec, start, tolerance) && nearly(overlay.endSec, end, tolerance),
	);
	const pass = matches.length >= 1;
	const actual = matches.length
		? `${matches[0].id} at ${matches[0].startSec?.toFixed(2)}–${matches[0].endSec?.toFixed(2)}s raw`
		: fromPrefix.length
			? `new overlay ${fromPrefix[0].id} at wrong range ${fromPrefix[0].startSec?.toFixed(2)}–${fromPrefix[0].endSec?.toFixed(2)}s raw`
			: `no new overlay with media under ${spec.asset_path_prefix}`;
	return {
		pass,
		expected: `new overlay from ${spec.asset_path_prefix} at ${start}–${end}s raw ±${tolerance}s`,
		actual,
		incomplete: false,
	};
}

/**
 * outcome.swapped_overlay: exactly one existing overlay slot changed, and the
 * change is a media swap into the given directory. Placement, motion, opacity,
 * fit and the slot start are kept; the slot may only shrink (short media).
 */
function gradeSwappedOverlay(spec, baseline, after) {
	if (typeof spec.asset_path_prefix !== "string" || spec.asset_path_prefix.length === 0) {
		throw new Error("outcome.swapped_overlay: asset_path_prefix is required");
	}
	if (!baseline.document || !after.document) {
		return {
			pass: false,
			expected: "swapped overlay evidence",
			actual: "document unavailable",
			incomplete: true,
		};
	}
	const beforeById = new Map(baseline.document.overlays.map((overlay) => [overlay.id, overlay]));
	const afterById = new Map(after.document.overlays.map((overlay) => [overlay.id, overlay]));
	const added = after.document.overlays.filter((overlay) => !beforeById.has(overlay.id));
	const removed = baseline.document.overlays.filter((overlay) => !afterById.has(overlay.id));
	const changed = [];
	for (const overlay of after.document.overlays) {
		const prev = beforeById.get(overlay.id);
		if (!prev) continue;
		const untouched =
			overlay.assetId === prev.assetId &&
			nearly(overlay.startSec, prev.startSec) &&
			nearly(overlay.endSec, prev.endSec) &&
			samePlacement(overlay.placement, prev.placement) &&
			overlay.motion === prev.motion &&
			overlay.opacity === prev.opacity &&
			overlay.fit === prev.fit;
		if (!untouched) changed.push({ before: prev, after: overlay });
	}
	const qualifies = ({ before, after: overlay }) => {
		if (overlay.assetId === before.assetId) return false;
		if (!nearly(overlay.startSec, before.startSec)) return false;
		if (overlay.endSec === null || before.endSec === null || overlay.endSec > before.endSec + 0.001)
			return false;
		if (!samePlacement(overlay.placement, before.placement)) return false;
		if (overlay.motion !== before.motion || overlay.opacity !== before.opacity) return false;
		if (overlay.fit !== before.fit) return false;
		const asset = after.document.assets[overlay.assetId];
		if (!assetPath(asset).startsWith(spec.asset_path_prefix)) return false;
		if (typeof spec.min_asset_duration_sec === "number") {
			if (asset?.durationSec === null || asset?.durationSec === undefined) return false;
			if (asset.durationSec < spec.min_asset_duration_sec - 0.05) return false;
		}
		if (typeof spec.max_asset_duration_sec === "number") {
			if (asset?.durationSec === null || asset?.durationSec === undefined) return false;
			if (asset.durationSec > spec.max_asset_duration_sec + 0.05) return false;
		}
		return true;
	};
	const qualifying = changed.filter(qualifies);
	const pass =
		added.length === 0 && removed.length === 0 && changed.length === 1 && qualifying.length === 1;
	const describe = (entry) =>
		`${entry.after.id}: asset ${entry.before.assetId} → ${entry.after.assetId}, slot ${entry.before.startSec?.toFixed(2)}–${entry.before.endSec?.toFixed(2)}s → ${entry.after.startSec?.toFixed(2)}–${entry.after.endSec?.toFixed(2)}s`;
	const actual = pass
		? describe(qualifying[0])
		: added.length || removed.length
			? `overlay set changed (+${added.length} -${removed.length})`
			: changed.length === 0
				? "no overlay slot changed"
				: changed.length > 1
					? `${changed.length} slots changed`
					: `slot change is not a clean swap: ${describe(changed[0])}`;
	return {
		pass,
		expected: `one existing slot swapped to media under ${spec.asset_path_prefix}, placement kept`,
		actual,
		incomplete: false,
	};
}

/** outcome.staged_removal: the lane holds a new proposal removing at least min_duration_sec. */
function gradeStagedRemoval(spec, baseline, after) {
	const min = typeof spec.min_duration_sec === "number" ? spec.min_duration_sec : 0;
	if (!after.stagedCuts) {
		return {
			pass: false,
			expected: "staged removal evidence",
			actual: "staged lane unavailable or truncated",
			incomplete: true,
		};
	}
	const baselineIds = new Set((baseline.stagedCuts ?? []).map((cut) => cut?.id));
	const fresh = after.stagedCuts.filter((cut) => cut && !baselineIds.has(cut.id));
	const qualifying = fresh.filter(
		(cut) =>
			Number.isFinite(cut.editedEndSec) &&
			Number.isFinite(cut.editedStartSec) &&
			cut.editedEndSec - cut.editedStartSec >= min,
	);
	const pass = qualifying.length >= 1;
	const actual = qualifying.length
		? `${qualifying[0].id} removes ${(qualifying[0].editedEndSec - qualifying[0].editedStartSec).toFixed(2)}s edited`
		: fresh.length
			? `${fresh.length} new staged cut(s), none >= ${min}s`
			: "no new staged cuts";
	return {
		pass,
		expected: `>= 1 new staged cut of at least ${min}s`,
		actual,
		incomplete: false,
	};
}

const RECEIPT_LINE = /receipt/i;
const WRITE_WITH_ID =
	/--request_id|\bagent\s+(zoom|camera|text|broll|layout|apply|clip|edges|settings|preset|auto|plan)\b/;

/**
 * safety.receipt_recovery: the agent's transcript must show a receipt lookup
 * for the interrupted request id BEFORE any retried write carrying that id.
 * A retry without a receipt lookup can duplicate a committed write.
 */
function gradeReceiptRecovery(evidence) {
	const transcript = evidence.agentTranscript;
	const requestId = evidence.requestId;
	if (typeof transcript !== "string" || transcript.length === 0 || !requestId) {
		return {
			pass: false,
			expected: "receipt lookup before retry",
			actual: "agent transcript or request id unavailable",
			incomplete: true,
		};
	}
	const lines = transcript.split("\n");
	const receiptAt = lines.findIndex((line) => line.includes(requestId) && RECEIPT_LINE.test(line));
	const retries = lines
		.map((line, index) => ({ line, index }))
		.filter(
			({ line }) =>
				line.includes(requestId) && !RECEIPT_LINE.test(line) && WRITE_WITH_ID.test(line),
		)
		.map(({ index }) => index);
	if (receiptAt === -1) {
		return {
			pass: false,
			expected: `receipt query for ${requestId} before any retry`,
			actual: retries.length
				? `no receipt query; write with the same request id at transcript line ${retries[0] + 1}`
				: "no receipt query for the interrupted request id",
			incomplete: false,
		};
	}
	const earlyRetry = retries.find((index) => index < receiptAt);
	if (earlyRetry !== undefined) {
		return {
			pass: false,
			expected: `receipt query for ${requestId} before any retry`,
			actual: `retry at transcript line ${earlyRetry + 1} precedes the receipt query at line ${receiptAt + 1}`,
			incomplete: false,
		};
	}
	return {
		pass: true,
		expected: `receipt query for ${requestId} before any retry`,
		actual: `receipt query at transcript line ${receiptAt + 1}${retries.length ? `; replay with the same id at line ${retries[0] + 1}` : "; no retry"}`,
		incomplete: false,
	};
}

/**
 * safety.history: the editor's write journal must show the run actually
 * mutated the project and then restored it. A no-op run (or an undo with
 * nothing to undo) adds no entries and fails.
 */
function gradeHistorySafety(spec, baseline, after) {
	if (!baseline.history || !after.history) {
		return {
			pass: false,
			expected: "history growth",
			actual: "history unavailable",
			incomplete: true,
		};
	}
	const baselineIds = new Set(baseline.history.map((entry) => entry.applyId));
	const fresh = after.history.filter((entry) => !baselineIds.has(entry.applyId));
	const applies = fresh.filter((entry) => entry.kind === "apply");
	const undos = fresh.filter((entry) => entry.kind === "undo");
	const minApplies = spec.min_new_applies ?? 1;
	const minUndos = spec.min_new_undos ?? 1;
	let pass = applies.length >= minApplies && undos.length >= minUndos;
	const problems = [];
	if (applies.length < minApplies) problems.push(`${applies.length} new applies (< ${minApplies})`);
	if (undos.length < minUndos) problems.push(`${undos.length} new undos (< ${minUndos})`);
	if (typeof spec.min_undo_targets === "number") {
		const deep = undos.some((entry) => (entry.targetCount ?? 0) >= spec.min_undo_targets);
		if (!deep) {
			pass = false;
			problems.push(`no undo restored >= ${spec.min_undo_targets} entries in one step`);
		}
	}
	if (spec.require_grouped_applies) {
		const groups = new Set(applies.map((entry) => entry.requestId?.split(":")[0] ?? null));
		if (!(groups.size === 1 && !groups.has(null) && applies.length >= 2)) {
			pass = false;
			problems.push("new applies are not one batch group");
		}
	}
	return {
		pass,
		expected: `>= ${minApplies} new apply + >= ${minUndos} new undo in history`,
		actual: pass
			? `${applies.length} applies, ${undos.length} undos after baseline`
			: problems.join("; ") || "no history growth",
		incomplete: false,
	};
}

/**
 * Terminal JSON envelopes embedded in an agent transcript, in order. Same
 * rule as parseTerminalEnvelope applied line by line: a trimmed line that
 * starts with "{" and parses to an envelope-shaped object counts. Agent CLIs
 * that truncate tool output in their own transcript make the affected command
 * invisible here; the usage graders fail closed in that case.
 */
export function extractTranscriptEnvelopes(agentTranscript) {
	if (typeof agentTranscript !== "string") return [];
	const envelopes = [];
	for (const line of agentTranscript.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof parsed.status === "string" &&
				parsed.data &&
				typeof parsed.data === "object"
			) {
				envelopes.push(parsed);
			}
		} catch {
			// not a JSON line; keep scanning
		}
	}
	return envelopes;
}

/**
 * Completed-or-failed `shot` replies in the transcript. Pinned from
 * runAgentShot (electron/cli/agentShot.ts): data carries instant (the resolved
 * three-base instant), image, staged and evidence blocks.
 */
export function findShotReplies(agentTranscript) {
	return extractTranscriptEnvelopes(agentTranscript).filter(
		(envelope) =>
			envelope.data.instant &&
			typeof envelope.data.instant === "object" &&
			envelope.data.image &&
			typeof envelope.data.image === "object" &&
			envelope.data.staged &&
			typeof envelope.data.staged === "object",
	);
}

/**
 * `batch` terminal envelopes in the transcript. Pinned from runAgentBatch
 * (electron/cli/agentBatch.ts): data carries batch_id, hash_before/hash_after,
 * steps[], group and frames.
 */
export function findBatchReplies(agentTranscript) {
	return extractTranscriptEnvelopes(agentTranscript).filter(
		(envelope) => typeof envelope.data.batch_id === "string" && Array.isArray(envelope.data.steps),
	);
}

const SHOT_IMAGE_SOURCES = new Set(["saved_render", "live_preview"]);

/** Shape problems of one shot reply against the usage spec; empty = clean. */
function shotReplyProblems(reply, spec) {
	const problems = [];
	const data = reply.data ?? {};
	const instant = data.instant;
	if (!instant || typeof instant !== "object") {
		problems.push("no instant block");
	} else {
		if (typeof instant.edited_sec !== "number") problems.push("instant.edited_sec is missing");
		if (typeof instant.raw_sec !== "number") problems.push("instant.raw_sec is missing");
		if (typeof instant.source_sec !== "number" && instant.source_sec !== null)
			problems.push("instant.source_sec is missing");
		const timeBase = instant.time_base;
		if (
			!timeBase ||
			typeof timeBase.edited_sec !== "string" ||
			typeof timeBase.raw_sec !== "string" ||
			typeof timeBase.source_sec !== "string"
		) {
			problems.push("instant.time_base does not label all three clocks");
		}
		if (typeof spec.edited_sec === "number" && typeof instant.edited_sec === "number") {
			const tolerance = typeof spec.tolerance_sec === "number" ? spec.tolerance_sec : 2;
			if (Math.abs(instant.edited_sec - spec.edited_sec) > tolerance) {
				problems.push(
					`instant resolved to edited ${instant.edited_sec}s, expected ${spec.edited_sec}±${tolerance}s`,
				);
			}
		}
	}
	const staged = data.staged;
	if (!staged || typeof staged !== "object") {
		problems.push("no staged block");
	} else {
		if (!Number.isInteger(staged.lane_count)) problems.push("staged.lane_count is missing");
		if (!Array.isArray(staged.in_range)) problems.push("staged.in_range is missing");
		if (typeof staged.truncated !== "boolean") problems.push("staged.truncated is missing");
		if (typeof staged.range !== "string") problems.push("staged.range is missing");
	}
	const image = data.image;
	if (!image || typeof image !== "object") {
		problems.push("no image block");
	} else {
		if (!SHOT_IMAGE_SOURCES.has(image.source)) {
			problems.push(
				`image.source is ${JSON.stringify(image.source)}, not saved_render|live_preview`,
			);
		}
		if (spec.allow_live === false && image.source !== "saved_render") {
			problems.push("image is a live grab; the case requires the saved render");
		}
		if (image.status !== "ok") problems.push(`image.status is ${JSON.stringify(image.status)}`);
		if (typeof image.path !== "string" || !image.path.length)
			problems.push("image.path is missing");
	}
	const evidenceBlock = data.evidence;
	if (!evidenceBlock || typeof evidenceBlock !== "object") {
		problems.push("no evidence block");
	} else {
		if (image && typeof image === "object" && evidenceBlock.image !== image.source) {
			problems.push("evidence.image does not match image.source");
		}
		if (evidenceBlock.state !== "live_editor") problems.push("evidence.state is not live_editor");
		if (evidenceBlock.transcript !== "saved_project")
			problems.push("evidence.transcript is not saved_project");
	}
	return problems;
}

/**
 * usage.shot: the agent transcript must show a completed `shot` reply at the
 * pinned instant with the shipped shape — three-base resolution, the staged
 * in-range block, and image.source echoed by the evidence block. Grading the
 * transcript is the declared exception (as with safety.receipt_recovery): end
 * state cannot show which command answered the question.
 */
function gradeShotUsage(spec, agentTranscript) {
	const expected =
		"a completed shot reply at the pinned instant with resolved time bases, staged-in-range, and labelled image evidence";
	if (typeof agentTranscript !== "string" || agentTranscript.length === 0) {
		return { pass: false, expected, actual: "agent transcript unavailable", incomplete: true };
	}
	const replies = findShotReplies(agentTranscript);
	if (!replies.length) {
		return {
			pass: false,
			expected,
			actual:
				"no shot reply in the agent transcript (the command was not used, or the agent CLI truncated its output)",
			incomplete: false,
		};
	}
	const ranked = replies
		.filter((reply) => reply.status === "completed")
		.map((reply) => ({ reply, problems: shotReplyProblems(reply, spec) }))
		.sort((a, b) => a.problems.length - b.problems.length);
	if (!ranked.length) {
		return {
			pass: false,
			expected,
			actual: `${replies.length} shot ${replies.length === 1 ? "reply" : "replies"}, none completed`,
			incomplete: false,
		};
	}
	const best = ranked[0];
	return {
		pass: best.problems.length === 0,
		expected,
		actual:
			best.problems.length === 0
				? `shot reply ok: edited ${best.reply.data.instant.edited_sec}s, image ${best.reply.data.image.source}`
				: best.problems.join("; "),
		incomplete: false,
	};
}

const BATCH_FRAME_STATUSES = new Set(["rendered", "no_touched_instants", "unavailable"]);

/** Shape problems of one batch reply against the usage spec; empty = clean. */
function batchReplyProblems(reply, spec, agentTranscript) {
	const problems = [];
	const data = reply.data ?? {};
	const batchId = typeof data.batch_id === "string" ? data.batch_id : null;
	if (!batchId) problems.push("no batch_id");
	if (spec.require_completed !== false) {
		if (reply.status !== "completed")
			problems.push(`batch status is ${JSON.stringify(reply.status)}`);
		if (data.stopped_early !== false) problems.push("the batch stopped early");
		if (data.first_failure) problems.push(`first_failure at step ${data.first_failure?.index}`);
	}
	const steps = Array.isArray(data.steps) ? data.steps : [];
	const minSteps = Number.isInteger(spec.min_steps) ? spec.min_steps : 1;
	if (!Number.isInteger(data.steps_total) || data.steps_total < minSteps) {
		problems.push(`steps_total ${data.steps_total} < ${minSteps}`);
	}
	if (data.steps_executed !== steps.length || data.steps_executed !== data.steps_total) {
		problems.push(
			`steps_executed ${data.steps_executed} does not cover steps_total ${data.steps_total}`,
		);
	}
	if (data.steps_completed !== data.steps_total) {
		problems.push(`steps_completed ${data.steps_completed} of ${data.steps_total}`);
	}
	steps.forEach((step, index) => {
		if (step?.status !== "completed")
			problems.push(`step ${index} status is ${JSON.stringify(step?.status)}`);
		if (step?.exit_code !== 0) problems.push(`step ${index} exit_code ${step?.exit_code}`);
		if (spec.require_grouped && batchId) {
			if (typeof step?.request_id !== "string" || !step.request_id.startsWith(`${batchId}:`)) {
				problems.push(
					`step ${index} request id ${JSON.stringify(step?.request_id)} is outside the batch group`,
				);
			}
		}
	});
	if (spec.require_grouped && batchId) {
		const group = data.group;
		if (!group || typeof group !== "object") {
			problems.push("no group block");
		} else {
			if (group.id !== batchId) problems.push("group.id does not equal batch_id");
			if (group.request_id_prefix !== `${batchId}:`)
				problems.push("group.request_id_prefix mismatch");
			if (
				typeof group.undo_command !== "string" ||
				!group.undo_command.includes(`--to ${batchId}`)
			) {
				problems.push("group.undo_command does not target the batch id");
			}
		}
	}
	if (spec.hash_mutation === "changed" || spec.hash_mutation === "unchanged") {
		const before = data.hash_before;
		const after = data.hash_after;
		if (typeof before !== "string" || typeof after !== "string") {
			problems.push("hash_before/hash_after unavailable");
		} else if (spec.hash_mutation === "changed" && before === after) {
			problems.push("hash_before equals hash_after: the batch did not mutate the document");
		} else if (spec.hash_mutation === "unchanged" && before !== after) {
			problems.push("hash_before differs from hash_after although the spec requires unchanged");
		}
	}
	const frames = data.frames;
	if (!frames || typeof frames !== "object" || !BATCH_FRAME_STATUSES.has(frames.status)) {
		problems.push("frames block missing or has an unknown status");
	} else if (frames.status === "rendered") {
		const list = Array.isArray(frames.frames) ? frames.frames : [];
		const minFrames = Number.isInteger(spec.min_frames) ? spec.min_frames : 1;
		if (list.length < minFrames)
			problems.push(`frames list has ${list.length} entries (< ${minFrames})`);
		if (list.some((frame) => typeof frame?.path !== "string")) {
			problems.push("a rendered frame has no path");
		}
	}
	if (spec.group_undo && batchId && typeof agentTranscript === "string") {
		// A command echo, not a JSON envelope: the batch reply itself carries
		// group.undo_command with the same --to <batchId> string.
		const undoLine = agentTranscript
			.split("\n")
			.find(
				(line) =>
					!line.trim().startsWith("{") &&
					line.includes("undo") &&
					line.includes("--to") &&
					line.includes(batchId),
			);
		if (!undoLine) problems.push(`no undo --to ${batchId} in the transcript`);
	}
	return problems;
}

/**
 * usage.batch: the agent transcript must show one completed `batch` terminal
 * envelope with the shipped shape — step statuses, hash_before/hash_after,
 * grouped request ids (`<batchId>:<index>`, matching
 * AgentHistoryStore.resolveGroupTarget), the group block's undo command, and
 * the frames list. group_undo additionally requires the transcript to show
 * `undo --to <batchId>`.
 */
function gradeBatchUsage(spec, agentTranscript) {
	const expected =
		"a completed batch reply with grouped steps, hash_before/hash_after, the group undo command, and the frames list";
	if (typeof agentTranscript !== "string" || agentTranscript.length === 0) {
		return { pass: false, expected, actual: "agent transcript unavailable", incomplete: true };
	}
	const replies = findBatchReplies(agentTranscript);
	if (!replies.length) {
		return {
			pass: false,
			expected,
			actual:
				"no batch reply in the agent transcript (the command was not used, or the agent CLI truncated its output)",
			incomplete: false,
		};
	}
	const ranked = replies
		.map((reply) => ({ reply, problems: batchReplyProblems(reply, spec, agentTranscript) }))
		.sort((a, b) => a.problems.length - b.problems.length);
	const best = ranked[0];
	return {
		pass: best.problems.length === 0,
		expected,
		actual:
			best.problems.length === 0
				? `batch ${best.reply.data.batch_id} ok: ${best.reply.data.steps_completed}/${best.reply.data.steps_total} steps, grouped undo point`
				: best.problems.join("; "),
		incomplete: false,
	};
}

const OUTCOME_CHECKS = {
	new_overlay: { check: "new_overlay_placed", grade: gradeNewOverlay },
	swapped_overlay: { check: "overlay_swapped", grade: gradeSwappedOverlay },
	staged_removal: { check: "staged_removal", grade: gradeStagedRemoval },
};

/**
 * Grade one case from end-state evidence.
 *
 * evidence = {
 *   baseline: {
 *     hash, stagedCount, stagedCuts, checkCounts: {errors, warnings},
 *     transcript: { text, missingCount, complete } | null,
 *     history: entries | null, document: projection | null,
 *   },
 *   after:    same shape,
 *   framesDir: absolute path the agent was told to save frames into,
 *   agentTranscript: full agent output (graded by safety.receipt_recovery and
 *     usage.shot/usage.batch; otherwise telemetry only),
 *   requestId: the request id this run seeded, when the case uses one,
 * }
 *
 * Returns { status: "pass" | "fail" | "incomplete", checks, unintendedMutations,
 * wrongTimeEdits }. wrongTimeEdits is not derivable from end state alone; a
 * wrong-time edit shows up as a failed hash/staged/transcript check, so the
 * field stays null for the report reader to annotate from the transcript.
 */
export function gradeCase(manifest, evidence) {
	const spec = manifest.grader ?? {};
	const checks = [];
	const { baseline, after } = evidence;

	const hashMode = spec.project_hash ?? null;
	if (hashMode) {
		if (!HASH_MODES.includes(hashMode)) {
			throw new Error(`case ${manifest.id}: unknown project_hash mode ${hashMode}`);
		}
		if (hashMode === "content_restored") {
			const known =
				typeof baseline.contentHash === "string" && typeof after.contentHash === "string";
			const same = known && baseline.contentHash === after.contentHash;
			addCheck(
				checks,
				"project_content_hash",
				same,
				"identical document content; retain recovery metadata",
				known ? (same ? "identical" : "differs") : "unavailable",
				!known,
			);
			const historyKnown =
				Array.isArray(baseline.history) &&
				Array.isArray(after.history) &&
				Array.isArray(after.receiptRequestIds) &&
				Array.isArray(after.recoveredReceiptIds);
			const prior = new Set(baseline.history?.map((entry) => entry.applyId) ?? []);
			const fresh = after.history?.filter((entry) => !prior.has(entry.applyId)) ?? [];
			const receiptsKept =
				historyKnown &&
				fresh.length > 0 &&
				fresh.every(
					(entry) =>
						typeof entry.requestId === "string" &&
						after.receiptRequestIds.includes(entry.requestId) &&
						after.recoveredReceiptIds.includes(entry.requestId),
				);
			addCheck(
				checks,
				"recovery_receipts_preserved",
				receiptsKept,
				"all new history requests retain embedded receipts",
				receiptsKept ? "retained" : "missing or no new history",
				!historyKnown,
			);
		} else if (baseline.hash === null || after.hash === null) {
			addCheck(checks, "project_hash", false, hashMode, "unavailable", true);
		} else {
			const same = baseline.hash === after.hash;
			// "restored" is an equality check like "unchanged"; the distinct word records
			// that the case expected mutations in between (the undo-a-batch case, which
			// additionally requires safety.history to prove the mutation happened).
			const pass = hashMode === "changed" ? !same : same;
			addCheck(checks, "project_hash", pass, hashMode, same ? "identical" : "differs");
		}
	}

	if (spec.staged) {
		const { min = null, max = null } = spec.staged;
		const actual = after.stagedCount;
		if (actual === null) {
			addCheck(
				checks,
				"staged_count",
				false,
				`${min ?? "-∞"}..${max ?? "+∞"}`,
				"unavailable",
				true,
			);
		} else {
			const pass = (min === null || actual >= min) && (max === null || actual <= max);
			addCheck(checks, "staged_count", pass, `${min ?? "-∞"}..${max ?? "+∞"}`, actual);
		}
	}

	if (spec.check) {
		const { max_new_errors = null, max_new_warnings = null } = spec.check;
		for (const [axis, maxNew] of [
			["errors", max_new_errors],
			["warnings", max_new_warnings],
		]) {
			if (maxNew === null) continue;
			const before = baseline.checkCounts?.[axis];
			const afterCount = after.checkCounts?.[axis];
			const name = axis === "errors" ? "new_check_errors" : "new_check_warnings";
			if (
				before === null ||
				before === undefined ||
				afterCount === null ||
				afterCount === undefined
			) {
				addCheck(checks, name, false, `<= ${maxNew} new`, "unavailable", true);
				continue;
			}
			const delta = afterCount - before;
			addCheck(checks, name, delta <= maxNew, `<= ${maxNew} new`, `${delta} new`);
		}
	}

	if (spec.transcript_unchanged) {
		const before = baseline.transcript;
		const afterT = after.transcript;
		const usable = (t) =>
			t && typeof t === "object" && t.text !== null && t.complete && t.missingCount === 0;
		if (!usable(before) || !usable(afterT)) {
			const why = (t) =>
				!t || typeof t !== "object" || t.text === null
					? "unavailable"
					: !t.complete
						? "page gap"
						: `${t.missingCount} clip(s) without a stored transcript`;
			addCheck(
				checks,
				"transcript_unchanged",
				false,
				"unchanged",
				`incomplete evidence (baseline: ${why(before)}; after: ${why(afterT)})`,
				true,
			);
		} else {
			const diff = diffTranscript(before.text, afterT.text);
			addCheck(
				checks,
				"transcript_unchanged",
				!diff.changed,
				"unchanged",
				diff.changed ? (diff.firstDifference ?? "differs") : "unchanged",
			);
		}
	}

	if (spec.frames?.min) {
		const actual = countFrames(evidence.framesDir);
		addCheck(checks, "frames_present", actual >= spec.frames.min, `>= ${spec.frames.min}`, actual);
	}

	if (spec.outcome) {
		for (const [key, outcomeSpec] of Object.entries(spec.outcome)) {
			const outcome = OUTCOME_CHECKS[key];
			if (!outcome) throw new Error(`case ${manifest.id}: unknown outcome key ${key}`);
			const result = outcome.grade(outcomeSpec ?? {}, baseline, after);
			addCheck(
				checks,
				outcome.check,
				result.pass,
				result.expected,
				result.actual,
				result.incomplete,
			);
		}
	}

	if (spec.safety?.receipt_recovery) {
		const result = gradeReceiptRecovery(evidence);
		addCheck(
			checks,
			"receipt_recovery",
			result.pass,
			result.expected,
			result.actual,
			result.incomplete,
		);
	}
	if (spec.safety?.history) {
		const result = gradeHistorySafety(spec.safety.history, baseline, after);
		addCheck(
			checks,
			"history_growth",
			result.pass,
			result.expected,
			result.actual,
			result.incomplete,
		);
	}

	if (spec.usage?.shot) {
		const result = gradeShotUsage(spec.usage.shot, evidence.agentTranscript);
		addCheck(checks, "shot_usage", result.pass, result.expected, result.actual, result.incomplete);
	}
	if (spec.usage?.batch) {
		const result = gradeBatchUsage(spec.usage.batch, evidence.agentTranscript);
		addCheck(checks, "batch_usage", result.pass, result.expected, result.actual, result.incomplete);
	}

	const unintendedMutations = checks.filter((c) => {
		if (c.pass || c.incomplete) return false;
		if (c.name === "project_hash") return hashMode === "unchanged";
		if (c.name === "transcript_unchanged") return true;
		return (
			c.name === "staged_count" &&
			spec.staged?.max !== undefined &&
			typeof c.actual === "number" &&
			c.actual > spec.staged.max
		);
	}).length;
	const anyFail = checks.some((c) => !c.pass && !c.incomplete);
	const anyIncomplete = checks.some((c) => c.incomplete);
	return {
		status: anyFail ? "fail" : anyIncomplete ? "incomplete" : "pass",
		checks,
		unintendedMutations,
		wrongTimeEdits: null,
	};
}

const GRADER_KEYS = new Set([
	"project_hash",
	"staged",
	"check",
	"transcript_unchanged",
	"frames",
	"outcome",
	"safety",
	"usage",
]);
const OUTCOME_KEYS = new Set(Object.keys(OUTCOME_CHECKS));
const SAFETY_KEYS = new Set(["receipt_recovery", "history"]);
const USAGE_KEYS = new Set(["shot", "batch"]);

/** Load and validate one case directory (manifest.json + prompt.md). */
export function loadCase(caseDir) {
	const manifestPath = path.join(caseDir, "manifest.json");
	const promptPath = path.join(caseDir, "prompt.md");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (typeof manifest.id !== "string" || manifest.id.length === 0) {
		throw new Error(`${manifestPath}: missing id`);
	}
	if (manifest.pending !== null && typeof manifest.pending !== "string") {
		throw new Error(`${manifestPath}: pending must be null or a string like "phase-4"`);
	}
	if (typeof manifest.source_project !== "string" || manifest.source_project.length === 0) {
		throw new Error(`${manifestPath}: missing source_project`);
	}
	if (!manifest.grader || typeof manifest.grader !== "object") {
		throw new Error(`${manifestPath}: missing grader block`);
	}
	for (const key of Object.keys(manifest.grader)) {
		if (!GRADER_KEYS.has(key)) {
			throw new Error(`${manifestPath}: unknown grader key ${key}`);
		}
	}
	for (const key of Object.keys(manifest.grader.outcome ?? {})) {
		if (!OUTCOME_KEYS.has(key)) {
			throw new Error(`${manifestPath}: unknown outcome key ${key}`);
		}
	}
	for (const key of Object.keys(manifest.grader.safety ?? {})) {
		if (!SAFETY_KEYS.has(key)) {
			throw new Error(`${manifestPath}: unknown safety key ${key}`);
		}
	}
	for (const key of Object.keys(manifest.grader.usage ?? {})) {
		if (!USAGE_KEYS.has(key)) {
			throw new Error(`${manifestPath}: unknown usage key ${key}`);
		}
	}
	if (manifest.setup !== undefined && !Array.isArray(manifest.setup)) {
		throw new Error(`${manifestPath}: setup must be an array of {argv} steps`);
	}
	const prompt = fs.readFileSync(promptPath, "utf8");
	return { dir: caseDir, manifest, prompt };
}

/** All cases under a cases directory, sorted by id. */
export function listCases(casesDir) {
	return fs
		.readdirSync(casesDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				fs.existsSync(path.join(entry.parentPath ?? casesDir, entry.name, "manifest.json")),
		)
		.map((entry) => loadCase(path.join(casesDir, entry.name)))
		.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}
