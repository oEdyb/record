// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import type { CleanCutBridge, CleanCutSnapshot } from "@/lib/cleanCut/types";
import { useCleanCutSession } from "./useCleanCutSession";

const listeners: ((snapshot: CleanCutSnapshot) => void)[] = [];
const bridge: CleanCutBridge = {
	start: vi.fn(async () => undefined),
	cancel: vi.fn(async () => undefined),
	onSnapshot: (callback) => {
		listeners.push(callback);
		return () => undefined;
	},
};
vi.mock("@/lib/cleanCut/bridge", () => ({ getCleanCutBridge: () => bridge }));

const clip = {
	id: "c",
	assetId: "a",
	sourceStartSec: 0,
	sourceEndSec: 10,
	timelineStartSec: 0,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "system" as const,
	reason: "",
};

beforeEach(() => {
	const document = createEmptyDocument({ title: "Take", projectId: "p1" });
	document.timeline.clips = [clip];
	useProjectStore.setState({ document });
	useCleanCutStore.getState().setEnabled(false, null);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	listeners.length = 0;
});

describe("clean cut session", () => {
	it("does nothing until the toggle is on, then starts with a copy of the document", async () => {
		renderHook(() => useCleanCutSession("p1", [clip]));
		expect(bridge.start).not.toHaveBeenCalled();
		act(() => useCleanCutStore.getState().setEnabled(true, "p1"));
		await waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
		const [projectId, strength, sent] = vi.mocked(bridge.start).mock.calls[0];
		expect([projectId, strength]).toEqual(["p1", "clean"]);
		expect(sent).toEqual(useProjectStore.getState().document);
		expect(sent).not.toBe(useProjectStore.getState().document);
		expect(useCleanCutStore.getState().snapshot.state).toBe("working");
	});

	it("shows a failed start instead of waiting forever", async () => {
		vi.mocked(bridge.start).mockRejectedValueOnce(new Error("No handler"));
		renderHook(() => useCleanCutSession("p1", [clip]));
		act(() => useCleanCutStore.getState().setEnabled(true, "p1"));
		await waitFor(() => expect(useCleanCutStore.getState().snapshot.state).toBe("failed"));
		expect(useCleanCutStore.getState().snapshot.error).toContain("No handler");
	});

	it("cancels when turned off", async () => {
		renderHook(() => useCleanCutSession("p1", [clip]));
		act(() => useCleanCutStore.getState().setEnabled(true, "p1"));
		await waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
		act(() => useCleanCutStore.getState().setEnabled(false, "p1"));
		expect(bridge.cancel).toHaveBeenCalledOnce();
	});
});
