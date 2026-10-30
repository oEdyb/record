import { describe, expect, it, vi } from "vitest";
import { StudioController, type StudioTake, type StudioWindowLike } from "./studioController";

function fakeWindow() {
	let visible = false;
	const listeners: Record<string, (event?: { preventDefault(): void }) => void> = {};
	const win = {
		visible: () => visible,
		ready: () => listeners["ready-to-show"]?.(),
		close: () => {
			let prevented = false;
			listeners.close?.({ preventDefault: () => (prevented = true) });
			return prevented;
		},
		sent: [] as unknown[],
		window: {
			isDestroyed: () => false,
			isVisible: () => visible,
			show: vi.fn(() => (visible = true)),
			hide: vi.fn(() => (visible = false)),
			focus: vi.fn(),
			getBounds: () => ({ x: 10, y: 20, width: 400, height: 60 }),
			once: (event: string, listener: () => void) => (listeners[event] = listener),
			on: (event: string, listener: (event?: { preventDefault(): void }) => void) =>
				(listeners[event] = listener),
			webContents: { send: (_channel: string, payload: unknown) => win.sent.push(payload) },
		} as unknown as StudioWindowLike,
	};
	return win;
}

function setup(take: StudioTake | null, outside = false) {
	const studio = fakeWindow();
	const pill = fakeWindow();
	pill.window.show();
	const state = { take };
	const sendToPill = vi.fn();
	const outsideCapture = vi.fn(async () => outside);
	const controller = new StudioController({
		take: () => state.take,
		transcript: () => ({
			recordingId: null,
			clips: [],
			status: "idle",
			progress: null,
			download: null,
			error: null,
			updatedAt: 0,
		}),
		getPill: () => pill.window,
		createWindow: () => studio.window,
		sendToPill,
		outsideCapture,
		endCaptureCheck: vi.fn(),
		waitForUnmap: async () => undefined,
		now: () => 1_000,
	});
	return { controller, studio, pill, state, sendToPill, outsideCapture };
}

const paused: StudioTake = { recordingId: 1, clips: [], running: true, paused: true };
const recording: StudioTake = { ...paused, paused: false };

describe("StudioController", () => {
	it("shows the Studio once it is ready and tucks the pill away", () => {
		const { controller, studio, pill } = setup(paused);
		controller.open();
		expect(studio.visible()).toBe(false);
		studio.ready();
		expect(studio.visible()).toBe(true);
		expect(pill.visible()).toBe(false);
	});

	it("steps aside before capture resumes when it would be recorded", async () => {
		const { controller, studio, state, outsideCapture } = setup(paused, false);
		controller.open();
		studio.ready();
		await controller.beforeCapture({ pipeWireNodeId: 42, windowSource: false });
		expect(outsideCapture).toHaveBeenCalledWith(42);
		expect(studio.visible()).toBe(false);
		state.take = recording;
		controller.sync();
		expect(studio.visible()).toBe(false);
		expect(controller.snapshot().hiddenForCapture).toBe(true);
	});

	it("stays up while recording on a screen that is not recorded, and comes back on pause", async () => {
		const { controller, studio, state } = setup(paused, true);
		controller.open();
		studio.ready();
		await controller.beforeCapture({ pipeWireNodeId: 42, windowSource: false });
		state.take = recording;
		controller.sync();
		expect(studio.visible()).toBe(true);
		expect(controller.snapshot()).toMatchObject({ phase: "recording", liveSinceMs: 1_000 });

		controller.revoke();
		expect(studio.visible()).toBe(false);
		state.take = paused;
		controller.sync();
		expect(studio.visible()).toBe(true);
	});

	it("holds replay before capture resumes, even with the Studio hidden", async () => {
		const { controller, studio, state } = setup(paused, true);
		controller.open();
		studio.ready();
		controller.backToPill();
		await controller.beforeCapture({ pipeWireNodeId: 42, windowSource: false });
		expect(studio.sent.at(-1)).toMatchObject({ holdPlayback: true });
		state.take = recording;
		controller.sync();
		expect(controller.snapshot().holdPlayback).toBe(true);
		state.take = paused;
		controller.sync();
		expect(controller.snapshot().holdPlayback).toBe(false);
	});

	it("hides at once when the compositor revokes it while capture is resuming", async () => {
		const { controller, studio } = setup(paused, true);
		controller.open();
		studio.ready();
		await controller.beforeCapture({ pipeWireNodeId: 42, windowSource: false });
		expect(studio.visible()).toBe(true);
		// The take still reads as paused: capture has not reported running yet.
		controller.revoke();
		expect(studio.visible()).toBe(false);
	});

	it("tells the page when its window hides and shows, since it is never throttled", () => {
		const { controller, studio } = setup(paused);
		controller.open();
		studio.ready();
		expect(studio.sent.at(-1)).toMatchObject({ shown: true });
		controller.backToPill();
		expect(studio.sent.at(-1)).toMatchObject({ shown: false });
		controller.open();
		expect(studio.sent.at(-1)).toMatchObject({ shown: true });
	});

	it("keeps the pill tucked away when switching back during capture", () => {
		const { controller, studio, pill, state } = setup(paused, true);
		controller.open();
		studio.ready();
		state.take = recording;
		controller.backToPill();
		expect(studio.visible()).toBe(false);
		expect(pill.visible()).toBe(false);
		state.take = paused;
		controller.backToPill();
		expect(pill.visible()).toBe(true);
	});

	it("treats closing the window as switching to the pill", () => {
		const { controller, studio, pill } = setup(paused);
		controller.open();
		studio.ready();
		expect(studio.close()).toBe(true);
		expect(studio.visible()).toBe(false);
		expect(pill.visible()).toBe(true);
	});

	it("hands the take to the review when it ends", () => {
		const { controller, studio, state } = setup(paused);
		controller.open();
		studio.ready();
		state.take = null;
		controller.sync();
		expect(studio.visible()).toBe(false);
		state.take = paused;
		controller.sync();
		expect(studio.visible()).toBe(false);
	});

	it("opens idle, starts a take through the pill and stays expanded", () => {
		const { controller, studio, pill, state, sendToPill } = setup(null);
		controller.open();
		studio.ready();
		expect(studio.visible()).toBe(true);
		expect(pill.visible()).toBe(false);
		controller.sync();
		expect(studio.visible()).toBe(true);
		controller.command("record");
		expect(sendToPill).toHaveBeenCalledWith("hud-start-recording");
		state.take = recording;
		controller.command("record");
		expect(sendToPill).toHaveBeenCalledOnce();
	});

	it("moves to another screen instead of hiding, and back on pause", async () => {
		const { controller, studio, state, outsideCapture } = setup(paused, false);
		const moveOffCapture = vi.fn(async () => "DP-3");
		const returnTo = vi.fn(async () => undefined);
		Object.assign((controller as unknown as { deps: Record<string, unknown> }).deps, {
			moveOffCapture,
			returnTo,
		});
		outsideCapture.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		controller.open();
		studio.ready();
		await controller.beforeCapture({ pipeWireNodeId: 42, windowSource: false });
		expect(moveOffCapture).toHaveBeenCalledWith(42);
		state.take = recording;
		controller.sync();
		expect(studio.visible()).toBe(true);
		state.take = paused;
		controller.sync();
		expect(returnTo).toHaveBeenCalledWith("DP-3");
	});

	it("asks the pill to run each command, only when it applies", () => {
		const { controller, sendToPill, state } = setup(paused);
		controller.command("pause");
		controller.command("resume");
		controller.command("remove-last");
		controller.command("stop");
		expect(sendToPill.mock.calls.map(([channel]) => channel)).toEqual([
			"hud-toggle-recording-pause",
			"hud-remove-previous-clip",
			"stop-recording-from-tray",
		]);
		state.take = null;
		sendToPill.mockClear();
		controller.command("stop");
		expect(sendToPill).not.toHaveBeenCalled();
	});
});
