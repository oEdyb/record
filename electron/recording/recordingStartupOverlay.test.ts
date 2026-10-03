import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	createRecordingStartupOverlayController,
	type RecordingStartupOverlayWindow,
} from "./recordingStartupOverlay";

function makeOverlay(loading = true) {
	const windowEvents = new EventEmitter();
	const contentsEvents = new EventEmitter();
	const window = {
		isDestroyed: vi.fn(() => false),
		isVisible: vi.fn(() => false),
		showInactive: vi.fn(),
		hide: vi.fn(),
		once: (event: string, listener: () => void) => windowEvents.once(event, listener),
		removeListener: (event: string, listener: () => void) =>
			windowEvents.removeListener(event, listener),
		webContents: {
			isLoading: vi.fn(() => loading),
			once: (event: string, listener: () => void) => contentsEvents.once(event, listener),
			removeListener: (event: string, listener: () => void) =>
				contentsEvents.removeListener(event, listener),
			send: vi.fn(),
		},
	};
	const controller = createRecordingStartupOverlayController({
		getWindow: () => window,
		createWindow: () => window,
	});
	return { window, windowEvents, contentsEvents, controller };
}

afterEach(() => vi.useRealTimers());

describe("recording startup overlay", () => {
	it("accepts Electron BrowserWindow event overloads without an adapter", () => {
		expectTypeOf<BrowserWindow>().toExtend<RecordingStartupOverlayWindow>();
	});

	it("bounds a missed ready-to-show event instead of blocking Record forever", async () => {
		vi.useFakeTimers();
		const { window, windowEvents, controller } = makeOverlay();
		windowEvents.emit("ready-to-show");
		const showing = controller.show(3, 1);
		await vi.advanceTimersByTimeAsync(300);
		await showing;
		expect(window.showInactive).not.toHaveBeenCalled();
		expect(windowEvents.listenerCount("ready-to-show")).toBe(0);
	});

	it("uses finished loading when the first-frame event was already emitted", async () => {
		const { window, contentsEvents, controller } = makeOverlay();
		const showing = controller.show(3, 1);
		contentsEvents.emit("did-finish-load");
		await showing;
		expect(window.showInactive).toHaveBeenCalledOnce();
		expect(window.webContents.send).toHaveBeenCalledWith("countdown-overlay-value", 3, 1);
	});

	it("never resurrects an overlay after the loading request was cancelled", async () => {
		vi.useFakeTimers();
		const { window, windowEvents, controller } = makeOverlay();
		const showing = controller.show(3, 1);
		controller.hide(1);
		await showing;
		expect(vi.getTimerCount()).toBe(0);
		windowEvents.emit("ready-to-show");
		expect(window.showInactive).not.toHaveBeenCalled();
		expect(window.hide).toHaveBeenCalledOnce();
	});

	it("cancels an older readiness wait when another recording requests the overlay", async () => {
		vi.useFakeTimers();
		const { window, contentsEvents, controller } = makeOverlay();
		const previous = controller.show(3, 1);
		const current = controller.show(3, 2);
		await previous;
		contentsEvents.emit("did-finish-load");
		await current;
		expect(window.webContents.send).toHaveBeenCalledOnce();
		expect(window.webContents.send).toHaveBeenCalledWith("countdown-overlay-value", 3, 2);
	});

	it("ignores delayed value/hide requests from a previous recording", async () => {
		const { window, controller } = makeOverlay(false);
		await controller.show(1, 2);
		controller.setValue(3, 1);
		controller.hide(1);
		expect(window.hide).not.toHaveBeenCalled();
		expect(window.webContents.send).toHaveBeenCalledTimes(1);
	});
});
