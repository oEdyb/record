// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedProjectState } from "@/lib/ai-edition/store/projectStore.testUtils";
import { createEmptyDocument } from "../schema";
import { loadEditingPreferences } from "./editingPreferences";
import { getEditorSettings } from "./editorSettings";
import { useProjectStore } from "./projectStore";
import { clearHistory, undo } from "./undo";
import { useEditorSettings } from "./useEditorSettings";

const bridgeMocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			save: bridgeMocks.save,
		},
	},
}));

describe("useEditorSettings preferences", () => {
	beforeEach(() => {
		localStorage.clear();
		clearHistory();
		bridgeMocks.save.mockReset();
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		const document = createEmptyDocument({ projectId: "project", title: "Project" });
		seedProjectState({
			projectId: document.project.id,
			document,
			revision: 0,
			status: "ready",
			error: null,
			dirty: false,
		});
	});

	it("remembers a committed control for the next project", async () => {
		const view = renderHook(() => useEditorSettings());

		await act(async () => {
			await view.result.current.set({ padding: 26, showBlur: true });
		});

		expect(loadEditingPreferences().editor).toMatchObject({ padding: 26, showBlur: true });
		expect(getEditorSettings(useProjectStore.getState().document).padding).toBe(26);
	});

	it("writes slider defaults only when the live edit is committed", async () => {
		const view = renderHook(() => useEditorSettings());

		act(() => view.result.current.setLive({ shadowIntensity: 0.72 }));
		expect(loadEditingPreferences().editor.shadowIntensity).not.toBe(0.72);

		await act(async () => {
			await view.result.current.commit();
		});

		expect(loadEditingPreferences().editor.shadowIntensity).toBe(0.72);
	});

	it("records one Undo step for a complete live gesture", async () => {
		const view = renderHook(() => useEditorSettings());

		act(() => view.result.current.setLive({ padding: 12 }));
		act(() => view.result.current.setLive({ padding: 26 }));
		await act(async () => {
			await view.result.current.commit();
		});

		expect(getEditorSettings(useProjectStore.getState().document).padding).toBe(26);
		act(() => expect(undo()).toBe(true));
		expect(getEditorSettings(useProjectStore.getState().document).padding).toBe(50);
		expect(undo()).toBe(false);
	});

	it("does not remember a setting when the project save fails", async () => {
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		const view = renderHook(() => useEditorSettings());

		await expect(
			act(async () => {
				await view.result.current.set({ padding: 12 });
			}),
		).rejects.toThrow("disk full");

		expect(loadEditingPreferences().editor.padding).not.toBe(12);
	});

	it("does not remember a late save after the user switches projects", async () => {
		let finishSave: (() => void) | undefined;
		bridgeMocks.save.mockImplementationOnce(
			(document) =>
				new Promise((resolve) => {
					finishSave = () => resolve({ success: true, document });
				}),
		);
		const view = renderHook(() => useEditorSettings());
		let update: Promise<void> | undefined;
		act(() => {
			update = view.result.current.set({ padding: 12 });
		});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const otherDocument = createEmptyDocument({ projectId: "other", title: "Other" });
		act(() => {
			seedProjectState({ projectId: "other", document: otherDocument });
		});

		finishSave?.();
		await act(async () => {
			await update;
		});

		expect(loadEditingPreferences().editor.padding).not.toBe(12);
	});

	it("keeps a newer live slider value when an older commit finishes", async () => {
		let finishSave: (() => void) | undefined;
		bridgeMocks.save.mockImplementationOnce(
			(document) =>
				new Promise((resolve) => {
					finishSave = () => resolve({ success: true, document });
				}),
		);
		const view = renderHook(() => useEditorSettings());
		act(() => view.result.current.setLive({ padding: 12 }));
		let commit: Promise<void> | undefined;
		act(() => {
			commit = view.result.current.commit();
		});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		act(() => view.result.current.setLive({ padding: 25 }));
		finishSave?.();
		await act(async () => {
			await commit;
		});

		expect(getEditorSettings(useProjectStore.getState().document).padding).toBe(25);
		expect(useProjectStore.getState().dirty).toBe(true);
		expect(loadEditingPreferences().editor.padding).not.toBe(12);
	});
});
