// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRecordingReviewShortcuts } from "./useRecordingReviewShortcuts";

afterEach(cleanup);
function actions() {
	return {
		enabled: true,
		isMac: true,
		playPause: { key: " " },
		onSave: vi.fn(),
		onRecord: vi.fn(),
		onRecordings: vi.fn(),
		onPlayPause: vi.fn(),
		onStep: vi.fn(),
	};
}
function key(key: string, metaKey = false, target: EventTarget = window) {
	target.dispatchEvent(
		new KeyboardEvent("keydown", { key, metaKey, bubbles: true, cancelable: true }),
	);
}
describe("recording review shortcuts", () => {
	it("preserves keyboard activation of interruption details", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		const summary = document.createElement("summary");
		document.body.append(summary);
		summary.focus();
		const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
		summary.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(calls.onPlayPause).not.toHaveBeenCalled();
		summary.remove();
	});
	it.each([true, false])("requires exact platform modifiers (Mac=%s)", (isMac) => {
		const calls = { ...actions(), isMac };
		renderHook(() => useRecordingReviewShortcuts(calls));
		const modifier = isMac ? { metaKey: true } : { ctrlKey: true };
		for (const extra of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true, metaKey: true }]) {
			for (const key of ["s", "n", "o"])
				window.dispatchEvent(new KeyboardEvent("keydown", { key, ...modifier, ...extra }));
		}
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "n",
				...(isMac ? { ctrlKey: true } : { metaKey: true }),
			}),
		);
		expect(calls.onRecord).not.toHaveBeenCalled();
		expect(calls.onSave).not.toHaveBeenCalled();
		expect(calls.onRecordings).not.toHaveBeenCalled();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ...modifier }));
		expect(calls.onRecord).toHaveBeenCalledOnce();
	});
	it("ignores repeated commands and composition but allows held frame stepping", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		for (const key of ["s", "n", "o", " "]) {
			window.dispatchEvent(
				new KeyboardEvent("keydown", { key, metaKey: key !== " ", repeat: true }),
			);
		}
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "n", metaKey: true, isComposing: true }),
		);
		expect(calls.onRecord).not.toHaveBeenCalled();
		expect(calls.onSave).not.toHaveBeenCalled();
		expect(calls.onRecordings).not.toHaveBeenCalled();
		expect(calls.onPlayPause).not.toHaveBeenCalled();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", repeat: true }));
		expect(calls.onStep).toHaveBeenCalledWith(1);
	});
	it("leaves dialogs and toggle controls to their own keyboard behavior", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		const button = document.createElement("button");
		dialog.append(button);
		document.body.append(dialog);
		key("n", true, button);
		key(" ", false, dialog);
		expect(calls.onRecord).not.toHaveBeenCalled();
		expect(calls.onPlayPause).not.toHaveBeenCalled();
		dialog.remove();
		const toggle = document.createElement("div");
		toggle.setAttribute("role", "switch");
		document.body.append(toggle);
		key(" ", false, toggle);
		expect(calls.onPlayPause).not.toHaveBeenCalled();
		toggle.remove();
	});
	it("maps Save, New, Open, playback and seeking to recorder actions", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		key("s", true);
		key("n", true);
		key("o", true);
		key(" ");
		key("ArrowRight");
		expect(calls.onSave).toHaveBeenCalledOnce();
		expect(calls.onRecord).toHaveBeenCalledOnce();
		expect(calls.onRecordings).toHaveBeenCalledOnce();
		expect(calls.onPlayPause).toHaveBeenCalledOnce();
		expect(calls.onStep).toHaveBeenCalledWith(1);
	});
	it("leaves text inputs and focused buttons to their normal keyboard behavior", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		const input = document.createElement("input"),
			button = document.createElement("button");
		document.body.append(input, button);
		key("s", true, input);
		key(" ", false, button);
		key("ArrowRight", false, button);
		expect(calls.onSave).not.toHaveBeenCalled();
		expect(calls.onPlayPause).not.toHaveBeenCalled();
		expect(calls.onStep).not.toHaveBeenCalled();
		input.remove();
		button.remove();
	});
	it("ignores hidden edit bindings and removes handlers when disabled", () => {
		const calls = actions();
		const view = renderHook(({ enabled }) => useRecordingReviewShortcuts({ ...calls, enabled }), {
			initialProps: { enabled: true },
		});
		for (const name of ["z", "y", "x", "v", "Backspace", "Delete"]) key(name, true);
		for (const callback of [
			calls.onSave,
			calls.onRecord,
			calls.onRecordings,
			calls.onPlayPause,
			calls.onStep,
		])
			expect(callback).not.toHaveBeenCalled();
		view.rerender({ enabled: false });
		key("s", true);
		expect(calls.onSave).not.toHaveBeenCalled();
	});
});
