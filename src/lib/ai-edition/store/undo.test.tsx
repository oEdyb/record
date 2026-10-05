// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { useProjectStore } from "./projectStore";
import { clearHistory, redo, undo } from "./undo";

const bridgeMocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			save: bridgeMocks.save,
		},
	},
}));

function documentWithClipIds(ids: string[]): AxcutDocument {
	const base = createEmptyDocument({ title: "Undo test", projectId: "undo-project" });
	return {
		...base,
		project: { ...base.project, primaryAssetId: "asset-1" },
		assets: [
			{
				id: "asset-1",
				kind: "video",
				label: "Recording",
				originalPath: "/tmp/recording.mp4",
				durationSec: Math.max(1, ids.length),
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: ids.map((id, index) => ({
				id,
				assetId: "asset-1",
				sourceStartSec: index,
				sourceEndSec: index + 1,
				timelineStartSec: index,
				timelineEndSec: index + 1,
				wordRefs: [],
				origin: "user" as const,
				reason: "",
			})),
		},
	};
}

describe("project document undo and redo", () => {
	beforeEach(() => {
		clearHistory();
		useProjectStore.getState().clear();
		bridgeMocks.save.mockReset();
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
	});

	it("treats one persisted clip insertion as one atomic undo step", async () => {
		const before = documentWithClipIds(["old-1", "old-2"]);
		const after = documentWithClipIds(["old-1", "inserted", "old-2"]);
		useProjectStore.setState({ projectId: before.project.id, document: before });

		await useProjectStore.getState().saveDocumentAsEdit(after);
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"old-1",
			"inserted",
			"old-2",
		]);

		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"old-1",
			"old-2",
		]);
		expect(undo()).toBe(false);

		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"old-1",
			"inserted",
			"old-2",
		]);
	});

	it("does not add a failed save to history", async () => {
		const before = documentWithClipIds(["old-1"]);
		const after = documentWithClipIds(["old-1", "inserted"]);
		useProjectStore.setState({ projectId: before.project.id, document: before });
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });

		await expect(useProjectStore.getState().saveDocumentAsEdit(after)).rejects.toThrow("disk full");
		expect(useProjectStore.getState().document).toBe(before);
		expect(undo()).toBe(false);
	});
});
