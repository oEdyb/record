// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRecordingReviewMenu } from "./useRecordingReviewMenu";

afterEach(cleanup);
describe("native recorder menu routing", () => {
	it("routes native New/Save to capture/video delivery and retires old subscriptions", () => {
		const callbacks: Record<string, () => void> = {},
			unsubscribe = vi.fn();
		const subscribe = (name: string) => (callback: () => void) => {
			callbacks[name] = callback;
			return unsubscribe;
		};
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: {
				onMenuNewProject: subscribe("new"),
				onMenuLoadProject: subscribe("open"),
				onMenuSaveProject: subscribe("save"),
				onMenuSaveProjectAs: subscribe("saveAs"),
			},
		});
		const actions = { enabled: true, onRecord: vi.fn(), onRecordings: vi.fn(), onSave: vi.fn() };
		const view = renderHook(() => useRecordingReviewMenu(actions));
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		document.body.append(dialog);
		callbacks.new?.();
		callbacks.open?.();
		callbacks.save?.();
		expect(actions.onRecord).not.toHaveBeenCalled();
		expect(actions.onRecordings).not.toHaveBeenCalled();
		expect(actions.onSave).not.toHaveBeenCalled();
		dialog.remove();
		const input = document.createElement("input");
		document.body.append(input);
		input.focus();
		callbacks.new?.();
		expect(actions.onRecord).not.toHaveBeenCalled();
		input.remove();
		callbacks.new?.();
		callbacks.open?.();
		callbacks.save?.();
		callbacks.saveAs?.();
		expect(actions.onRecord).toHaveBeenCalledOnce();
		expect(actions.onRecordings).toHaveBeenCalledOnce();
		expect(actions.onSave).toHaveBeenCalledTimes(2);
		view.unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(4);
	});
});
