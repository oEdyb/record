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
		onClip: vi.fn(),
		onEdge: vi.fn(),
		onMute: vi.fn(),
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
		expect(calls.onStep).toHaveBeenCalledWith(1, "frame");
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
		expect(calls.onStep).toHaveBeenCalledWith(1, "frame");
	});
	it("leaves text inputs to their normal keyboard behavior", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		const input = document.createElement("input");
		document.body.append(input);
		key("s", true, input);
		key(" ", false, input);
		key("ArrowRight", false, input);
		expect(calls.onSave).not.toHaveBeenCalled();
		expect(calls.onPlayPause).not.toHaveBeenCalled();
		expect(calls.onStep).not.toHaveBeenCalled();
		input.remove();
	});
	it("plays and steps from a focused button or the playhead without clicking it", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		const button = document.createElement("button");
		const seek = document.createElement("input");
		seek.type = "range";
		seek.setAttribute("data-review-seek", "");
		document.body.append(button, seek);
		const down = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
		button.dispatchEvent(down);
		const up = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
		button.dispatchEvent(up);
		expect(down.defaultPrevented).toBe(true);
		expect(up.defaultPrevented).toBe(true);
		key(" ", false, seek);
		key("ArrowLeft", false, seek);
		expect(calls.onPlayPause).toHaveBeenCalledTimes(2);
		expect(calls.onStep).toHaveBeenCalledWith(-1, "frame");
		button.remove();
		seek.remove();
	});
	it("leaves another slider its arrow keys but still plays on Space", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		const volume = document.createElement("input");
		volume.type = "range";
		document.body.append(volume);
		key("ArrowRight", false, volume);
		key(" ", false, volume);
		expect(calls.onStep).not.toHaveBeenCalled();
		expect(calls.onPlayPause).toHaveBeenCalledOnce();
		volume.remove();
	});
	it("maps K, J, L, Shift-arrows, clip keys, Home, End and M", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		for (const name of ["k", "j", "l", "ArrowUp", "ArrowDown", "Home", "End", "m"]) key(name);
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, cancelable: true }),
		);
		expect(calls.onPlayPause).toHaveBeenCalledOnce();
		expect(calls.onStep.mock.calls).toEqual([
			[-1, "second"],
			[1, "second"],
			[1, "second"],
		]);
		expect(calls.onClip.mock.calls).toEqual([[-1], [1]]);
		expect(calls.onEdge.mock.calls).toEqual([["start"], ["end"]]);
		expect(calls.onMute).toHaveBeenCalledOnce();
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
			calls.onClip,
			calls.onEdge,
			calls.onMute,
		])
			expect(callback).not.toHaveBeenCalled();
		view.rerender({ enabled: false });
		key("s", true);
		expect(calls.onSave).not.toHaveBeenCalled();
	});
	it("steps clean cuts with the up and down arrows, restores with R and undoes with the command key", () => {
		const calls = {
			...actions(),
			onCut: vi.fn(),
			onRestore: vi.fn(),
			onUndo: vi.fn(),
			onRedo: vi.fn(),
		};
		renderHook(() => useRecordingReviewShortcuts(calls));
		key("ArrowDown");
		key("ArrowUp");
		key("r");
		key("z", true);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true }));
		expect(calls.onCut.mock.calls).toEqual([[1], [-1]]);
		expect(calls.onClip).not.toHaveBeenCalled();
		expect(calls.onRestore).toHaveBeenCalledOnce();
		expect(calls.onUndo).toHaveBeenCalledOnce();
		expect(calls.onRedo).toHaveBeenCalledOnce();
	});
	it("keeps clip jumps and leaves R and undo alone without the clean cut panel", () => {
		const calls = actions();
		renderHook(() => useRecordingReviewShortcuts(calls));
		key("ArrowDown");
		const restore = new KeyboardEvent("keydown", { key: "r", cancelable: true });
		window.dispatchEvent(restore);
		const undo = new KeyboardEvent("keydown", { key: "z", metaKey: true, cancelable: true });
		window.dispatchEvent(undo);
		expect(calls.onClip).toHaveBeenCalledWith(1);
		expect(restore.defaultPrevented).toBe(false);
		expect(undo.defaultPrevented).toBe(false);
	});
	it("loops the clean cut card's cut on L while the card is up, and steps on L without it", () => {
		const onLoop = vi.fn();
		const calls = { ...actions(), onLoop };
		const { rerender } = renderHook((options) => useRecordingReviewShortcuts(options), {
			initialProps: calls as ReturnType<typeof actions> & { onLoop?: () => void },
		});
		key("l");
		expect(onLoop).toHaveBeenCalledOnce();
		expect(calls.onStep).not.toHaveBeenCalled();
		rerender({ ...calls, onLoop: undefined });
		key("l");
		expect(calls.onStep).toHaveBeenCalledWith(1, "second");
	});
});
