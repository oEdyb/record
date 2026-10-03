// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editFixture } from "@/lib/ai-edition/checks/fixtures";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { DEFAULT_PAUSE_POLICY } from "@/lib/ai-edition/timeline/pause-analysis";
import type { ProposedCut } from "@/lib/ai-edition/timeline/proposed-cuts";
import { resetPauseAnalysisStoreForTests, usePauseAnalysisStore } from "./pauseAnalysisStore";
import { resetRejectedCutsForTests } from "./rejectedCuts";

const analyze = vi.hoisted(() => vi.fn());
vi.mock("./analyzeProjectPauses", () => ({ analyzeProjectPauses: analyze }));
const lane = () => usePauseAnalysisStore.getState();
function cut(id: string, start = 2, end = 4): ProposedCut {
	return {
		id,
		clipId: "clip",
		assetId: "asset",
		sourceStartSec: start,
		sourceEndSec: end,
		kind: "agent",
		origin: "agent plan test",
		selected: true,
	};
}
beforeEach(() => {
	resetPauseAnalysisStoreForTests();
	resetRejectedCutsForTests();
	localStorage.clear();
	useProjectStore.setState({ document: editFixture(), projectId: "project", revision: 1 });
});
describe("proposed cuts lane", () => {
	it("clamps both edges to source bounds, neighbours and 40ms", () => {
		lane().stageCuts([cut("left", 1, 2), cut("middle", 4, 6), cut("right", 8, 9)]);
		lane().moveCutEdge("middle", "start", -30);
		lane().moveCutEdge("middle", "end", 50);
		expect(lane().suggestions[1]).toMatchObject({ sourceStartSec: 2, sourceEndSec: 8 });
		lane().moveCutEdge("middle", "start", 50);
		expect(lane().suggestions[1].sourceStartSec).toBeCloseTo(7.96);
		lane().moveCutEdge("middle", "end", -50);
		expect(lane().suggestions[1].sourceEndSec).toBeCloseTo(8);
		lane().moveCutEdge("left", "start", -50);
		lane().moveCutEdge("right", "end", 50);
		expect(lane().suggestions[0].sourceStartSec).toBe(0);
		expect(lane().suggestions[2].sourceEndSec).toBe(20);
	});
	it("retains adjusted pills when staging the same plan again", () => {
		lane().stageCuts([cut("a")]);
		lane().moveCutEdge("a", "start", 1);
		expect(lane().stageCuts([cut("a")])).toEqual([]);
		expect(lane().suggestions).toHaveLength(1);
		expect(lane().suggestions[0].sourceStartSec).toBe(1);
	});
	it("persists rejection across store resets, suppresses >=50%, and isolates projects", () => {
		lane().stageCuts([cut("a")]);
		lane().rejectCut("a");
		resetPauseAnalysisStoreForTests();
		resetRejectedCutsForTests();
		lane().stageCuts([cut("half", 3, 5), cut("less", 3.01, 5.01)]);
		expect(lane().suggestions.map((item) => item.id)).toEqual(["less"]);
		expect(lane().rejectedEarlier).toBe(1);
		const other = editFixture();
		other.project.id = "other";
		useProjectStore.setState({ projectId: "other", document: other });
		lane().stageCuts([cut("half", 3, 5)]);
		expect(lane().suggestions).toHaveLength(1);
	});
	it("filters rejections from analyze while retaining agent proposals", async () => {
		lane().stageCuts([cut("a"), cut("agent", 12, 14)]);
		lane().rejectCut("a");
		analyze.mockResolvedValue({
			suggestions: [{ ...cut("pause"), kind: "pause", silenceStartSec: 2, silenceEndSec: 4 }],
			analyzedClipCount: 1,
		});
		await lane().analyze(editFixture(), 1, DEFAULT_PAUSE_POLICY);
		expect(lane().suggestions.map((item) => item.id)).toEqual(["agent"]);
		expect(lane().rejectedEarlier).toBe(1);
	});
	it("accepts selected only in one patch with history, then clears the lane", async () => {
		const document = editFixture();
		const apply = vi
			.spyOn(useProjectStore.getState(), "applyDocumentPatch")
			.mockImplementation(async (_id, patch, options) => {
				const next = patch(document);
				expect(next.timeline.trimRanges.map((trim) => trim.id)).toEqual(["yes"]);
				expect(options?.createHistorySnapshot?.(document)).toBe(document);
				expect(options?.agentHistory?.planSummary).toBe("Accept 1 proposed cuts");
				return "applied";
			});
		lane().stageCuts([cut("yes"), { ...cut("no", 6, 8), selected: false }]);
		expect(await lane().acceptAll()).toBe("applied");
		expect(apply).toHaveBeenCalledOnce();
		expect(lane().suggestions).toEqual([]);
		apply.mockRestore();
	});
	it("keeps unaccepted IDs and retains the lane after save failure", async () => {
		const apply = vi
			.spyOn(useProjectStore.getState(), "applyDocumentPatch")
			.mockResolvedValueOnce("conflict")
			.mockResolvedValueOnce("applied");
		lane().stageCuts([cut("a"), cut("b", 6, 8)]);
		expect(await lane().acceptAll(["a"])).toBe("conflict");
		expect(lane().suggestions).toHaveLength(2);
		expect(await lane().acceptAll(["a"])).toBe("applied");
		expect(lane().suggestions.map((item) => item.id)).toEqual(["b"]);
		apply.mockRestore();
	});
	it("clear and remove do not remember rejections; revisions preserve valid cuts", () => {
		lane().stageCuts([cut("a")]);
		lane().removeCut("a");
		lane().stageCuts([cut("a")]);
		lane().clearCuts();
		lane().stageCuts([cut("a")]);
		lane().syncDocument("project", 2);
		expect(lane().suggestions).toHaveLength(1);
		expect(lane().rejectedEarlier).toBe(0);
	});
});

it("keeps other pauses when accepting IDs advances the document revision", async () => {
	lane().stageCuts([
		{ ...cut("a"), kind: "pause" },
		{ ...cut("b", 6, 8), kind: "blip" },
	]);
	const apply = vi
		.spyOn(useProjectStore.getState(), "applyDocumentPatch")
		.mockImplementation(async () => {
			useProjectStore.setState({ revision: 2 });
			lane().syncDocument("project", 2);
			return "applied";
		});
	await lane().acceptAll(["a"]);
	lane().syncDocument("project", 2);
	expect(lane().suggestions.map((item) => item.id)).toEqual(["b"]);
	apply.mockRestore();
});

it("retains adjusted agent cuts when pause analysis fails", async () => {
	lane().stageCuts([cut("agent")]);
	lane().moveCutEdge("agent", "start", 1);
	analyze.mockRejectedValue(new Error("decoder failed"));
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	await lane().analyze(editFixture(), 1, DEFAULT_PAUSE_POLICY);
	expect(lane().suggestions[0]).toMatchObject({ id: "agent", sourceStartSec: 1 });
	expect(lane().status).toBe("error");
	error.mockRestore();
});
