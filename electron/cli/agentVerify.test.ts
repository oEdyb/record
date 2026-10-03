// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeChecks } from "../../src/lib/ai-edition/checks";
import { editFixture } from "../../src/lib/ai-edition/checks/fixtures";
import type { Finding } from "../../src/lib/ai-edition/checks/types";
import type { ContentFinding } from "./agentContentVerify";

const mock = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("./agentContentVerify", () => ({ verifyContentAtEdges: mock.verify }));

import {
	contentFindingToCheckFinding,
	contentVerifyEdges,
	deepContentFindings,
	mergeContentFindings,
	runContentVerification,
	verifyBrokerInput,
	verifyCommandInput,
} from "./agentVerify";

/** Single clip, 22.324 s trimmed out at 50 s: the cut sits at edited 50. */
const trimmedFixture = () => editFixture({ duration: 200, trims: [[50, 72.324]] });

const clippedFinding: ContentFinding = {
	rule: "cut.clipped-word",
	severity: "error",
	at: 50,
	label: "out:clip",
	message: "Out point 50.000s is mid-word.",
	evidence: { tailDbFs: -27, postDbFs: -28, deltaDb: -1, windowStartSec: 49.4 },
};

afterEach(() => {
	mock.verify.mockReset();
});

describe("contentVerifyEdges", () => {
	it("emits both sides of a trim cut in media-file clock", () => {
		const edges = contentVerifyEdges(trimmedFixture(), { startSec: 0, endSec: 200 });
		expect(edges).toHaveLength(2);
		expect(edges[0]).toMatchObject({
			edge: { timeSec: 50, label: "out:clip", kind: "cut" },
			assetId: "asset",
			mediaPath: "/take.mp4",
			editedAtSec: 50,
			ownerId: "clip",
		});
		expect(edges[1]).toMatchObject({
			edge: { timeSec: 72.324, label: "in:clip", kind: "cut" },
			editedAtSec: 50,
		});
	});

	it("filters edges by the edited-time range", () => {
		expect(contentVerifyEdges(trimmedFixture(), { startSec: 60, endSec: 100 })).toHaveLength(0);
		expect(contentVerifyEdges(trimmedFixture(), { startSec: 49.9, endSec: 50.1 })).toHaveLength(2);
	});

	it("skips a split boundary where no media was removed", () => {
		const document = editFixture({ duration: 200 });
		document.timeline.clips = [
			{ ...document.timeline.clips[0], sourceEndSec: 100, timelineEndSec: 100 },
			{
				...document.timeline.clips[0],
				id: "clip2",
				sourceStartSec: 100,
				sourceEndSec: 200,
				timelineStartSec: 100,
				timelineEndSec: 200,
			},
		];
		expect(contentVerifyEdges(document, { startSec: 0, endSec: 200 })).toEqual([]);
	});

	it("emits frame-sampling edges at overlay boundaries in the overlay media clock", () => {
		const document = editFixture({ duration: 100 });
		document.videoOverlays = [
			{
				id: "overlay",
				assetId: "asset",
				startMs: 2000,
				endMs: 22000,
				sourceStartSec: 2,
				sourceEndSec: 22,
				clipId: "clip",
				sourceOffsetSec: 1.5,
				fit: "cover",
				placement: null,
				opacity: 0.6,
				motion: "fade",
			},
		];
		const edges = contentVerifyEdges(document, { startSec: 0, endSec: 100 });
		expect(edges).toHaveLength(2);
		expect(edges[0]).toMatchObject({
			edge: { timeSec: 1.5, label: "overlay:overlay", kind: "overlay" },
			editedAtSec: 2,
			ownerId: "overlay",
		});
		expect(edges[1]).toMatchObject({
			edge: { timeSec: 21.5, label: "overlay:overlay", kind: "overlay" },
			editedAtSec: 22,
		});
		expect(contentVerifyEdges(document, { startSec: 0, endSec: 10 })).toHaveLength(1);
	});
});

describe("verify input schemas", () => {
	it("parses suffixed CLI range times through the phase-3 resolver syntax", () => {
		const input = verifyCommandInput.parse({
			project_id: "p",
			range: ["1:43", "125.3r"],
		});
		expect(input.range[0]).toEqual({ seconds: 103, base: "edited" });
		expect(input.range[1]).toEqual({ seconds: 125.3, base: "raw" });
	});

	it("keeps bare broker numbers edited and accepts the parsed object form", () => {
		const input = verifyBrokerInput.parse({
			projectId: "p",
			range: { startSec: 5, endSec: { seconds: 10, base: "raw" } },
		});
		expect(input.range.startSec).toBe(5);
		expect(input.range.endSec).toEqual({ seconds: 10, base: "raw" });
	});

	it.each([
		() => verifyCommandInput.parse({ project_id: "p", range: ["10", "10"] }),
		() => verifyBrokerInput.parse({ projectId: "p", range: { startSec: 10, endSec: 9 } }),
		() => verifyCommandInput.parse({ project_id: "p", range: ["-1", "4"] }),
	])("rejects malformed ranges", (parse) => {
		expect(parse).toThrow();
	});
});

describe("runContentVerification", () => {
	it("groups edges per media file and maps findings onto the edited clock", () => {
		mock.verify.mockReturnValue({
			status: "ok",
			findings: [
				clippedFinding,
				{
					...clippedFinding,
					rule: "frame.black",
					severity: "warning",
					at: 72.324,
					label: "in:clip",
					message: "Frame at 72.324s is black.",
				},
			],
			analyses: [
				{
					edge: { timeSec: 50, label: "out:clip", kind: "cut" },
					status: "ok",
					windowStartSec: 49.4,
					bucketsDbFs: [],
					tailDbFs: -27,
					postDbFs: -28,
					deltaDb: -1,
					clipped: true,
				},
			],
			frames: [{ status: "ok" }, { status: "no-video" }],
			filmstrip: "/tmp/filmstrip.png",
		});
		const summary = runContentVerification(trimmedFixture(), { startSec: 0, endSec: 200 });
		expect(mock.verify).toHaveBeenCalledTimes(1);
		expect(mock.verify.mock.calls[0][0]).toBe("/take.mp4");
		expect(
			(mock.verify.mock.calls[0][1] as { timeSec: number }[]).map((edge) => edge.timeSec),
		).toEqual([50, 72.324]);
		expect(summary.status).toBe("ok");
		expect(summary.edges_analyzed).toBe(2);
		expect(summary.counts).toEqual({ error: 1, warning: 1 });
		expect(summary.findings[0]).toMatchObject({
			rule: "cut.clipped-word",
			severity: "error",
			at: 50,
			clip: "clip",
		});
		expect(summary.findings[0].message).toContain("media 50.000s of asset asset");
		expect(summary.findings[1]).toMatchObject({ rule: "frame.black", severity: "warning" });
		expect(summary.analyses[0]).toMatchObject({
			label: "out:clip",
			edited_sec: 50,
			media_sec: 50,
			asset_id: "asset",
			clipped: true,
		});
		expect(summary.frames_sampled).toBe(1);
		expect(summary.filmstrip).toBe("/tmp/filmstrip.png");
	});

	it("caps one run at MAX_VERIFY_EDGES_PER_RUN and says so", () => {
		// 60 trims → 60 cuts → 120 edges, over the 100-edge cap.
		const trims: [number, number][] = [];
		for (let i = 0; i < 60; i++) trims.push([i * 3 + 1, i * 3 + 2]);
		const document = editFixture({ duration: 200, trims });
		mock.verify.mockReturnValue({
			status: "ok",
			findings: [],
			analyses: [],
			frames: [],
			filmstrip: null,
		});
		const summary = runContentVerification(document, { startSec: 0, endSec: 200 });
		expect(summary.edges_in_range).toBe(120);
		expect(summary.edges_analyzed).toBe(100);
		expect(summary.notes[0]).toContain("100");
	});

	it("reports no-edges without invoking the detector", () => {
		const summary = runContentVerification(trimmedFixture(), { startSec: 60, endSec: 100 });
		expect(summary.status).toBe("no-edges");
		expect(mock.verify).not.toHaveBeenCalled();
	});

	it("propagates ffmpeg-missing", () => {
		mock.verify.mockReturnValue({
			status: "ffmpeg-missing",
			findings: [],
			analyses: [],
			frames: [],
			filmstrip: null,
		});
		expect(runContentVerification(trimmedFixture(), { startSec: 0, endSec: 200 }).status).toBe(
			"ffmpeg-missing",
		);
	});

	it("flags a media file the detector rejects as content.unavailable and verifies the rest", () => {
		const document = editFixture({ duration: 200 });
		document.assets.push({
			id: "asset2",
			kind: "video",
			label: "Take two",
			originalPath: "/two.mp4",
			durationSec: 50,
			cameraTrack: null,
		});
		document.timeline.clips = [
			{ ...document.timeline.clips[0], sourceEndSec: 100, timelineEndSec: 100 },
			{
				...document.timeline.clips[0],
				id: "clip2",
				assetId: "asset2",
				sourceStartSec: 0,
				sourceEndSec: 50,
				timelineStartSec: 100,
				timelineEndSec: 150,
			},
		];
		mock.verify.mockImplementation((mediaPath: string) => {
			if (mediaPath === "/take.mp4")
				throw new Error("VERIFY_MEDIA_INVALID: Expected an existing file.");
			return {
				status: "ok",
				findings: [clippedFinding],
				analyses: [],
				frames: [],
				filmstrip: null,
			};
		});
		const summary = runContentVerification(document, { startSec: 0, endSec: 200 });
		// A rejected asset is unavailable verification, not verified absence.
		expect(summary.status).toBe("unavailable");
		expect(summary.edges_analyzed).toBe(2);
		expect(summary.notes[0]).toContain("Skipped /take.mp4");
		expect(summary.findings).toContainEqual(
			expect.objectContaining({
				rule: "content.unavailable",
				severity: "error",
				at: 100,
				clip: "clip",
			}),
		);
		expect(summary.counts.error).toBeGreaterThanOrEqual(1);
		// The in:clip2 edge lands in /two.mp4; the canned finding's label does not
		// match, so it maps without edge metadata and keeps its media clock.
		expect(summary.findings.find((f) => f.rule === "cut.clipped-word")?.at).toBe(50);
	});

	it("unavailable edge analyses become content.unavailable errors and flip the status", () => {
		mock.verify.mockReturnValue({
			status: "ok",
			findings: [],
			analyses: [
				{
					edge: { timeSec: 50, label: "out:clip", kind: "cut" },
					status: "unavailable",
					error: "decode failed: ffmpeg exited 1",
					windowStartSec: 49.4,
					bucketsDbFs: [],
					tailDbFs: null,
					postDbFs: null,
					deltaDb: null,
					clipped: false,
				},
				{
					edge: { timeSec: 72.324, label: "in:clip", kind: "cut" },
					status: "ok",
					windowStartSec: 71.724,
					bucketsDbFs: [],
					tailDbFs: -50,
					postDbFs: -60,
					deltaDb: -10,
					clipped: false,
				},
			],
			frames: [],
			filmstrip: null,
		});
		const summary = runContentVerification(trimmedFixture(), { startSec: 0, endSec: 200 });
		expect(summary.status).toBe("unavailable");
		expect(summary.counts).toEqual({ error: 1, warning: 0 });
		expect(summary.findings).toHaveLength(1);
		expect(summary.findings[0]).toMatchObject({
			rule: "content.unavailable",
			severity: "error",
			at: 50,
			clip: "clip",
		});
		expect(summary.findings[0].message).toContain("decode failed");
		expect(summary.analyses[0]).toMatchObject({
			status: "unavailable",
			error: expect.stringContaining("decode failed"),
		});
		expect(summary.analyses[1].status).toBe("ok");
		expect(summary.notes.at(-1)).toContain("not fully verified");
	});

	it("requests the microphone role from the detector by default", () => {
		mock.verify.mockReturnValue({
			status: "ok",
			findings: [],
			analyses: [],
			frames: [],
			filmstrip: null,
		});
		runContentVerification(trimmedFixture(), { startSec: 0, endSec: 200 });
		expect(mock.verify.mock.calls[0][2]).toMatchObject({ audio: { role: "microphone" } });
	});
});

describe("mergeContentFindings", () => {
	it("merges findings, counts, rules and notes into a check page", () => {
		const base = summarizeChecks([], []);
		const mapped = contentFindingToCheckFinding(clippedFinding, {
			edge: { timeSec: 50, label: "out:clip", kind: "cut" },
			assetId: "asset",
			mediaPath: "/take.mp4",
			editedAtSec: 50,
			ownerId: "clip",
		});
		const merged = mergeContentFindings(base, [mapped]);
		expect(merged.total).toBe(1);
		expect(merged.counts.error).toBe(1);
		expect(merged.counts.byRule["cut.clipped-word"]).toBe(1);
		expect(merged.rules.map((rule) => rule.id)).toContain("cut.clipped-word");
		expect(merged.notes[0]).toContain("ffmpeg decode");
		expect(mergeContentFindings(base, [])).toBe(base);
	});
});

describe("deepContentFindings", () => {
	const span = { startSec: 40, endSec: 60 };
	const baseSummary = {
		status: "ok" as const,
		range: span,
		time_base: { range: "edited", findings_at: "edited" },
		edges_in_range: 2,
		edges_analyzed: 2,
		findings: [] as Finding[],
		counts: { error: 0, warning: 0 },
		analyses: [],
		frames_sampled: 0,
		filmstrip: null,
		notes: [] as string[],
	};

	it("passes summary findings through unchanged", () => {
		const mapped = contentFindingToCheckFinding(clippedFinding, undefined);
		const findings = deepContentFindings({ ...baseSummary, findings: [mapped] }, span);
		expect(findings).toEqual([mapped]);
	});

	it("turns a failed pass into an error-level content.unavailable finding", () => {
		const findings = deepContentFindings({ status: "error", error: "disk on fire" }, span);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			rule: "content.unavailable",
			severity: "error",
			at: 40,
			clip: null,
		});
		expect(findings[0].message).toContain("disk on fire");
	});

	it("turns an ffmpeg-missing summary into an error-level finding", () => {
		const findings = deepContentFindings({ ...baseSummary, status: "ffmpeg-missing" }, span);
		expect(findings).toHaveLength(1);
		expect(findings[0].rule).toBe("content.unavailable");
		expect(findings[0].message).toContain("ffmpeg");
	});
});
