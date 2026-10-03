import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CheckRun } from "../../src/lib/ai-edition/agent/agentCheckAnalysis";
import { runChecks, summarizeChecks } from "../../src/lib/ai-edition/checks";
import { buildResolvedEdit } from "../../src/lib/ai-edition/checks/context";
import { editFixture } from "../../src/lib/ai-edition/checks/fixtures";
import { finding } from "../../src/lib/ai-edition/checks/types";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { agentEditBatchSchema, prepareAgentEditPlan } from "./agentEditPlan";
import {
	assertIntroducedChecks,
	assertPlanChecks,
	boundAgentReply,
	buildVerify,
	introducedFindings,
	planChecks,
	rangeForDocument,
	touchedSpan,
} from "./agentVerification";

describe("agent verification", () => {
	it("deduplicates actions before capping at six, with errors first", () => {
		const doc = editFixture();
		const make = (id: string, severity: "error" | "warning" | "info", at: number) =>
			finding({ id, severity }, { startSec: at, endSec: at }, "clip", id);
		const findings = [
			...Array.from({ length: 15 }, () => make("same-info", "info", 1)),
			...Array.from({ length: 8 }, (_, i) => make(`warning-${i}`, "warning", i + 2)),
			make("urgent", "error", 15),
		];
		const ready = (items: typeof findings): CheckRun => ({
			status: "ready",
			revision: "r",
			result: summarizeChecks([{ findings: items }], []),
			audio: { ready: 0, pending: 0 },
			timings: { elapsedMs: 0, peaksMs: 0, speechMs: 0 },
			error: null,
		});
		const verify = buildVerify(doc, doc, { startSec: 0, endSec: 20 }, ready([]), ready(findings));
		expect(verify.next_actions).toHaveLength(6);
		expect(new Set(verify.next_actions).size).toBe(6);
		expect(verify.next_actions[0]).toContain("urgent");
		expect(verify.next_actions[1]).toContain("warning-0");
		const duplicates = buildVerify(
			doc,
			doc,
			{ startSec: 0, endSec: 20 },
			ready([]),
			ready([findings[0], findings[0]]),
		);
		expect(duplicates.next_actions.filter((a) => a.includes("same-info"))).toHaveLength(1);
	});
	it("never truncates the meaning of a supplied fix when bounding a reply", () => {
		const fix = [{ type: "setAnnotation", args: { text: "a".repeat(1000) } }];
		const result = boundAgentReply({
			noise: Array.from({ length: 200 }, () => "b".repeat(1000)),
			fix,
		});
		expect(result).toMatchObject({ fix });
		const oversized = [{ type: "setAnnotation", args: { text: "a".repeat(60_000) } }];
		expect(boundAgentReply({ fix: oversized })).toMatchObject({ fix: null, truncated: true });
	});
	it("verifies a trim over both cut edges plus three seconds", () => {
		const before = editFixture({ duration: 100, trims: [[40, 42]] });
		const { candidate } = prepareAgentEditPlan(before, [
			{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 41, endSec: 44 } },
		]);
		const span = touchedSpan(before, candidate);
		expect(span).toEqual({ startSec: 37, endSec: 44 });
		const verify = buildVerify(before, candidate, span);
		expect(verify.state.durationSec).toBe(97);
		expect(verify.state.spans[0].span.startSec).toBe(37);
		expect(verify.next_actions.join(" ")).toContain("check --range");
	});
	it("verifies text placement and reports new and resolved findings with complete checks", () => {
		const before = editFixture();
		const { candidate } = prepareAgentEditPlan(before, [
			{
				type: "addAnnotation",
				args: {
					startSec: 2,
					endSec: 5,
					text: "Label",
					anchor: { kind: "edited", fromSec: 2, toSec: 5 },
					position: { x: 0, y: 0 },
					size: { width: 100, height: 100 },
				},
			},
		]);
		const span = touchedSpan(before, candidate);
		expect(span).toEqual({ startSec: 2, endSec: 5 });
		const ready = (document: typeof before): CheckRun => ({
			status: "ready",
			revision: "r",
			result: planChecks(document, span),
			audio: { ready: 1, pending: 0 },
			timings: { elapsedMs: 0, peaksMs: 0, speechMs: 0 },
			error: null,
		});
		const verify = buildVerify(before, candidate, span, ready(before), ready(candidate));
		expect(verify.checks.new.some((f) => f.rule === "text.over-camera")).toBe(true);
		expect(
			buildVerify(candidate, before, span, ready(candidate), ready(before)).checks.resolved.some(
				(f) => f.rule === "text.over-camera",
			),
		).toBe(true);
		expect(verify.state.spans[0].regions.some((r) => r.kind === "annotation")).toBe(true);
	});
	it("blocks error findings, permits force, and never blocks warnings", () => {
		const document = editFixture({
			cameras: [
				{ id: "a", start: 1, end: 8, mode: "fullscreen" },
				{ id: "b", start: 2, end: 4, mode: "emphasis" },
			],
		});
		const checks = planChecks(document, { startSec: 0, endSec: 10 });
		expect(checks.counts.error).toBeGreaterThan(0);
		expect(() => assertPlanChecks(checks, false)).toThrow("CHECK_ERRORS");
		expect(() => assertPlanChecks(checks, true)).not.toThrow();
		expect(() =>
			assertPlanChecks({ ...checks, counts: { ...checks.counts, error: 0, warning: 2 } }, false),
		).not.toThrow();
	});
	it("blocks only findings a plan introduces, never pre-existing ones", () => {
		const before = editFixture({
			cameras: [
				{ id: "a", start: 1, end: 8, mode: "fullscreen" },
				{ id: "b", start: 2, end: 4, mode: "emphasis" },
			],
		});
		const span = { startSec: 0, endSec: 10 };
		const baseline = planChecks(before, span);
		expect(baseline.counts.error).toBeGreaterThan(0);
		expect(introducedFindings(baseline, baseline)).toEqual([]);
		expect(() => assertIntroducedChecks(baseline, baseline, false)).not.toThrow();
		const worse = editFixture({
			cameras: [
				{ id: "a", start: 1, end: 8, mode: "fullscreen" },
				{ id: "b", start: 2, end: 4, mode: "emphasis" },
				{ id: "c", start: 5, end: 7, mode: "emphasis" },
			],
		});
		const after = planChecks(worse, span);
		const introduced = introducedFindings(baseline, after);
		expect(introduced.length).toBeGreaterThan(0);
		expect(introduced.every((f) => f.message.includes("c"))).toBe(true);
		expect(() => assertIntroducedChecks(baseline, after, false)).toThrow("CHECK_ERRORS");
		expect(() => assertIntroducedChecks(baseline, after, true)).not.toThrow();
	});
	it("does not count findings that only moved in edited time as introduced", () => {
		const before = editFixture({
			cameras: [
				{ id: "a", start: 10, end: 16, mode: "fullscreen" },
				{ id: "b", start: 12, end: 14, mode: "emphasis" },
			],
		});
		const { candidate } = prepareAgentEditPlan(before, [
			{ type: "addTrim", args: { clipId: "clip", startSec: 1, endSec: 3 } },
		]);
		const span = { startSec: 0, endSec: 20 };
		const baseline = planChecks(before, span);
		expect(baseline.counts.error).toBeGreaterThan(0);
		const after = planChecks(candidate, span);
		expect(after.counts.error).toBe(baseline.counts.error);
		expect(introducedFindings(baseline, after).filter((f) => f.rule === "camera.nested")).toEqual(
			[],
		);
	});
	it("includes every operation span in a batch and clip layout spans", () => {
		const before = editFixture();
		const { candidate } = prepareAgentEditPlan(before, [
			{ type: "addZoom", args: { startSec: 1, endSec: 2 } },
			{ type: "addZoom", args: { startSec: 15, endSec: 18 } },
		]);
		expect(touchedSpan(before, candidate)).toEqual({ startSec: 1, endSec: 18 });
		const layout = prepareAgentEditPlan(before, [
			{ type: "setClipLayout", clipId: "clip", layout: { cameraSize: "L" } },
		]);
		expect(touchedSpan(before, layout.candidate)).toEqual({ startSec: 0, endSec: 20 });
	});
	it("prepares the clone-only removeClip/setClipRange batch whose span outlives the shortened candidate", () => {
		// Fixture: the exact operations from
		// artifacts/swarm-launch-footage-2026-09-18/review-ops.json — 35 removeClip
		// plus 2 setClipRange over 37 distinct clips. The reviewed build failed
		// this batch with "Range must be inside the edited timeline." because the
		// union touched span was passed to runChecks unclamped: it is computed
		// over BOTH documents, so it legitimately extends past the candidate the
		// removals shortened.
		const operations = agentEditBatchSchema.parse(
			JSON.parse(
				readFileSync(
					new URL("./__fixtures__/review-ops-remove-clips.json", import.meta.url),
					"utf8",
				),
			),
		);
		const clipIds = [
			...new Set(
				operations.map((op) => ("args" in op && "clipId" in op.args ? op.args.clipId : "")),
			),
		].filter((id) => id.length > 0);
		expect(clipIds).toHaveLength(37);
		const before = createEmptyDocument({
			projectId: "project",
			title: "Review clone",
			createdAt: "2026-09-18T00:00:00Z",
		});
		before.assets = clipIds.map((id) => ({
			id: `asset_${id}`,
			kind: "video" as const,
			label: id,
			originalPath: `/${id}.mp4`,
			durationSec: 30,
			cameraTrack: { sourcePath: `/${id}-camera.mp4`, startMs: 0, offsetMs: 0, visible: true },
		}));
		before.timeline.clips = clipIds.map((id, index) => ({
			id,
			assetId: `asset_${id}`,
			sourceStartSec: 0,
			sourceEndSec: 30,
			timelineStartSec: index * 30,
			timelineEndSec: (index + 1) * 30,
			origin: "user" as const,
			reason: "",
			wordRefs: [],
		}));
		const { candidate } = prepareAgentEditPlan(before, operations);
		expect(candidate.timeline.clips.map((clip) => clip.id)).toEqual([
			"clip_recording_1789653794581_3",
			"clip_recording_1789653794581_12",
		]);
		const candidateDuration = buildResolvedEdit(candidate).durationSec;
		expect(candidateDuration).toBeLessThan(30);
		const span = touchedSpan(before, candidate);
		// The poisoned-range condition from the review: the union span covers the
		// removed footage, far beyond the candidate's shortened timeline.
		expect(span.endSec).toBeGreaterThan(candidateDuration);
		// The exact call the failing build made: the raw span as the check range.
		expect(() => runChecks(buildResolvedEdit(candidate), { range: span })).toThrow(
			"Range must be inside the edited timeline.",
		);
		// The prepared flow clamps the span per document, so preparation of this
		// legitimate batch now succeeds on both sides of the diff.
		expect(rangeForDocument(candidate, span)).toEqual({
			startSec: 0,
			endSec: candidateDuration,
		});
		const baseline = planChecks(before, span);
		const checks = planChecks(candidate, span);
		expect(() => assertIntroducedChecks(baseline, checks, false)).not.toThrow();
		const verify = buildVerify(before, candidate, span);
		expect(verify.range.endSec).toBeLessThanOrEqual(candidateDuration);
		expect(verify.state.durationSec).toBe(candidateDuration);
	});
	it("clamps float-noise negative span starts from anchored regions at time zero", () => {
		// The geometry that actually failed in the review clone (its first clip):
		// a trim at source 0 plus an overlay anchored near source 0.8 makes the
		// trim-compressed playback projection emit startSec -5.6e-8 for the
		// overlay's edited piece. runChecks rejects startSec < 0, so plan
		// preparation died with "Range must be inside the edited timeline." even
		// though the span legitimately starts at zero.
		const before = createEmptyDocument({
			projectId: "project",
			title: "Float noise",
			createdAt: "2026-09-18T00:00:00Z",
		});
		before.assets = [
			{
				id: "screen",
				kind: "video" as const,
				label: "Screen",
				originalPath: "/screen.mp4",
				durationSec: 7.067,
				cameraTrack: { sourcePath: "/camera.mp4", startMs: 0, offsetMs: 0, visible: true },
			},
			{
				id: "overlay-asset",
				kind: "video" as const,
				label: "Overlay",
				originalPath: "/overlay.mp4",
				durationSec: 30,
				cameraTrack: null,
			},
		];
		before.timeline.clips = [
			{
				id: "clip",
				assetId: "screen",
				sourceStartSec: 0,
				sourceEndSec: 7.067,
				timelineStartSec: 0,
				timelineEndSec: 7.067000000000007,
				origin: "user" as const,
				reason: "",
				wordRefs: [],
			},
		];
		before.timeline.trimRanges = [
			{
				id: "trim_edge",
				clipId: "clip",
				assetId: "screen",
				startSec: 0,
				endSec: 1.1140000562369823,
				origin: "agent" as const,
				reason: "edge-silence",
			},
		];
		before.videoOverlays = [
			{
				id: "vo_1",
				startMs: 800,
				endMs: 7067,
				clipId: "clip",
				sourceStartSec: 0.8,
				sourceEndSec: 7.067,
				assetId: "overlay-asset",
				sourceOffsetSec: 0,
				fit: "cover" as const,
				placement: null,
				opacity: 1,
			},
		];
		const { candidate } = prepareAgentEditPlan(before, [
			{ type: "setVideoOverlay", args: { videoOverlayId: "vo_1", opacity: 0.5 } },
		]);
		const span = touchedSpan(before, candidate);
		// Documents the origin: the union span start is projection float noise.
		expect(span.startSec).toBeLessThan(0);
		expect(span.startSec).toBeGreaterThan(-0.001);
		// The raw span is not a legal check range; the per-document clamp is.
		expect(() => runChecks(buildResolvedEdit(candidate), { range: span })).toThrow(
			"Range must be inside the edited timeline.",
		);
		expect(rangeForDocument(candidate, span)?.startSec).toBe(0);
		expect(() => planChecks(before, span)).not.toThrow();
		expect(() => planChecks(candidate, span)).not.toThrow();
		expect(() => buildVerify(before, candidate, span)).not.toThrow();
	});
	it("bounds the complete UTF-8 envelope below 48 KiB while retaining the receipt and counts", () => {
		const reply = {
			status: "completed",
			data: {
				receipt: { requestId: "keep-me" },
				verify: {
					state: { spans: Array.from({ length: 1000 }, () => ({ text: "å".repeat(5000) })) },
					checks: { before: { error: 400 }, after: { error: 0 }, new: [], resolved: [] },
				},
			},
		};
		const bounded = boundAgentReply(reply);
		expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(48 * 1024);
		expect(bounded).toMatchObject({
			truncated: true,
			data: { receipt: { requestId: "keep-me" }, verify: { checks: { before: { error: 400 } } } },
		});
	});
});
