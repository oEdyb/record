import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioController, type StudioTake, type StudioWindowLike } from "./studioController";
import { IDLE_PILL_STATE } from "./types";

function fakeWindow() {
	let visible = false;
	let opacity = 1;
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
			getOpacity: () => opacity,
			setOpacity: (value: number) => {
				opacity = value;
			},
			show: vi.fn(() => (visible = true)),
			showInactive: vi.fn(() => (visible = true)),
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

function setup(
	take: StudioTake | null,
	outside: boolean | Partial<ConstructorParameters<typeof StudioController>[0]> = false,
) {
	const overrides = typeof outside === "object" ? outside : {};
	const outsideValue = typeof outside === "boolean" ? outside : false;
	const studio = fakeWindow();
	const pill = fakeWindow();
	pill.window.show();
	const state = { take };
	const sendToPill = vi.fn();
	const openReview = vi.fn();
	const outsideCapture = vi.fn(async () => outsideValue);
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
		setup: () => ({
			source: null,
			micEnabled: true,
			micDeviceId: null,
			cameraEnabled: true,
			cameraDeviceId: null,
			systemAudioEnabled: false,
			cursorCaptureMode: "system",
			recordingQuality: "high",
		}),
		openReview,
		getPill: () => pill.window,
		createWindow: () => studio.window,
		sendToPill,
		outsideCapture,
		endCaptureCheck: vi.fn(),
		waitForUnmap: async () => undefined,
		now: () => 1_000,
		...overrides,
	});
	controller.recordReady(pill.window.webContents, true);
	return { controller, studio, pill, state, sendToPill, outsideCapture, openReview };
}

const paused: StudioTake = { recordingId: 1, clips: [], running: true, paused: true };
const recording: StudioTake = { ...paused, paused: false };

describe("StudioController", () => {
	afterEach(() => vi.useRealTimers());
	it("owns controls between opening Studio and returning to the pill", () => {
		const { controller, studio } = setup(null);
		expect(controller.ownsControls()).toBe(false);
		controller.open();
		studio.ready();
		expect(controller.ownsControls()).toBe(true);
		controller.backToPill();
		expect(controller.ownsControls()).toBe(false);
	});

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
		expect(sendToPill).toHaveBeenCalledWith("hud-start-recording", expect.any(Number));
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

	it("keeps a take stopped in the Studio for read-back, and Finish hands it to the review", () => {
		const { controller, studio, state, openReview } = setup(paused);
		controller.open();
		studio.ready();
		controller.sync();
		const clip = { index: 0, durationMs: 1_000, removed: false } as StudioTake["clips"][number];
		const removed = { ...clip, index: 1, removed: true };
		controller.stored({ recordingId: 7, clips: [clip, removed] });
		state.take = { recordingId: 7, clips: [], running: false, paused: false };
		controller.sync();
		expect(controller.keepsReview()).toBe(true);
		expect(studio.visible()).toBe(true);
		const snapshot = controller.snapshot();
		expect(snapshot.phase).toBe("review");
		expect(snapshot.recordingId).toBe(7);
		expect(snapshot.clips).toEqual([clip]);

		controller.command("finish");
		expect(openReview).toHaveBeenCalledOnce();
		expect(openReview).toHaveBeenCalledWith(
			{ x: 10, y: 20, width: 400, height: 60 },
			expect.any(Function),
		);
		expect(studio.visible()).toBe(true);
		openReview.mock.calls[0][1]();
		expect(studio.visible()).toBe(false);
		expect(controller.keepsReview()).toBe(false);
	});

	it("waits for the pill to finish saving before Finish opens the review", () => {
		const { controller, studio, state, openReview } = setup(paused);
		controller.open();
		studio.ready();
		controller.sync();
		const pillState = {
			controlsLocked: true,
			canRemovePreviousClip: false,
			undoClipIndex: null,
			countingDown: false,
			transportBusy: true,
			canPause: false,
			saving: true,
		};
		controller.setPillState(pillState);
		controller.stored({ recordingId: 7, clips: [] });
		state.take = { recordingId: 7, clips: [], running: false, paused: false };
		controller.sync();
		controller.command("pill");
		expect(openReview).not.toHaveBeenCalled();
		expect(studio.visible()).toBe(true);
		controller.setPillState({ ...pillState, saving: false, transportBusy: false });
		expect(openReview).toHaveBeenCalledOnce();
		openReview.mock.calls[0][1]();
		expect(studio.visible()).toBe(false);
	});

	it("follows the stored take when its camera clips are attached later", () => {
		const clip = { index: 0, durationMs: 1_000, removed: false } as StudioTake["clips"][number];
		const { controller, studio, state } = setup(paused);
		controller.open();
		studio.ready();
		controller.sync();
		controller.stored({ recordingId: 7, clips: [] });
		state.take = { recordingId: 7, clips: [], running: false, paused: false };
		controller.sync();
		controller.sessionUpdated({ recordingId: 7, clips: [clip] });
		expect(controller.snapshot().clips).toEqual([clip]);
		controller.sessionUpdated({ recordingId: 8, clips: [] });
		expect(controller.snapshot().clips).toEqual([clip]);
	});

	it.each([
		"linux",
		"darwin",
	] as const)("waits for the replacement pill's state on %s", (platform) => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
		try {
			const { controller } = setup(null, { getPill: () => null, ensurePill: vi.fn() });
			controller.open();
			expect(controller.snapshot().pill.controlsLocked).toBe(platform === "linux");
			expect(controller.snapshot().pill.transportBusy).toBe(platform === "linux");
			controller.setPillState(IDLE_PILL_STATE);
			expect(controller.snapshot().pill.controlsLocked).toBe(false);
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("asks for a pill when the Studio opens without one", () => {
		const ensurePill = vi.fn();
		const { controller } = setup(paused, { getPill: () => null, ensurePill });
		controller.open();
		expect(ensurePill).toHaveBeenCalledOnce();
	});

	it("brings the pill back when the pill needs the user", () => {
		const { controller, studio } = setup(paused);
		controller.open();
		studio.ready();
		controller.sync();
		controller.pillNeedsUser();
		expect(studio.visible()).toBe(false);
	});

	it("drops an older read-back when a later take is saved from the pill", () => {
		const { controller, studio, state, openReview } = setup(paused);
		controller.open();
		studio.ready();
		controller.sync();
		controller.stored({ recordingId: 7, clips: [] });
		state.take = { recordingId: 7, clips: [], running: false, paused: false };
		controller.sync();
		controller.command("finish");
		openReview.mock.calls[0][1]();
		controller.stored({ recordingId: 8, clips: [] });
		expect(controller.keepsReview()).toBe(false);
		expect(controller.snapshot().phase).not.toBe("review");
	});

	it("lets the normal review open when the take ends from the pill", () => {
		const { controller, state } = setup(paused);
		controller.stored({ recordingId: 7, clips: [] });
		state.take = { recordingId: 7, clips: [], running: false, paused: false };
		controller.sync();
		expect(controller.keepsReview()).toBe(false);
	});

	it("routes setup commands to the pill's own handlers and mirrors its state", () => {
		const { controller, sendToPill } = setup(paused);
		controller.command("toggle-camera");
		controller.command({ kind: "select-mic", deviceId: "mic-2", name: "USB" });
		expect(sendToPill).toHaveBeenCalledWith("studio-setup-command", "toggle-camera");
		expect(sendToPill).toHaveBeenCalledWith("studio-setup-command", {
			kind: "select-mic",
			deviceId: "mic-2",
			name: "USB",
		});
		controller.setPillState({
			controlsLocked: true,
			canRemovePreviousClip: true,
			undoClipIndex: 3,
			countingDown: false,
			transportBusy: false,
			canPause: false,
			saving: false,
		});
		expect(controller.snapshot().pill.undoClipIndex).toBe(3);
		expect(controller.snapshot().setup.micEnabled).toBe(true);
	});
});

describe("Studio handoff cancellation", () => {
	afterEach(() => vi.useRealTimers());
	function finishing() {
		const result = setup(null);
		result.controller.open();
		result.studio.ready();
		result.controller.stored({ recordingId: 7, clips: [] });
		return result;
	}
	it("holds Studio until review signals a painted frame without showing the pill", () => {
		vi.useFakeTimers();
		const { controller, studio, pill, openReview } = finishing();
		vi.mocked(pill.window.show).mockClear();
		controller.command("finish");
		vi.advanceTimersByTime(1499);
		expect(studio.visible()).toBe(true);
		expect(pill.window.show).not.toHaveBeenCalled();
		openReview.mock.calls[0][1]();
		expect(studio.visible()).toBe(false);
		expect(controller.ownsControls()).toBe(true);
	});
	it("times out after 1500ms and ignores a late signal after Studio reopens", () => {
		vi.useFakeTimers();
		const { controller, studio, openReview } = finishing();
		controller.command("finish");
		vi.advanceTimersByTime(1500);
		expect(studio.visible()).toBe(false);
		controller.open();
		openReview.mock.calls[0][1]();
		expect(studio.visible()).toBe(true);
	});
	it("cancels an unfinished handoff when Studio is reopened", () => {
		vi.useFakeTimers();
		const { controller, studio, openReview } = finishing();
		controller.command("finish");
		controller.open();
		openReview.mock.calls[0][1]();
		vi.advanceTimersByTime(2000);
		expect(studio.visible()).toBe(true);
	});
});

it("keeps an outgoing window visible and retargets rapid pill/Studio reversals", () => {
	const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	vi.useFakeTimers();
	try {
		const { controller, studio, pill } = setup(null, { motionEnabled: () => true });
		controller.open();
		studio.ready();
		expect(studio.visible()).toBe(true);
		expect(studio.window.focus).toHaveBeenCalled();
		expect(pill.visible()).toBe(true);
		vi.advanceTimersByTime(48);
		controller.backToPill();
		expect(pill.window.focus).toHaveBeenCalled();
		vi.advanceTimersByTime(32);
		const current = studio.window.getOpacity?.();
		controller.open();
		expect(studio.window.getOpacity?.()).toBe(current);
		vi.advanceTimersByTime(200);
		expect(studio.visible()).toBe(true);
		expect(studio.window.getOpacity?.()).toBe(1);
		expect(pill.visible()).toBe(false);
	} finally {
		platformSpy.mockRestore();
		vi.useRealTimers();
	}
});

it("fades the pill out while the Studio fades in, and brings it back opaque", () => {
	const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	vi.useFakeTimers();
	try {
		const { controller, studio, pill } = setup(null, { motionEnabled: () => true });
		controller.open();
		studio.ready();
		vi.advanceTimersByTime(48);
		expect(pill.window.getOpacity?.()).toBeLessThan(1);
		vi.advanceTimersByTime(80);
		expect(pill.visible()).toBe(false);
		expect(studio.window.getOpacity?.()).toBeLessThan(1);
		expect(pill.window.getOpacity?.()).toBe(1);
		controller.backToPill();
		expect(pill.visible()).toBe(true);
		expect(pill.window.getOpacity?.()).toBe(1);
	} finally {
		platformSpy.mockRestore();
		vi.useRealTimers();
	}
});

it.each([
	false,
	true,
])("switches Linux windows instantly without opacity calls (motion %s)", (motion) => {
	vi.useFakeTimers();
	try {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const { controller, studio, pill } = setup(null, { motionEnabled: () => motion });
		const studioOpacity = vi.spyOn(studio.window, "setOpacity");
		const pillOpacity = vi.spyOn(pill.window, "setOpacity");
		controller.open();
		studio.ready();
		expect(studio.visible()).toBe(true);
		expect(pill.visible()).toBe(false);
		expect(studioOpacity).not.toHaveBeenCalled();
		expect(pillOpacity).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(studio.close()).toBe(true);
		expect(studio.visible()).toBe(false);
		expect(pill.visible()).toBe(true);
		expect(studioOpacity).not.toHaveBeenCalled();
		expect(pillOpacity).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

it("lifts the pill over the Studio while a warning shows, and keeps the Studio up", () => {
	const { controller, studio, pill } = setup(null);
	controller.open();
	studio.ready();
	expect(pill.visible()).toBe(false);
	controller.pillNotice(true);
	expect(pill.visible()).toBe(true);
	expect(studio.visible()).toBe(true);
	controller.pillNotice(false);
	expect(pill.visible()).toBe(false);
	expect(studio.visible()).toBe(true);
});

it("leaves the pill alone when the warning ends and the Studio does not own the controls", () => {
	const { controller, pill } = setup(null);
	controller.pillNotice(false);
	expect(pill.visible()).toBe(true);
});
