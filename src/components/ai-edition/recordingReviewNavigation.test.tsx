// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecordingReviewNavigation } from "./recordingReviewNavigation";
import { useRecordingReviewMenu } from "./useRecordingReviewMenu";
import { useRecordingReviewShortcuts } from "./useRecordingReviewShortcuts";

afterEach(cleanup);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((success, failure) => {
		resolve = success;
		reject = failure;
	});
	return { promise, resolve, reject };
}

function navigationDuringImport(isExporting?: () => boolean) {
	const importing = deferred<{ consumed: boolean }>();
	let refreshPending = true;
	let sessionPending = true;
	const importSettled = importing.promise
		.then(
			({ consumed }) => {
				sessionPending = !consumed;
			},
			() => undefined,
		)
		.finally(() => {
			refreshPending = false;
		});
	const guard = createRecordingReviewNavigation({
		isPreparing: () => refreshPending || sessionPending,
		isExporting,
	});
	const openLibrary = vi.fn();
	let openFromMenu: (() => void) | undefined;
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			onMenuLoadProject: (callback: () => void) => {
				openFromMenu = callback;
				return () => {
					openFromMenu = undefined;
				};
			},
		},
	});
	const onRecordings = () => {
		guard.run(openLibrary);
	};
	const actions = {
		enabled: true,
		onSave: vi.fn(),
		onRecord: vi.fn(),
		onRecordings,
	};
	renderHook(() => {
		useRecordingReviewMenu(actions);
		useRecordingReviewShortcuts({
			...actions,
			isMac: false,
			playPause: { key: " " },
			onPlayPause: vi.fn(),
			onStep: vi.fn(),
			onClip: vi.fn(),
			onEdge: vi.fn(),
			onMute: vi.fn(),
		});
	});
	const navigate = () => {
		expect(openFromMenu).toBeTypeOf("function");
		openFromMenu?.();
		const keyboard = new KeyboardEvent("keydown", {
			key: "o",
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		window.dispatchEvent(keyboard);
		expect(keyboard.defaultPrevented).toBe(true);
	};
	return { guard, importing, importSettled, openLibrary, navigate };
}

describe("recording review navigation", () => {
	it("reads the latest preparation state without replacing its callbacks", () => {
		let preparing = false;
		const guard = createRecordingReviewNavigation({ isPreparing: () => preparing });
		const open = vi.fn();
		expect(guard.isBlocked()).toBe(false);
		expect(guard.run(open)).toBe(true);
		preparing = true;
		expect(guard.isBlocked()).toBe(true);
		expect(guard.run(open)).toBe(false);
		expect(open).toHaveBeenCalledOnce();
		preparing = false;
		expect(guard.isBlocked()).toBe(false);
		expect(guard.run(open)).toBe(true);
		expect(open).toHaveBeenCalledTimes(2);
	});

	it("blocks File/Open and Ctrl+O until the deferred recording handoff is consumed", async () => {
		const state = navigationDuringImport();
		expect(state.guard.isBlocked()).toBe(true);
		state.navigate();
		expect(state.openLibrary).not.toHaveBeenCalled();
		state.importing.resolve({ consumed: true });
		state.navigate();
		expect(state.openLibrary).not.toHaveBeenCalled();
		await state.importSettled;
		expect(state.guard.isBlocked()).toBe(false);
		state.navigate();
		expect(state.openLibrary).toHaveBeenCalledTimes(2);
	});

	it.each([
		"canceled",
		"rejected",
	] as const)("keeps File/Open and Ctrl+O blocked after a %s import leaves its recording pending", async (outcome) => {
		const state = navigationDuringImport();
		state.navigate();
		expect(state.openLibrary).not.toHaveBeenCalled();
		if (outcome === "canceled") state.importing.resolve({ consumed: false });
		else state.importing.reject(new Error("Recording import failed"));
		await state.importSettled;
		expect(state.guard.isBlocked()).toBe(true);
		state.navigate();
		expect(state.openLibrary).not.toHaveBeenCalled();
	});

	it("does not open an asynchronous picker while a handoff is pending", async () => {
		const guard = createRecordingReviewNavigation({ isPreparing: () => true });
		const prepare = vi.fn(async () => "recording.mp4");
		const apply = vi.fn();
		expect(await guard.runAfter(prepare, apply)).toBe(false);
		expect(prepare).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});

	it("blocks library menu and shortcut during source copying and permits them after completion", async () => {
		let exporting = false;
		const state = navigationDuringImport(() => exporting);
		state.importing.resolve({ consumed: true });
		await state.importSettled;
		exporting = true;
		expect(state.guard.isBlocked()).toBe(true);
		state.navigate();
		expect(state.openLibrary).not.toHaveBeenCalled();
		exporting = false;
		state.navigate();
		expect(state.openLibrary).toHaveBeenCalledTimes(2);
	});

	it("rejects a pending picker result when an export begins before project replacement", async () => {
		let exporting = false;
		const guard = createRecordingReviewNavigation({
			isPreparing: () => false,
			isExporting: () => exporting,
		});
		const picker = deferred<string>();
		const apply = vi.fn();
		const navigation = guard.runAfter(() => picker.promise, apply);
		exporting = true;
		picker.resolve("old-recording.mp4");
		expect(await navigation).toBe(false);
		expect(apply).not.toHaveBeenCalled();
	});

	it("rejects a picker result if a recording handoff starts while the picker is open", async () => {
		let preparing = false;
		const guard = createRecordingReviewNavigation({ isPreparing: () => preparing });
		const picker = deferred<string>();
		const prepare = vi.fn(() => picker.promise);
		const apply = vi.fn();
		const navigation = guard.runAfter(prepare, apply);
		expect(prepare).toHaveBeenCalledOnce();
		preparing = true;
		picker.resolve("old-recording.mp4");
		expect(await navigation).toBe(false);
		expect(apply).not.toHaveBeenCalled();
	});

	it("rejects an old picker after the project changes even if the handoff has cleared", async () => {
		let preparing = false;
		let projectId = "old-project";
		const guard = createRecordingReviewNavigation({ isPreparing: () => preparing });
		const picker = deferred<string>();
		const apply = vi.fn();
		const selectedProject = projectId;
		const navigation = guard.runAfter(
			() => picker.promise,
			apply,
			() => projectId === selectedProject,
		);
		preparing = true;
		projectId = "new-recording";
		preparing = false;
		picker.resolve("old-recording.mp4");
		expect(await navigation).toBe(false);
		expect(apply).not.toHaveBeenCalled();
	});

	it("rejects an already stale project before opening the picker", async () => {
		const guard = createRecordingReviewNavigation({ isPreparing: () => false });
		const prepare = vi.fn(async () => "recording.mp4");
		const apply = vi.fn();
		expect(await guard.runAfter(prepare, apply, () => false)).toBe(false);
		expect(prepare).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});

	it("applies the picker result and waits for a current asynchronous action to finish", async () => {
		const guard = createRecordingReviewNavigation({ isPreparing: () => false });
		const picker = deferred<string>();
		const applied = deferred<void>();
		const apply = vi.fn(() => applied.promise);
		let settled = false;
		const navigation = guard
			.runAfter(() => picker.promise, apply)
			.then((result) => {
				settled = true;
				return result;
			});
		picker.resolve("current-recording.mp4");
		await picker.promise;
		expect(apply).toHaveBeenCalledWith("current-recording.mp4");
		expect(settled).toBe(false);
		applied.resolve();
		expect(await navigation).toBe(true);
	});
});
