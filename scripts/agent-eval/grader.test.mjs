import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	countFrames,
	diffTranscript,
	extractCheckCounts,
	extractHistoryEntries,
	extractRecoveredReceiptId,
	extractStagedCount,
	extractStagedCuts,
	extractTranscriptAllPage,
	extractTranscriptEnvelopes,
	extractTranscriptText,
	findBatchReplies,
	findShotReplies,
	gradeCase,
	listCases,
	loadCase,
	mergeTranscriptPages,
	parseTerminalEnvelope,
	projectContentEvidence,
	projectDocumentEvidence,
	sha256File,
} from "./grader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "test-fixtures");
const CASES_DIR = path.join(__dirname, "cases");

// Fixtures are trimmed copies of real captured CLI replies (see
// artifacts/cli-cut-safety-2026-09-18) or built field-by-field from the reply
// builders (agentTranscript.ts readAllAgentTranscripts, editorAgentBroker
// history). No flattened inventions.
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
	const root = mkdtempSync(path.join(os.tmpdir(), "klippt-agent-eval-"));
	roots.push(root);
	return root;
}

/** Write a canonical-shape project file and return its document projection. */
function makeDocument({ overlays = [], assets = {} }) {
	const root = makeRoot();
	const file = path.join(root, "p.klippt");
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 11,
			assets: Object.entries(assets).map(([id, a]) => ({ id, kind: "video", ...a })),
			videoOverlays: overlays,
			timeline: { clips: [], trimRanges: [] },
		}),
	);
	return projectDocumentEvidence(file);
}

function transcriptEvidence(text) {
	return { text, missingCount: 0, complete: true };
}

function makeEvidence(overrides = {}) {
	const base = {
		hash: "aaa",
		stagedCount: 0,
		stagedCuts: [],
		checkCounts: { errors: 1, warnings: 2 },
		transcript: transcriptEvidence("hello world this is the narration"),
		history: [],
		document: null,
	};
	return {
		baseline: { ...base },
		after: { ...base },
		framesDir: null,
		agentTranscript: null,
		requestId: null,
		...overrides,
	};
}

function makeManifest(grader) {
	return { id: "test-case", grader };
}

describe("parseTerminalEnvelope", () => {
	it("returns the last JSON line when a planned envelope precedes the terminal one", () => {
		const stdout = [
			'{"status":"planned","data":{"plan_id":"p1"}}',
			"some progress noise",
			'{"status":"completed","data":{"done":true}}',
			"",
		].join("\n");
		expect(parseTerminalEnvelope(stdout)).toEqual({ status: "completed", data: { done: true } });
	});

	it("returns null for non-JSON output", () => {
		expect(parseTerminalEnvelope("not json\nstill not\n")).toBeNull();
	});
});

describe("evidence extractors on real reply shapes", () => {
	it("reads check counts from data.result.counts of a ready reply", () => {
		expect(extractCheckCounts(fixture("check-ready.json"))).toEqual({ errors: 9, warnings: 28 });
	});

	it("check counts do not depend on the findings page", () => {
		expect(extractCheckCounts(fixture("check-page2.json"))).toEqual({ errors: 9, warnings: 28 });
	});

	it("treats analyzing and error check replies as unavailable, not zero", () => {
		expect(extractCheckCounts(fixture("check-analyzing.json"))).toEqual({
			errors: null,
			warnings: null,
		});
		expect(extractCheckCounts(fixture("check-error.json"))).toEqual({
			errors: null,
			warnings: null,
		});
		expect(extractCheckCounts(null)).toEqual({ errors: null, warnings: null });
	});

	it("prefers lane_count over the possibly truncated cuts page", () => {
		expect(extractStagedCount(fixture("staged-cuts.json"))).toBe(2);
		expect(extractStagedCount(fixture("staged-truncated.json"))).toBe(7);
		expect(extractStagedCount(null)).toBeNull();
	});

	it("returns staged cuts only for a complete page", () => {
		expect(extractStagedCuts(fixture("staged-cuts.json"))).toHaveLength(2);
		expect(extractStagedCuts(fixture("staged-truncated.json"))).toBeNull();
		expect(extractStagedCuts(null)).toBeNull();
	});

	it("extracts single-clip transcript text from real word objects", () => {
		expect(extractTranscriptText(fixture("transcript-clip.json"))).toBe(
			"But this round, round one, actually",
		);
		expect(extractTranscriptText(fixture("transcript-clip-not-stored.json"))).toBeNull();
	});

	it("parses transcript --all pages and merges words across the page boundary", () => {
		const page1 = extractTranscriptAllPage(fixture("transcript-all-page1.json"));
		const page2 = extractTranscriptAllPage(fixture("transcript-all-page2.json"));
		expect(page1).toMatchObject({ page: 1, pages: 2, nextPage: 2, missingCount: 0 });
		expect(page2).toMatchObject({ page: 2, nextPage: null });
		const merged = mergeTranscriptPages([page1, page2]);
		expect(merged.complete).toBe(true);
		expect(merged.missingCount).toBe(0);
		expect(merged.text).toContain("# clip_recording_1789653794581_10 [stored]");
		expect(merged.text).toContain("But this round, round one, actually");
		// part/parts split words are reassembled
		expect(merged.text).toContain("Super");
	});

	it("marks a lost page as an incomplete merge", () => {
		const page2 = extractTranscriptAllPage(fixture("transcript-all-page2.json"));
		// page 2 continues clip_a at words_offset 4; without page 1 there is a gap
		expect(mergeTranscriptPages([page2]).complete).toBe(false);
		expect(mergeTranscriptPages([null]).complete).toBe(false);
	});

	it("keeps clips without transcripts visible in the fingerprint and count", () => {
		const page = extractTranscriptAllPage(fixture("transcript-all-missing.json"));
		const merged = mergeTranscriptPages([page]);
		expect(merged.missingCount).toBe(1);
		expect(merged.text).toContain("# missing clip_recording_1789659441187_1 [unavailable]");
	});

	it("extracts history entries with kind and target counts", () => {
		const entries = extractHistoryEntries(fixture("history-after-batch-undo.json"));
		expect(entries).toHaveLength(5);
		expect(entries[0]).toMatchObject({ kind: "undo", targetCount: 3 });
		expect(extractHistoryEntries(null)).toBeNull();
	});

	it("projects overlays and assets from a canonical project file", () => {
		const doc = makeDocument({
			assets: { a1: { label: "card.mp4", originalPath: "/media/card.mp4", durationSec: 8 } },
			overlays: [
				{ id: "vo_1", assetId: "a1", startMs: 80000, endMs: 90000, placement: null, opacity: 1 },
			],
		});
		expect(doc.overlays[0]).toMatchObject({ id: "vo_1", assetId: "a1", startSec: 80, endSec: 90 });
		expect(doc.assets.a1.originalPath).toBe("/media/card.mp4");
	});

	it("returns null document evidence for legacy or unreadable files", () => {
		const root = makeRoot();
		const legacy = path.join(root, "legacy.klippt");
		writeFileSync(legacy, JSON.stringify({ version: 2, data: {} }));
		expect(projectDocumentEvidence(legacy)).toBeNull();
		expect(projectDocumentEvidence(path.join(root, "missing.klippt"))).toBeNull();
	});
});

describe("diffTranscript", () => {
	it("reports unchanged for identical text", () => {
		expect(diffTranscript("abc", "abc").changed).toBe(false);
	});

	it("reports the first difference offset with context", () => {
		const diff = diffTranscript("hello world", "hello WORD");
		expect(diff.changed).toBe(true);
		expect(diff.firstDifference).toContain("offset 6");
	});

	it("treats unavailable pages as changed and incomplete", () => {
		const diff = diffTranscript(null, "abc");
		expect(diff).toMatchObject({ changed: true, incomplete: true });
	});
});

describe("countFrames", () => {
	it("finds native preview frames in subdirectories without counting directories or links", () => {
		const dir = makeRoot();
		const nested = path.join(dir, "klippt-preview-fixture");
		mkdirSync(nested);
		writeFileSync(path.join(nested, "frame.png"), "pixels");
		mkdirSync(path.join(dir, "not-a-frame.jpg"));
		symlinkSync(path.join(nested, "frame.png"), path.join(dir, "duplicate.png"));
		symlinkSync(dir, path.join(nested, "cycle"));
		expect(countFrames(dir)).toBe(1);
	});

	it("counts image files and ignores other files", () => {
		const dir = makeRoot();
		writeFileSync(path.join(dir, "a.png"), "x");
		writeFileSync(path.join(dir, "b.jpg"), "x");
		writeFileSync(path.join(dir, "notes.txt"), "x");
		expect(countFrames(dir)).toBe(2);
	});

	it("returns zero for a missing directory", () => {
		expect(countFrames(path.join(makeRoot(), "nope"))).toBe(0);
	});
});

describe("gradeCase core axes", () => {
	it("passes an observe-only case when nothing changed", () => {
		const grade = gradeCase(
			makeManifest({
				project_hash: "unchanged",
				staged: { min: 0, max: 0 },
				check: { max_new_errors: 0, max_new_warnings: 0 },
				transcript_unchanged: true,
			}),
			makeEvidence(),
		);
		expect(grade.status).toBe("pass");
		expect(grade.unintendedMutations).toBe(0);
	});

	it("fails an observe-only case when the hash moved, counting an unintended mutation", () => {
		const evidence = makeEvidence();
		evidence.after.hash = "bbb";
		const grade = gradeCase(
			makeManifest({ project_hash: "unchanged", staged: { max: 0 } }),
			evidence,
		);
		expect(grade.status).toBe("fail");
		expect(grade.unintendedMutations).toBe(1);
	});

	it("requires a real change for project_hash changed", () => {
		expect(gradeCase(makeManifest({ project_hash: "changed" }), makeEvidence()).status).toBe(
			"fail",
		);
		const evidence = makeEvidence();
		evidence.after.hash = "bbb";
		expect(gradeCase(makeManifest({ project_hash: "changed" }), evidence).status).toBe("pass");
	});

	it("treats restored as an equality check for the undo case", () => {
		expect(gradeCase(makeManifest({ project_hash: "restored" }), makeEvidence()).status).toBe(
			"pass",
		);
	});

	it("marks an unreadable project file incomplete instead of passing", () => {
		const evidence = makeEvidence();
		evidence.after.hash = null;
		const grade = gradeCase(makeManifest({ project_hash: "unchanged" }), evidence);
		expect(grade.status).toBe("incomplete");
		expect(grade.checks[0]).toMatchObject({ name: "project_hash", incomplete: true });
	});

	it("enforces staged min and max; unavailable lane is incomplete", () => {
		const evidence = makeEvidence();
		evidence.after.stagedCount = 2;
		expect(gradeCase(makeManifest({ staged: { min: 1, max: 3 } }), evidence).status).toBe("pass");
		expect(gradeCase(makeManifest({ staged: { min: 3 } }), evidence).status).toBe("fail");
		expect(gradeCase(makeManifest({ staged: { max: 1 } }), evidence).status).toBe("fail");
		evidence.after.stagedCount = null;
		expect(gradeCase(makeManifest({ staged: { max: 1 } }), evidence).status).toBe("incomplete");
	});

	it("flags new check errors against the baseline", () => {
		const evidence = makeEvidence();
		evidence.after.checkCounts = { errors: 3, warnings: 2 };
		const grade = gradeCase(makeManifest({ check: { max_new_errors: 0 } }), evidence);
		expect(grade.status).toBe("fail");
		expect(grade.checks.find((c) => c.name === "new_check_errors")?.actual).toBe("2 new");
	});

	it("marks unavailable check counts incomplete instead of zero new", () => {
		const evidence = makeEvidence();
		evidence.after.checkCounts = { errors: null, warnings: null };
		const grade = gradeCase(makeManifest({ check: { max_new_errors: 0 } }), evidence);
		expect(grade.status).toBe("incomplete");
		expect(grade.checks.find((c) => c.name === "new_check_errors")).toMatchObject({
			incomplete: true,
		});
	});

	it("fails when the transcript changed", () => {
		const evidence = makeEvidence();
		evidence.after.transcript = transcriptEvidence("hello world this is different");
		const grade = gradeCase(makeManifest({ transcript_unchanged: true }), evidence);
		expect(grade.status).toBe("fail");
		expect(grade.unintendedMutations).toBe(1);
	});

	it("never passes transcript_unchanged on unavailable evidence", () => {
		const unavailable = { text: null, missingCount: null, complete: false };
		const evidence = makeEvidence();
		evidence.baseline.transcript = unavailable;
		evidence.after.transcript = unavailable;
		const grade = gradeCase(makeManifest({ transcript_unchanged: true }), evidence);
		expect(grade.status).toBe("incomplete");
		expect(grade.checks[0]).toMatchObject({ name: "transcript_unchanged", incomplete: true });
	});

	it("treats clips without stored transcripts as incomplete evidence", () => {
		const evidence = makeEvidence();
		evidence.after.transcript = {
			text: "hello world this is the narration",
			missingCount: 1,
			complete: true,
		};
		const grade = gradeCase(makeManifest({ transcript_unchanged: true }), evidence);
		expect(grade.status).toBe("incomplete");
	});

	it("requires the promised frames on disk", () => {
		const dir = makeRoot();
		writeFileSync(path.join(dir, "only-one.png"), "x");
		const evidence = makeEvidence({ framesDir: dir });
		expect(gradeCase(makeManifest({ frames: { min: 2 } }), evidence).status).toBe("fail");
		writeFileSync(path.join(dir, "two.png"), "x");
		expect(gradeCase(makeManifest({ frames: { min: 2 } }), evidence).status).toBe("pass");
	});

	it("rejects an unknown project_hash mode", () => {
		expect(() => gradeCase(makeManifest({ project_hash: "sideways" }), makeEvidence())).toThrow(
			/unknown project_hash mode/,
		);
	});

	it("ranks a proven failure above incomplete evidence", () => {
		const evidence = makeEvidence();
		evidence.after.hash = "bbb"; // hard fail on project_hash unchanged
		evidence.after.checkCounts = { errors: null, warnings: null }; // unavailable
		const grade = gradeCase(
			makeManifest({ project_hash: "unchanged", check: { max_new_errors: 0 } }),
			evidence,
		);
		expect(grade.status).toBe("fail");
		expect(grade.checks.some((c) => c.incomplete)).toBe(true);
	});
});

describe("gradeCase outcome assertions", () => {
	const CARD_DIR = "/staging/edit-2026-09-17/broll/";
	const CLIPS_DIR = "/staging/play-2026-09-11/clips/";

	const cardAsset = {
		label: "rules-card.mp4",
		originalPath: `${CARD_DIR}rules-card.mp4`,
		durationSec: 10,
	};
	const gameAsset = {
		label: "astra-03-horde.mp4",
		originalPath: `${CLIPS_DIR}astra-03-horde.mp4`,
		durationSec: 9.5,
	};
	const oldAsset = { label: "old-card.mp4", originalPath: "/media/old-card.mp4", durationSec: 40 };

	it("new_overlay passes only when the intended card sits at the intended range", () => {
		const manifest = makeManifest({
			outcome: {
				new_overlay: {
					asset_path_prefix: CARD_DIR,
					range_raw_sec: [87.84, 99.45],
					tolerance_sec: 1.5,
				},
			},
		});
		const baseline = makeDocument({
			assets: { a_old: oldAsset },
			overlays: [{ id: "vo_old", assetId: "a_old", startMs: 1000, endMs: 5000 }],
		});
		const evidence = makeEvidence();
		evidence.baseline.document = baseline;
		// unrelated hash change only: no new overlay at all
		evidence.after.document = baseline;
		expect(gradeCase(manifest, evidence).status).toBe("fail");
		// new overlay from the right directory but wrong range
		evidence.after.document = makeDocument({
			assets: { a_old: oldAsset, a_card: cardAsset },
			overlays: [
				{ id: "vo_old", assetId: "a_old", startMs: 1000, endMs: 5000 },
				{ id: "vo_new", assetId: "a_card", startMs: 20000, endMs: 30000 },
			],
		});
		const wrong = gradeCase(manifest, evidence);
		expect(wrong.status).toBe("fail");
		expect(wrong.checks[0].actual).toContain("wrong range");
		// the intended placement
		evidence.after.document = makeDocument({
			assets: { a_old: oldAsset, a_card: cardAsset },
			overlays: [
				{ id: "vo_old", assetId: "a_old", startMs: 1000, endMs: 5000 },
				{ id: "vo_new", assetId: "a_card", startMs: 88300, endMs: 99100 },
			],
		});
		expect(gradeCase(manifest, evidence).status).toBe("pass");
	});

	it("new_overlay is incomplete when the document cannot be parsed", () => {
		const grade = gradeCase(
			makeManifest({
				outcome: { new_overlay: { asset_path_prefix: CARD_DIR, range_raw_sec: [1, 2] } },
			}),
			makeEvidence(),
		);
		expect(grade.status).toBe("incomplete");
		expect(grade.checks[0]).toMatchObject({ name: "new_overlay_placed", incomplete: true });
	});

	it("swapped_overlay requires one slot with changed media, placement kept", () => {
		const manifest = makeManifest({
			outcome: {
				swapped_overlay: {
					asset_path_prefix: CLIPS_DIR,
					min_asset_duration_sec: 7,
					max_asset_duration_sec: 12,
				},
			},
		});
		const slot = {
			id: "vo_slot",
			assetId: "a_old",
			startMs: 72000,
			endMs: 86000,
			placement: null,
			opacity: 0.9,
			motion: "fade",
			fit: "cover",
		};
		const baseline = makeDocument({
			assets: { a_old: oldAsset },
			overlays: [slot, { id: "vo_other", assetId: "a_old", startMs: 1000, endMs: 5000 }],
		});
		const evidence = makeEvidence();
		evidence.baseline.document = baseline;
		// no slot changed
		evidence.after.document = baseline;
		expect(gradeCase(manifest, evidence).checks[0].actual).toBe("no overlay slot changed");
		// clean swap, slot shortened to the media
		evidence.after.document = makeDocument({
			assets: { a_old: oldAsset, a_game: gameAsset },
			overlays: [
				{ ...slot, assetId: "a_game", endMs: 81500 },
				{ id: "vo_other", assetId: "a_old", startMs: 1000, endMs: 5000 },
			],
		});
		expect(gradeCase(manifest, evidence).status).toBe("pass");
		// placement moved: not a clean swap
		evidence.after.document = makeDocument({
			assets: { a_old: oldAsset, a_game: gameAsset },
			overlays: [
				{ ...slot, assetId: "a_game", placement: { x: 5, y: 5, width: 50, height: 50 } },
				{ id: "vo_other", assetId: "a_old", startMs: 1000, endMs: 5000 },
			],
		});
		expect(gradeCase(manifest, evidence).status).toBe("fail");
		// two slots changed
		evidence.after.document = makeDocument({
			assets: { a_old: oldAsset, a_game: gameAsset },
			overlays: [
				{ ...slot, assetId: "a_game" },
				{ id: "vo_other", assetId: "a_game", startMs: 1000, endMs: 5000 },
			],
		});
		const two = gradeCase(manifest, evidence);
		expect(two.status).toBe("fail");
		expect(two.checks[0].actual).toContain("2 slots changed");
		// media from the wrong directory
		evidence.after.document = makeDocument({
			assets: { a_old: oldAsset, a_other: { ...oldAsset, label: "x.mp4" } },
			overlays: [
				{ ...slot, assetId: "a_other" },
				{ id: "vo_other", assetId: "a_old", startMs: 1000, endMs: 5000 },
			],
		});
		expect(gradeCase(manifest, evidence).status).toBe("fail");
		// media longer than the promised 12 s
		evidence.after.document = makeDocument({
			assets: { a_old: oldAsset, a_game: { ...gameAsset, durationSec: 30 } },
			overlays: [
				{ ...slot, assetId: "a_game" },
				{ id: "vo_other", assetId: "a_old", startMs: 1000, endMs: 5000 },
			],
		});
		expect(gradeCase(manifest, evidence).status).toBe("fail");
	});

	it("staged_removal requires a new staged cut of real duration", () => {
		const manifest = makeManifest({ outcome: { staged_removal: { min_duration_sec: 0.8 } } });
		const evidence = makeEvidence();
		evidence.after.stagedCuts = [{ id: "cut-1", editedStartSec: 100, editedEndSec: 102.4 }];
		expect(gradeCase(manifest, evidence).status).toBe("pass");
		evidence.after.stagedCuts = [{ id: "cut-1", editedStartSec: 100, editedEndSec: 100.3 }];
		expect(gradeCase(manifest, evidence).status).toBe("fail");
		evidence.after.stagedCuts = null; // truncated lane page
		expect(gradeCase(manifest, evidence).status).toBe("incomplete");
	});
});

describe("gradeCase safety assertions", () => {
	it("receipt_recovery requires a receipt query before any retry of the request id", () => {
		const manifest = makeManifest({ safety: { receipt_recovery: true } });
		const rid = "eval-pause-proposal-recovery-2026";
		const good = makeEvidence({
			requestId: rid,
			agentTranscript: [
				"$ klippt agent receipt --project_id proj_x --request_id " + rid + " --json",
				'{"status":"completed","data":{"receipt":{"changed":true}}}',
				"The write committed; no retry needed.",
			].join("\n"),
		});
		expect(gradeCase(manifest, good).status).toBe("pass");

		const replayAfterReceipt = makeEvidence({
			requestId: rid,
			agentTranscript: [
				"$ klippt agent receipt --project_id proj_x --request_id " + rid,
				"not committed; replaying with the same id",
				"$ klippt agent zoom add --project_id proj_x --at 1:00 --request_id " + rid,
			].join("\n"),
		});
		expect(gradeCase(manifest, replayAfterReceipt).status).toBe("pass");

		const blindRetry = makeEvidence({
			requestId: rid,
			agentTranscript: [
				"$ klippt agent zoom add --project_id proj_x --at 1:00 --request_id " + rid,
			].join("\n"),
		});
		const grade = gradeCase(manifest, blindRetry);
		expect(grade.status).toBe("fail");
		expect(grade.checks[0].actual).toContain("no receipt query");

		const missingTranscript = makeEvidence({ requestId: rid, agentTranscript: null });
		expect(gradeCase(manifest, missingTranscript).status).toBe("incomplete");
	});

	it("history safety proves a real apply-then-undo cycle", () => {
		const manifest = makeManifest({
			project_hash: "restored",
			safety: {
				history: {
					min_new_applies: 3,
					min_new_undos: 1,
					min_undo_targets: 3,
					require_grouped_applies: true,
				},
			},
		});
		const evidence = makeEvidence();
		evidence.baseline.history = extractHistoryEntries(fixture("history-baseline.json"));
		evidence.after.history = extractHistoryEntries(fixture("history-after-batch-undo.json"));
		expect(gradeCase(manifest, evidence).status).toBe("pass");

		// no-op run: identical hash, no new entries — must fail
		const noOp = makeEvidence();
		noOp.baseline.history = extractHistoryEntries(fixture("history-baseline.json"));
		noOp.after.history = extractHistoryEntries(fixture("history-baseline.json"));
		expect(gradeCase(manifest, noOp).status).toBe("fail");

		// ungrouped applies are not one batch
		const loose = makeEvidence();
		loose.baseline.history = extractHistoryEntries(fixture("history-baseline.json"));
		loose.after.history = [...extractHistoryEntries(fixture("history-after-batch-undo.json"))];
		loose.after.history[1].requestId = "unrelated-a";
		loose.after.history[2].requestId = "unrelated-b";
		expect(gradeCase(manifest, loose).status).toBe("fail");

		// history unavailable
		const unavailable = makeEvidence();
		unavailable.baseline.history = null;
		unavailable.after.history = null;
		expect(gradeCase(manifest, unavailable).status).toBe("incomplete");
	});
});

describe("wave-1 review repro (grader-repro.json)", () => {
	const repro = fixture("grader-repro.json");

	it("documents the captured before-behavior", () => {
		expect(repro.missingTranscriptPass.status).toBe("pass");
		expect(repro.noOpUndoPass.status).toBe("pass");
		expect(repro.nestedTranscript).toBeNull();
		expect(repro.nestedChecks).toEqual({ errors: null, warnings: null });
	});

	it("nestedChecks: real check replies now yield their counts", () => {
		expect(extractCheckCounts(fixture("check-ready.json"))).toEqual({ errors: 9, warnings: 28 });
	});

	it("nestedTranscript: real transcript --all replies now yield text", () => {
		const merged = mergeTranscriptPages([
			extractTranscriptAllPage(fixture("transcript-all-page1.json")),
			extractTranscriptAllPage(fixture("transcript-all-page2.json")),
		]);
		expect(merged.text).not.toBeNull();
		expect(merged.complete).toBe(true);
	});

	it("missingTranscriptPass: the same scenario now grades incomplete", () => {
		const unavailable = { text: null, missingCount: null, complete: false };
		const evidence = makeEvidence();
		evidence.baseline.transcript = unavailable;
		evidence.after.transcript = unavailable;
		const grade = gradeCase(makeManifest({ transcript_unchanged: true }), evidence);
		expect(grade.status).toBe("incomplete");
		expect(grade.checks.map((c) => c.name)).toEqual(
			repro.missingTranscriptPass.checks.map((c) => c.name),
		);
	});

	it("noOpUndoPass: the same scenario now fails the history safety check", () => {
		const manifest = makeManifest({
			project_hash: "restored",
			staged: { min: 0, max: 0 },
			check: { max_new_errors: 0 },
			transcript_unchanged: true,
			safety: { history: { min_new_applies: 3, min_new_undos: 1 } },
		});
		const grade = gradeCase(manifest, makeEvidence());
		expect(grade.status).toBe("fail");
		expect(grade.checks.find((c) => c.name === "history_growth")?.pass).toBe(false);
	});
});

describe("transcript-scanned shot/batch replies (usage evidence)", () => {
	const shotReply = fixture("shot-saved-render.json");
	const batchReply = fixture("batch-completed.json");
	const batchId = batchReply.data.batch_id;

	/** A realistic agent transcript: command echoes and prose around envelopes. */
	function agentTranscriptWith(...envelopes) {
		const lines = ["$ klippt agent shot --project_id proj_evalclone --at 3:50 --json"];
		for (const envelope of envelopes) lines.push(JSON.stringify(envelope));
		lines.push("The frame at 3:50 shows the base footage with no overlays.");
		return lines.join("\n");
	}

	it("finds shot and batch envelopes among transcript noise", () => {
		const transcript = agentTranscriptWith(shotReply, batchReply);
		expect(extractTranscriptEnvelopes(transcript)).toHaveLength(2);
		expect(findShotReplies(transcript)).toHaveLength(1);
		expect(findBatchReplies(transcript)).toHaveLength(1);
		expect(findShotReplies("not json\n")).toHaveLength(0);
		expect(findBatchReplies(null)).toHaveLength(0);
	});

	it("usage.shot passes on the shipped shot reply shape", () => {
		const manifest = listCases(CASES_DIR).find(
			(c) => c.manifest.id === "observe-shot-3-50",
		).manifest;
		const dir = makeRoot();
		writeFileSync(path.join(dir, "at-3-50.png"), "x");
		const evidence = makeEvidence({
			framesDir: dir,
			agentTranscript: agentTranscriptWith(shotReply),
		});
		const grade = gradeCase(manifest, evidence);
		expect(grade.status).toBe("pass");
		expect(grade.checks.find((c) => c.name === "shot_usage")?.pass).toBe(true);
	});

	it("usage.shot fails when the agent never ran shot, or ran it at the wrong instant", () => {
		const manifest = listCases(CASES_DIR).find(
			(c) => c.manifest.id === "observe-shot-3-50",
		).manifest;
		const dir = makeRoot();
		writeFileSync(path.join(dir, "at-3-50.png"), "x");
		const noShot = makeEvidence({ framesDir: dir, agentTranscript: "$ klippt agent state …\n" });
		const noShotGrade = gradeCase(manifest, noShot);
		expect(noShotGrade.status).toBe("fail");
		expect(noShotGrade.checks.find((c) => c.name === "shot_usage")?.actual).toContain(
			"no shot reply",
		);

		const wrongInstant = JSON.parse(JSON.stringify(shotReply));
		wrongInstant.data.instant.edited_sec = 95;
		const wrongGrade = gradeCase(
			manifest,
			makeEvidence({ framesDir: dir, agentTranscript: agentTranscriptWith(wrongInstant) }),
		);
		expect(wrongGrade.status).toBe("fail");
		expect(wrongGrade.checks.find((c) => c.name === "shot_usage")?.actual).toContain(
			"expected 230±2s",
		);
	});

	it("usage.shot fails when image evidence contradicts itself or is unavailable", () => {
		const spec = { edited_sec: 230, tolerance_sec: 2, allow_live: true };
		const manifest = makeManifest({ usage: { shot: spec } });
		const mismatched = JSON.parse(JSON.stringify(shotReply));
		mismatched.data.image.source = "live_preview"; // evidence.image still says saved_render
		const grade = gradeCase(
			manifest,
			makeEvidence({ agentTranscript: agentTranscriptWith(mismatched) }),
		);
		expect(grade.status).toBe("fail");
		expect(grade.checks[0].actual).toContain("evidence.image does not match image.source");

		const failed = JSON.parse(JSON.stringify(shotReply));
		failed.data.image = { source: "saved_render", status: "failed", error: "render blew up" };
		const failedGrade = gradeCase(
			manifest,
			makeEvidence({ agentTranscript: agentTranscriptWith(failed) }),
		);
		expect(failedGrade.status).toBe("fail");
		expect(failedGrade.checks[0].actual).toContain('image.status is "failed"');
	});

	it("usage.shot honours allow_live: false", () => {
		const live = JSON.parse(JSON.stringify(shotReply));
		live.data.image = {
			source: "live_preview",
			status: "ok",
			path: "/tmp/shot-live.jpg",
			captured: { current_time_sec: 230.1, video_time_sec: 12.6 },
		};
		live.data.evidence.image = "live_preview";
		const allow = gradeCase(
			makeManifest({ usage: { shot: { edited_sec: 230, allow_live: true } } }),
			makeEvidence({ agentTranscript: agentTranscriptWith(live) }),
		);
		expect(allow.status).toBe("pass");
		const deny = gradeCase(
			makeManifest({ usage: { shot: { edited_sec: 230, allow_live: false } } }),
			makeEvidence({ agentTranscript: agentTranscriptWith(live) }),
		);
		expect(deny.status).toBe("fail");
		expect(deny.checks[0].actual).toContain("live grab");
	});

	it("usage.shot is incomplete without an agent transcript", () => {
		const grade = gradeCase(
			makeManifest({ usage: { shot: { edited_sec: 230 } } }),
			makeEvidence({ agentTranscript: null }),
		);
		expect(grade.status).toBe("incomplete");
		expect(grade.checks[0]).toMatchObject({ name: "shot_usage", incomplete: true });
	});

	it("usage.batch passes on the shipped batch reply plus the grouped undo", () => {
		const manifest = listCases(CASES_DIR).find((c) => c.manifest.id === "undo-batch").manifest;
		const evidence = makeEvidence({
			agentTranscript: [
				"$ klippt agent batch --input steps.json --json",
				JSON.stringify(batchReply),
				`$ klippt agent undo --project_id proj_evalclone --to ${batchId} --json`,
				'{"status":"completed","data":{"restored":3}}',
			].join("\n"),
		});
		evidence.baseline.history = extractHistoryEntries(fixture("history-baseline.json"));
		evidence.after.history = extractHistoryEntries(fixture("history-after-batch-undo.json"));
		evidence.baseline.contentHash = "same-document";
		evidence.after.contentHash = "same-document";
		evidence.after.hash = "different-metadata";
		evidence.after.receiptRequestIds = evidence.after.history.map((entry) => entry.requestId);
		evidence.after.recoveredReceiptIds = [...evidence.after.receiptRequestIds];
		const grade = gradeCase(manifest, evidence);
		expect(grade.status).toBe("pass");
		expect(grade.checks.find((c) => c.name === "batch_usage")?.pass).toBe(true);
	});

	it("usage.batch fails when a step failed, steps are ungrouped, or the hash did not move", () => {
		const spec = {
			min_steps: 3,
			require_completed: true,
			require_grouped: true,
			group_undo: true,
			hash_mutation: "changed",
		};
		const manifest = makeManifest({ usage: { batch: spec } });
		const undoLine = `$ klippt agent undo --project_id proj_evalclone --to ${batchId}`;

		const failedStep = JSON.parse(JSON.stringify(batchReply));
		failedStep.status = "failed";
		failedStep.data.steps_completed = 1;
		failedStep.data.stopped_early = true;
		failedStep.data.steps[2].status = "failed";
		failedStep.data.steps[2].exit_code = 3;
		failedStep.data.first_failure = { index: 2, reply: { status: "failed" } };
		const failedGrade = gradeCase(
			manifest,
			makeEvidence({ agentTranscript: `${JSON.stringify(failedStep)}\n${undoLine}` }),
		);
		expect(failedGrade.status).toBe("fail");
		expect(failedGrade.checks[0].actual).toContain("stopped early");

		const ungrouped = JSON.parse(JSON.stringify(batchReply));
		ungrouped.data.steps[1].request_id = "freelance-request";
		const ungroupedGrade = gradeCase(
			manifest,
			makeEvidence({ agentTranscript: `${JSON.stringify(ungrouped)}\n${undoLine}` }),
		);
		expect(ungroupedGrade.status).toBe("fail");
		expect(ungroupedGrade.checks[0].actual).toContain("outside the batch group");

		const noMutation = JSON.parse(JSON.stringify(batchReply));
		noMutation.data.hash_after = noMutation.data.hash_before;
		const noMutationGrade = gradeCase(
			manifest,
			makeEvidence({ agentTranscript: `${JSON.stringify(noMutation)}\n${undoLine}` }),
		);
		expect(noMutationGrade.status).toBe("fail");
		expect(noMutationGrade.checks[0].actual).toContain("did not mutate");
	});

	it("usage.batch requires the grouped undo --to line when group_undo is set", () => {
		const manifest = makeManifest({
			usage: { batch: { min_steps: 3, require_grouped: true, group_undo: true } },
		});
		const evidence = makeEvidence({ agentTranscript: JSON.stringify(batchReply) });
		const grade = gradeCase(manifest, evidence);
		expect(grade.status).toBe("fail");
		expect(grade.checks[0].actual).toContain(`no undo --to ${batchId}`);
	});

	it("usage.batch fails closed on a missing batch reply and is incomplete without a transcript", () => {
		const manifest = makeManifest({ usage: { batch: { min_steps: 3 } } });
		const noBatch = gradeCase(
			manifest,
			makeEvidence({ agentTranscript: "$ klippt agent state\n" }),
		);
		expect(noBatch.status).toBe("fail");
		expect(noBatch.checks[0].actual).toContain("no batch reply");
		const noTranscript = gradeCase(manifest, makeEvidence({ agentTranscript: null }));
		expect(noTranscript.status).toBe("incomplete");
		expect(noTranscript.checks[0]).toMatchObject({ name: "batch_usage", incomplete: true });
	});

	it("usage.batch tolerates unavailable frames but checks a rendered frames list", () => {
		const manifest = makeManifest({ usage: { batch: { min_steps: 3 } } });
		const unavailable = JSON.parse(JSON.stringify(batchReply));
		unavailable.data.frames = { status: "unavailable", reason: "FFMPEG_UNAVAILABLE" };
		expect(
			gradeCase(manifest, makeEvidence({ agentTranscript: JSON.stringify(unavailable) })).status,
		).toBe("pass");
		const emptyList = JSON.parse(JSON.stringify(batchReply));
		emptyList.data.frames.frames = [];
		const grade = gradeCase(manifest, makeEvidence({ agentTranscript: JSON.stringify(emptyList) }));
		expect(grade.status).toBe("fail");
		expect(grade.checks[0].actual).toContain("frames list has 0 entries");
	});
});

describe("case loading", () => {
	function writeCase(root, id, manifest, prompt = "# prompt\n") {
		const dir = path.join(root, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
		writeFileSync(path.join(dir, "prompt.md"), prompt);
		return dir;
	}

	const validManifest = {
		id: "demo",
		pending: null,
		source_project: "/tmp/demo.klippt",
		grader: { project_hash: "unchanged" },
	};

	it("loads a valid case with its prompt", () => {
		const root = makeRoot();
		const dir = writeCase(root, "demo", validManifest);
		const loaded = loadCase(dir);
		expect(loaded.manifest.id).toBe("demo");
		expect(loaded.prompt).toContain("prompt");
	});

	it("rejects unknown grader, outcome and safety keys", () => {
		const root = makeRoot();
		expect(() =>
			loadCase(writeCase(root, "a", { ...validManifest, id: "a", grader: { vibes: "good" } })),
		).toThrow(/unknown grader key/);
		expect(() =>
			loadCase(
				writeCase(root, "b", {
					...validManifest,
					id: "b",
					grader: { outcome: { vibes: {} } },
				}),
			),
		).toThrow(/unknown outcome key/);
		expect(() =>
			loadCase(
				writeCase(root, "c", {
					...validManifest,
					id: "c",
					grader: { safety: { vibes: true } },
				}),
			),
		).toThrow(/unknown safety key/);
		expect(() =>
			loadCase(
				writeCase(root, "d", {
					...validManifest,
					id: "d",
					grader: { usage: { vibes: {} } },
				}),
			),
		).toThrow(/unknown usage key/);
	});

	it("rejects a non-string pending flag", () => {
		const root = makeRoot();
		const dir = writeCase(root, "demo", { ...validManifest, pending: 4 });
		expect(() => loadCase(dir)).toThrow(/pending/);
	});

	it("lists cases sorted by id and skips non-case directories", () => {
		const root = makeRoot();
		writeCase(root, "zeta", { ...validManifest, id: "zeta" });
		writeCase(root, "alpha", { ...validManifest, id: "alpha" });
		mkdirSync(path.join(root, "not-a-case"));
		const cases = listCases(root);
		expect(cases.map((c) => c.manifest.id)).toEqual(["alpha", "zeta"]);
	});

	it("loads every shipped case manifest", () => {
		const cases = listCases(CASES_DIR);
		expect(cases.map((c) => c.manifest.id)).toEqual([
			"broll-swap-short",
			"observe-shot-3-50",
			"pause-proposal-recovery",
			"restrictions-card",
			"undo-batch",
		]);
	});

	it("ships no pending cases: phases 4 and 5 are in the build", () => {
		for (const evalCase of listCases(CASES_DIR)) {
			expect(evalCase.manifest.pending).toBeNull();
		}
	});

	it("sha256File fingerprints file bytes", () => {
		const root = makeRoot();
		const file = path.join(root, "p.klippt");
		writeFileSync(file, "abc");
		const first = sha256File(file);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		writeFileSync(file, "abd");
		expect(sha256File(file)).not.toBe(first);
	});
});

it("missing requested changes are failures, not unintended mutations", () => {
	const grade = gradeCase(
		makeManifest({ project_hash: "changed", staged: { min: 1 } }),
		makeEvidence(),
	);
	expect(grade.status).toBe("fail");
	expect(grade.unintendedMutations).toBe(0);
});

it("round-one restrictions excludes the general experiment rules passage", () => {
	const original = loadCase(path.join(CASES_DIR, "restrictions-card")).manifest;
	const spec = original.grader.outcome.new_overlay;
	const manifest = makeManifest({ outcome: { new_overlay: spec } });
	const evidence = makeEvidence();
	evidence.baseline.document = makeDocument({});
	const assets = { card: { originalPath: `${spec.asset_path_prefix}prompts-side-by-side.mp4` } };
	evidence.after.document = makeDocument({
		assets,
		overlays: [{ id: "card", assetId: "card", startMs: 87841, endMs: 99451 }],
	});
	expect(gradeCase(manifest, evidence).status).toBe("fail");
	evidence.after.document = makeDocument({
		assets,
		overlays: [{ id: "card", assetId: "card", startMs: 1573122, endMs: 1592642 }],
	});
	expect(gradeCase(manifest, evidence).status).toBe("pass");
});

it("content restoration retains recovery receipts and never hides changed content", () => {
	const dir = makeRoot();
	const file = path.join(dir, "project.klippt");
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 11,
			project: { title: "Before", createdAt: "creation", updatedAt: "old-save" },
			_klipptTransactions: { receipts: [] },
		}),
	);
	const baseline = projectContentEvidence(file);
	const beforeFileHash = sha256File(file);
	writeFileSync(
		file,
		JSON.stringify({
			project: { title: "Before", createdAt: "creation", updatedAt: "new-save" },
			schemaVersion: 11,
			_klipptTransactions: { receipts: [{ requestId: "apply" }, { requestId: "undo" }] },
		}),
	);
	const after = projectContentEvidence(file);
	expect(after.contentHash).toBe(baseline.contentHash);
	expect(sha256File(file)).not.toBe(beforeFileHash);
	const evidence = makeEvidence();
	Object.assign(evidence.baseline, baseline, { hash: beforeFileHash });
	Object.assign(evidence.after, after, {
		hash: sha256File(file),
		recoveredReceiptIds: ["apply", "undo"],
		history: [
			{ applyId: "a", requestId: "apply" },
			{ applyId: "u", requestId: "undo" },
		],
	});
	const manifest = makeManifest({ project_hash: "content_restored" });
	expect(gradeCase(manifest, evidence).status).toBe("pass");
	evidence.after.receiptRequestIds = [];
	expect(gradeCase(manifest, evidence).status).toBe("fail");
	evidence.after.receiptRequestIds = after.receiptRequestIds;
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 11,
			project: { title: "Before", createdAt: "different-creation", updatedAt: "new-save" },
		}),
	);
	evidence.after.contentHash = projectContentEvidence(file).contentHash;
	expect(gradeCase(manifest, evidence).status).toBe("fail");
	evidence.after.contentHash = null;
	expect(gradeCase(manifest, evidence).status).toBe("incomplete");
});

it("requires a real-shaped successful CLI receipt response for recovery evidence", () => {
	expect(
		extractRecoveredReceiptId({ status: "completed", data: { receipt: { requestId: "a" } } }),
	).toBeNull();
	expect(
		extractRecoveredReceiptId({ status: "failed", error: { code: "CORRUPT_METADATA" } }),
	).toBeNull();
	expect(
		extractRecoveredReceiptId({
			status: "completed",
			data: {
				receipt: {
					requestId: "a",
					payloadHash: "a".repeat(64),
					operationId: "operation",
					revision: "revision",
					changed: true,
				},
			},
		}),
	).toBe("a");
});
