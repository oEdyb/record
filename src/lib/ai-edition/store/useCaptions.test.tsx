// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../schema";
import { loadEditingPreferences } from "./editingPreferences";
import { useProjectStore } from "./projectStore";
import { useCaptions } from "./useCaptions";

const bridgeMocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			save: bridgeMocks.save,
		},
	},
}));

describe("useCaptions preferences", () => {
	beforeEach(() => {
		localStorage.clear();
		bridgeMocks.save.mockReset();
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		const document = createEmptyDocument({ projectId: "project", title: "Project" });
		useProjectStore.setState({
			projectId: document.project.id,
			document,
			revision: 0,
			status: "ready",
			error: null,
			dirty: false,
		});
	});

	it("remembers committed caption presentation without the selected translation", async () => {
		const view = renderHook(() => useCaptions());

		await act(async () => {
			await view.result.current.set({
				enabled: true,
				language: "sv",
				fontFamily: "Sora",
				fontSize: 58,
				verticalPosition: "top",
			});
		});

		const captions = loadEditingPreferences().captions;
		expect(captions).toMatchObject({
			enabled: true,
			fontFamily: "Sora",
			fontSize: 58,
			verticalPosition: "top",
		});
		expect(captions).not.toHaveProperty("language");
	});

	it("waits for slider commit before changing the caption default", async () => {
		const view = renderHook(() => useCaptions());

		act(() => view.result.current.setLive({ backgroundOpacity: 0.2 }));
		expect(loadEditingPreferences().captions.backgroundOpacity).not.toBe(0.2);

		await act(async () => {
			await view.result.current.commit();
		});

		expect(loadEditingPreferences().captions.backgroundOpacity).toBe(0.2);
	});

	it("keeps newer live caption styling when an older commit finishes", async () => {
		let finishSave: (() => void) | undefined;
		bridgeMocks.save.mockImplementationOnce(
			(document) =>
				new Promise((resolve) => {
					finishSave = () => resolve({ success: true, document });
				}),
		);
		const view = renderHook(() => useCaptions());
		act(() => view.result.current.setLive({ backgroundOpacity: 0.2 }));
		let commit: Promise<void> | undefined;
		act(() => {
			commit = view.result.current.commit();
		});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		act(() => view.result.current.setLive({ backgroundOpacity: 0.8 }));
		finishSave?.();
		await act(async () => {
			await commit;
		});

		expect(view.result.current.settings.backgroundOpacity).toBe(0.8);
		expect(useProjectStore.getState().dirty).toBe(true);
		expect(loadEditingPreferences().captions.backgroundOpacity).not.toBe(0.2);
	});
});
