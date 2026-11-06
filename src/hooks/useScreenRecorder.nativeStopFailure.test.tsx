// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RecordingStreamRegistry,
	registerRecordingStreamHandlers,
} from "../../electron/ipc/recordingStream";
import { RendererRecordingStop } from "../../electron/recording/rendererRecordingStop";

vi.mock("@/contexts/I18nContext", () => {
	const messages: Record<string, string> = {
		"recording.startFailed": "Could not start recording. Press Record again, or reopen Klippt.",
		"recording.pauseFailed":
			"Could not pause and save this clip. Press Stop, then check Recordings.",
		"recording.continueFailed": "Could not continue recording. Press Stop, then check Recordings.",
		"recording.continueRetry": "Still paused. Check settings and try Continue again.",
		"recording.stopFailed":
			"Could not finish Stop or open review. Reopen Klippt, then check Recordings.",
	};
	const translate = (key: string) => messages[key] ?? key;
	return { useScopedT: () => translate };
});

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import type { NativeRecordingAppStopRequest } from "@/lib/nativeMacRecording";
import { receiveRecordRequest, traceRecordRequest } from "@/lib/recording/recordRequestTrace";
import type { RecordingSession, RecordingSessionClip } from "@/lib/recordingSession";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;
let originalMediaDevices: PropertyDescriptor | undefined;

class FakeMediaRecorder {
	private events = new EventTarget();
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: AddEventListenerOptions | boolean,
	) {
		this.events.addEventListener(type, listener, options);
	}
	removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		this.events.removeEventListener(type, listener);
	}
	dispatchEvent(event: Event) {
		return this.events.dispatchEvent(event);
	}
	static instances: FakeMediaRecorder[] = [];
	static isTypeSupported = () => true;
	state: RecordingState = "inactive";
	ondataavailable: ((event: BlobEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	onstop: (() => void) | null = null;

	constructor(
		readonly stream: MediaStream,
		readonly options: MediaRecorderOptions,
	) {
		FakeMediaRecorder.instances.push(this);
	}

	start() {
		this.state = "recording";
	}

	pause() {
		this.state = "paused";
	}

	resume() {
		this.state = "recording";
	}

	stop() {
		if (this.state === "inactive") return;
		this.state = "inactive";
		queueMicrotask(() => this.onstop?.());
	}
}

function fakeWebcamStream(format: {
	width: number;
	height: number;
	fps: number;
	deviceId?: string;
}): MediaStream {
	const track = {
		onended: null,
		stop: vi.fn(),
		getSettings: () => ({
			width: format.width,
			height: format.height,
			frameRate: format.fps,
			deviceId: format.deviceId,
		}),
	} as unknown as MediaStreamTrack;
	return {
		getTracks: () => [track],
		getVideoTracks: () => [track],
	} as unknown as MediaStream;
}

/**
 * Only what the native-Windows record/stop round trip touches. Anything the
 * hook reaches for that is not stubbed will throw loudly, which is the point.
 */
function stubElectronAPI(overrides: Record<string, unknown> = {}) {
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		traceRecordRequest: vi.fn(),
		getPlatform: vi.fn(() => "win32"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeWindowsRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeWindowsRecording: vi.fn(async () => ({ success: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
		acknowledgeNativeRecordingAppStop: vi.fn(async () => ({ success: true })),
	};
	window.electronAPI = { ...api, ...overrides } as unknown as ElectronAPI;
}

type RecorderView = { result: { current: ReturnType<typeof useScreenRecorder> } };

/**
 * Runs every pending timer and microtask. `waitFor` is unusable here: it polls
 * on the same timers this suite fakes, so it can only ever time out.
 */
async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

/** Drives the hook through native first-frame confirmation. */
async function startNativeRecording(view: RecorderView) {
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle(20);
	expect(view.result.current.recording).toBe(true);
}

async function pressStop(view: RecorderView) {
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle();
}

beforeEach(() => {
	vi.useFakeTimers();
	originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	FakeMediaRecorder.instances = [];
	stubElectronAPI();
});

afterEach(() => {
	traceRecordRequest("cleanup", { captureStarted: false });
	if (originalMediaDevices) {
		Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
	} else {
		Reflect.deleteProperty(navigator, "mediaDevices");
	}
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useScreenRecorder start timing", () => {
	it("confirms a tagged Windows request only after the native start response", async () => {
		let finish: (result: { success: true; recordingId: number }) => void = () => undefined;
		api.startNativeWindowsRecording.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const view = renderHook(() => useScreenRecorder());
		receiveRecordRequest(9001);
		act(() => view.result.current.startRecordingFromRequest());
		await settle();
		expect(
			api.traceRecordRequest.mock.calls.some(([event]) => event.stage === "windows-writer-started"),
		).toBe(false);
		await act(async () => finish({ success: true, recordingId: 7 }));
		await settle(20);
		expect(api.traceRecordRequest).toHaveBeenCalledWith({
			token: 9001,
			stage: "windows-writer-started",
			flags: { recordingId: 7 },
		});
		expect(
			api.traceRecordRequest.mock.calls.some(
				([event]) => event.stage === "cleanup" && event.flags.captureStarted === false,
			),
		).toBe(false);
	});

	it("a start-only request cannot cancel a pending native start", async () => {
		let finish: (result: { success: true; recordingId: number }) => void = () => undefined;
		api.startNativeWindowsRecording.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const view = renderHook(() => useScreenRecorder());
		act(() => view.result.current.startRecordingFromRequest());
		await settle();
		act(() => view.result.current.startRecordingFromRequest());
		await settle();
		expect(view.result.current.starting).toBe(true);
		expect(api.hideCountdownOverlay).not.toHaveBeenCalled();
		expect(api.stopNativeWindowsRecording).not.toHaveBeenCalled();
		await act(async () => finish({ success: true, recordingId: 7 }));
		await settle(20);
		expect(view.result.current.recording).toBe(true);
		expect(api.startNativeWindowsRecording).toHaveBeenCalledOnce();
	});

	it.each([
		["win32", "pause-throw"],
		["darwin", "resume-throw"],
		["win32", "data"],
		["darwin", "data"],
		["win32", "error"],
		["darwin", "error"],
		["win32", "stop"],
		["darwin", "stop"],
	])("completes a %s browser request from %s without retaining a stale token", async (platform, outcome) => {
		stubElectronAPI({
			getPlatform: vi.fn(() => platform),
			isNativeWindowsCaptureAvailable: vi.fn(async () => ({
				success: true,
				available: false,
				reason: "unsupported-os",
			})),
			isNativeMacCaptureAvailable: vi.fn(async () => ({
				success: true,
				available: false,
				reason: "unsupported-platform",
			})),
			requestNativeMacCursorAccess: vi.fn(async () => ({ granted: true })),
			setRecordingState: vi.fn(async () => undefined),
		});
		const videoTrack = {
			stop: vi.fn(),
			applyConstraints: vi.fn(async () => undefined),
			getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
		};
		class TestStream {
			getTracks() {
				return [videoTrack];
			}
			getVideoTracks() {
				return [videoTrack];
			}
			getAudioTracks() {
				return [];
			}
			addTrack() {
				return undefined;
			}
		}
		vi.stubGlobal("MediaStream", TestStream);
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => new TestStream()),
				getDisplayMedia: vi.fn(async () => new TestStream()),
			},
		});
		const view = renderHook(() => useScreenRecorder());
		receiveRecordRequest(9002);
		act(() => view.result.current.startRecordingFromRequest());
		await settle(20);
		expect(view.result.current.recording).toBe(true);
		expect(
			api.traceRecordRequest.mock.calls.some(([event]) => event.stage === "browser-writer-started"),
		).toBe(false);
		const recorder = FakeMediaRecorder.instances[0];
		act(() =>
			recorder.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([]) })),
		);
		expect(
			api.traceRecordRequest.mock.calls.some(([event]) => event.stage === "browser-writer-started"),
		).toBe(false);
		if (outcome === "pause-throw" || outcome === "resume-throw") {
			if (outcome === "resume-throw") act(() => view.result.current.togglePaused());
			const action = vi
				.spyOn(recorder, outcome === "pause-throw" ? "pause" : "resume")
				.mockImplementation(() => {
					throw new Error("transport failed");
				});
			act(() => view.result.current.togglePaused());
			expect(view.result.current.recording).toBe(true);
			expect(view.result.current.clipFinalizing).toBe(false);
			action.mockRestore();
			act(() => view.result.current.toggleRecording());
			await settle();
			expect(recorder.state).toBe("inactive");
			expect(view.result.current.recording).toBe(false);
			return;
		}
		if (outcome !== "data") {
			recorder.state = "inactive";
			act(() => recorder.dispatchEvent(new Event(outcome)));
			expect(api.traceRecordRequest).toHaveBeenCalledWith({
				token: 9002,
				stage: "writer-failed",
				flags: {},
			});
			expect(receiveRecordRequest(9004)).toBe(true);
			traceRecordRequest("cleanup", { captureStarted: false });
			return;
		}
		act(() =>
			recorder.dispatchEvent(
				Object.assign(new Event("dataavailable"), { data: new Blob(["encoded video"]) }),
			),
		);
		expect(api.traceRecordRequest).toHaveBeenCalledWith({
			token: 9002,
			stage: "browser-writer-started",
			flags: { recordingId: expect.any(Number) },
		});
	});

	it("handles rapid primary Record clicks with a single pending start", async () => {
		const view = renderHook(() => useScreenRecorder());
		act(() => {
			view.result.current.toggleRecording();
			view.result.current.toggleRecording();
		});
		await settle(20);
		expect(api.startNativeWindowsRecording).toHaveBeenCalledOnce();
		expect(view.result.current.recording).toBe(true);
	});

	it("requests capture immediately and keeps startup visible until its first-frame confirmation", async () => {
		let finishStart: ((result: { success: true; recordingId: number }) => void) | undefined;
		api.startNativeWindowsRecording.mockReturnValue(
			new Promise((resolve) => {
				finishStart = resolve;
			}),
		);

		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();

		expect(api.showCountdownOverlay).not.toHaveBeenCalled();
		expect(view.result.current.starting).toBe(true);
		expect(api.setCountdownOverlayValue).not.toHaveBeenCalled();
		expect(api.startNativeWindowsRecording).toHaveBeenCalledOnce();
		expect(api.hideCountdownOverlay).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);

		finishStart?.({ success: true, recordingId: 7 });
		await settle(20);

		expect(view.result.current.recording).toBe(true);
		expect(view.result.current.starting).toBe(false);
		expect(api.hideCountdownOverlay).toHaveBeenCalledOnce();
	});

	it("starts only one native writer when immediate start is called twice", async () => {
		let finishStart: ((result: { success: true; recordingId: number }) => void) | undefined;
		api.startNativeWindowsRecording.mockReturnValue(
			new Promise((resolve) => {
				finishStart = resolve;
			}),
		);
		const view = renderHook(() => useScreenRecorder());
		act(() => {
			void view.result.current.startRecordingImmediately();
			void view.result.current.startRecordingImmediately();
		});
		await settle();
		expect(api.startNativeWindowsRecording).toHaveBeenCalledOnce();
		finishStart?.({ success: true, recordingId: 7 });
		await settle();
		expect(view.result.current.recording).toBe(true);
	});

	it("does not start another immediate writer while recording is active", async () => {
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.startRecordingImmediately();
		});
		await act(async () => {
			await view.result.current.startRecordingImmediately();
		});
		expect(api.startNativeWindowsRecording).toHaveBeenCalledOnce();
		expect(view.result.current.recording).toBe(true);
	});

	it("shows start recovery guidance with the IPC detail", async () => {
		api.startNativeWindowsRecording.mockRejectedValue(
			new Error("Error invoking remote method 'recording:start': Error: IPC channel closed"),
		);
		const view = renderHook(() => useScreenRecorder());

		await act(async () => {
			await view.result.current.startRecordingImmediately();
		});

		expect(view.result.current.recording).toBe(false);
		expect(view.result.current.starting).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not start recording. Press Record again, or reopen Klippt.",
			{ description: "IPC channel closed" },
		);
	});

	it("keeps the specific permission message when start permission is denied", async () => {
		api.startNativeWindowsRecording.mockRejectedValue(new Error("Permission denied"));
		const view = renderHook(() => useScreenRecorder());

		await act(async () => {
			await view.result.current.startRecordingImmediately();
		});

		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("recording.permissionDenied");
	});
});

describe("useScreenRecorder native Windows stop failure", () => {
	/**
	 * Issue #252's second symptom. When the helper wedges, the main process
	 * releases its handle in a `finally` regardless, so a renderer that kept its
	 * own handle left the HUD showing a stop button that could only ever send a
	 * second stop -- answered with "Native Windows capture is not running."
	 */
	it("leaves the recorder able to start again after a failed stop", async () => {
		api.stopNativeWindowsRecording.mockResolvedValue({
			success: false,
			reason: "stop-timeout",
			error: "Timed out waiting for native Windows capture to stop.",
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await pressStop(view);

		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not finish Stop or open review. Reopen Klippt, then check Recordings.",
			{ description: "Timed out waiting for native Windows capture to stop." },
		);
		expect(view.result.current.saving).toBe(false);
		// The failure must not be mistaken for a successful recording.
		expect(api.switchToEditor).not.toHaveBeenCalled();

		// The next press starts a NEW recording instead of re-sending a stop.
		api.stopNativeWindowsRecording.mockClear();
		await startNativeRecording(view);

		expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(2);
		expect(api.stopNativeWindowsRecording).not.toHaveBeenCalled();
	});

	it("leaves the recorder able to start again when the stop IPC throws", async () => {
		api.stopNativeWindowsRecording.mockRejectedValue(new Error("IPC channel closed"));

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await pressStop(view);

		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not finish Stop or open review. Reopen Klippt, then check Recordings.",
			{ description: "IPC channel closed" },
		);
		expect(api.switchToEditor).not.toHaveBeenCalled();
	});

	it("still opens the editor when the stop succeeds", async () => {
		api.stopNativeWindowsRecording.mockResolvedValue({
			success: true,
			path: "C:\\rec\\a.mp4",
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await pressStop(view);

		expect(api.switchToEditor).toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
	});

	it("localizes native Windows Pause and Continue failures", async () => {
		const pause = vi.fn();
		const resume = vi.fn();
		stubElectronAPI({
			pauseNativeWindowsRecording: pause,
			resumeNativeWindowsRecording: resume,
		});
		pause.mockImplementationOnce(async () => ({ success: false, error: "Windows pause failed" }));
		pause.mockResolvedValue({ success: true });
		resume.mockResolvedValue({ success: false, error: "Windows continue failed" });
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(toast.error).toHaveBeenCalledWith(
			"Could not pause and save this clip. Press Stop, then check Recordings.",
			{ description: "Windows pause failed" },
		);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(true);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(resume).toHaveBeenCalledOnce();
		expect(toast.error).toHaveBeenCalledWith(
			"Could not continue recording. Press Stop, then check Recordings.",
			{ description: "Windows continue failed" },
		);
	});
});

describe("useScreenRecorder native Linux stop failure", () => {
	function stubNativeLinux(overrides: Record<string, unknown> = {}) {
		stubElectronAPI({
			getPlatform: vi.fn(() => "linux"),
			isNativeLinuxCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
			prepareNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
			cancelNativeLinuxPrepare: vi.fn(async () => ({ success: true })),
			startNativeMacRecording: vi.fn(async () => ({
				success: true,
				recordingId: 7,
				rendererStop: { recordingId: 7, token: "take-generation" },
			})),
			stopNativeMacRecording: vi.fn(async () => ({ success: true })),
			...overrides,
		});
	}

	async function startLinuxRecording(view: RecorderView) {
		await act(async () => {
			await view.result.current.startRecordingImmediately();
		});
		expect(view.result.current.recording).toBe(true);
	}

	it("finishes Linux startup while the hidden pill receives no animation frames", async () => {
		stubNativeLinux();
		vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
		const view = renderHook(() => useScreenRecorder());
		await settle();
		act(() => view.result.current.toggleRecording());
		await settle(20);
		expect(window.electronAPI.getPlatform()).toBe("linux");
		expect(view.result.current.recording).toBe(true);
		expect(view.result.current.starting).toBe(false);
		expect(window.requestAnimationFrame).not.toHaveBeenCalled();
		view.unmount();
	});

	it("keeps Linux capture isolation armed after a successful normal Record", async () => {
		const cancel = vi.fn(async () => ({ success: true }));
		stubNativeLinux({ cancelNativeLinuxPrepare: cancel });
		const view = renderHook(() => useScreenRecorder());
		act(() => view.result.current.toggleRecording());
		await settle(20);
		expect(view.result.current.recording).toBe(true);
		expect(cancel).not.toHaveBeenCalled();
	});
	it("chooses a fresh source while idle without recording or opening audio, then releases preparation", async () => {
		const prepare = vi.fn(async () => ({ success: true, recordingId: 7 }));
		const stop = vi.fn(async () => ({ success: true }));
		stubNativeLinux({ prepareNativeLinuxRecording: prepare, stopNativeMacRecording: stop });
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await expect(view.result.current.chooseRecordingSource()).resolves.toEqual({ success: true });
		});
		expect(prepare).toHaveBeenCalledWith(
			expect.objectContaining({
				source: expect.objectContaining({ sourceId: "portal:choose" }),
				audio: {
					system: { enabled: false },
					microphone: expect.objectContaining({ enabled: false }),
				},
				webcam: expect.objectContaining({ enabled: false }),
			}),
		);
		expect(stop).toHaveBeenCalledWith(true);
		expect(window.electronAPI.startNativeMacRecording).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
		expect(view.result.current.starting).toBe(false);
	});

	it("a Studio start-only request cannot cancel an idle Linux source preparation", async () => {
		let resolveChoice: (result: { success: false; error: string }) => void = () => undefined;
		const prepare = vi.fn(
			() =>
				new Promise<{ success: false; error: string }>((resolve) => {
					resolveChoice = resolve;
				}),
		);
		const cancel = vi.fn(async () => ({ success: true }));
		stubNativeLinux({ prepareNativeLinuxRecording: prepare, cancelNativeLinuxPrepare: cancel });
		const progress = vi.fn();
		window.electronAPI.traceRecordRequest = progress;
		const view = renderHook(() => useScreenRecorder());
		let choosing: Promise<unknown> | undefined;
		act(() => {
			choosing = view.result.current.chooseRecordingSource();
		});
		receiveRecordRequest(9003);
		act(() => view.result.current.startRecordingFromRequest());
		await settle();
		expect(cancel).not.toHaveBeenCalled();
		expect(window.electronAPI.startNativeMacRecording).not.toHaveBeenCalled();
		expect(progress).toHaveBeenCalledWith(
			expect.objectContaining({
				token: 9003,
				stage: "hook-entry",
				flags: expect.objectContaining({ sourceSelectionInFlight: true }),
			}),
		);
		await act(async () => {
			resolveChoice({ success: false, error: "The screen capture request was cancelled." });
			await choosing;
		});
	});

	it("blocks Record and duplicate source choices while the idle picker is pending, and unlocks after cancellation", async () => {
		let cancel: ((result: { success: false; error: string }) => void) | undefined;
		const prepare = vi.fn(
			() =>
				new Promise<{ success: false; error: string }>((resolve) => {
					cancel = resolve;
				}),
		);
		stubNativeLinux({ prepareNativeLinuxRecording: prepare });
		const view = renderHook(() => useScreenRecorder());
		let choosing: Promise<unknown> | undefined;
		act(() => {
			choosing = view.result.current.chooseRecordingSource();
		});
		expect(view.result.current.starting).toBe(true);
		await act(async () => {
			await view.result.current.startRecordingImmediately();
			view.result.current.toggleRecording();
			await expect(view.result.current.chooseRecordingSource()).resolves.toMatchObject({
				success: false,
			});
		});
		expect(prepare).toHaveBeenCalledOnce();
		await act(async () => {
			cancel?.({ success: false, error: "The screen capture request was cancelled." });
			await expect(choosing).resolves.toMatchObject({ success: false, cancelled: true });
		});
		expect(window.electronAPI.startNativeMacRecording).not.toHaveBeenCalled();
		expect(view.result.current.starting).toBe(false);
	});

	it("cancels idle source preparation through the primary Cancel control without starting a take", async () => {
		let rejectChoice: ((result: { success: false; error: string }) => void) | undefined;
		const prepare = vi.fn(
			() =>
				new Promise<{ success: false; error: string }>((resolve) => {
					rejectChoice = resolve;
				}),
		);
		const cancel = vi.fn(async () => {
			rejectChoice?.({ success: false, error: "Native capture exited before source selection." });
			return { success: true };
		});
		stubNativeLinux({ prepareNativeLinuxRecording: prepare, cancelNativeLinuxPrepare: cancel });
		const view = renderHook(() => useScreenRecorder());
		let choosing: Promise<unknown> | undefined;
		act(() => {
			choosing = view.result.current.chooseRecordingSource();
		});
		await act(async () => {
			view.result.current.toggleRecording();
			await expect(choosing).resolves.toMatchObject({ success: false, cancelled: true });
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(view.result.current.starting).toBe(false);
		expect(window.electronAPI.startNativeMacRecording).not.toHaveBeenCalled();
	});

	it("offers retry guidance for an acknowledged paused Continue rejection", async () => {
		const stop = vi.fn(async () => ({ success: true }));
		const resume = vi
			.fn()
			.mockResolvedValueOnce({ success: false, paused: true, error: "Microphone unavailable" })
			.mockResolvedValueOnce({ success: true, clipIndex: 1 });
		stubNativeLinux({
			pauseNativeMacRecording: vi.fn(async () => ({ success: true, paused: true })),
			resumeNativeMacRecording: resume,
			stopNativeMacRecording: stop,
		});
		const view = renderHook(() => useScreenRecorder());
		await startLinuxRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(true);
		expect(view.result.current.recording).toBe(true);
		expect(toast.error).toHaveBeenCalledWith(
			"Still paused. Check settings and try Continue again.",
			{ description: "Microphone unavailable" },
		);
		expect(stop).not.toHaveBeenCalled();
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(resume).toHaveBeenCalledTimes(2);
		expect(view.result.current.paused).toBe(false);
		await pressStop(view);
	});

	it("keeps a source-choice rejection paused and Continue retryable", async () => {
		const choose = vi.fn(async () => ({ success: false, error: "The picker was cancelled." }));
		stubNativeLinux({
			selectNativeLinuxSource: choose,
			pauseNativeMacRecording: vi.fn(async () => ({ success: true, paused: true })),
			resumeNativeMacRecording: vi.fn(async () => ({ success: true, clipIndex: 1 })),
		});
		const view = renderHook(() => useScreenRecorder());
		await startLinuxRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		await act(async () => {
			await expect(
				view.result.current.selectRecordingSource("editable-overlay"),
			).resolves.toMatchObject({
				success: false,
			});
		});
		expect(choose).toHaveBeenCalledWith(
			{ recordingId: 7, token: "take-generation" },
			"editable-overlay",
		);
		expect(view.result.current.paused).toBe(true);
		expect(view.result.current.recording).toBe(true);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(false);
		await pressStop(view);
	});

	it("never falls back to browser capture when the Linux helper is missing", async () => {
		const start = vi.fn();
		stubNativeLinux({
			isNativeLinuxCaptureAvailable: vi.fn(async () => ({
				success: true,
				available: false,
				reason: "missing-helper",
			})),
			startNativeMacRecording: start,
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => view.result.current.startRecordingImmediately());
		expect(view.result.current.recording).toBe(false);
		expect(start).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(expect.any(String), {
			description: "Native capture helper is not available.",
		});
	});

	it("waits for portal consent before start and sends Linux quality without native camera ownership", async () => {
		let select: ((result: { success: boolean; recordingId: number }) => void) | undefined;
		const prepare = vi.fn(
			() =>
				new Promise<{ success: boolean; recordingId: number }>((resolve) => {
					select = resolve;
				}),
		);
		const start = vi.fn(async () => ({ success: true, recordingId: 7 }));
		stubNativeLinux({
			getSelectedSource: vi.fn(async () => null),
			prepareNativeLinuxRecording: prepare,
			startNativeMacRecording: start,
		});
		const view = renderHook(() => useScreenRecorder());
		act(() => view.result.current.toggleRecording());
		await settle(60_000);
		expect(prepare).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
		await act(async () => select?.({ success: true, recordingId: 7 }));
		await settle(20);
		expect(view.result.current.recording).toBe(true);
		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({
				platform: "linux",
				recordingId: 7,
				video: expect.objectContaining({
					quality: "high",
					bitrate: 136_000_000,
					fps: 60,
					hideSystemCursor: false,
				}),
				webcam: expect.objectContaining({ enabled: false }),
			}),
		);
	});

	it("cancels a pending portal picker immediately when Record is cancelled", async () => {
		let finish: ((result: { success: boolean; error: string }) => void) | undefined;
		const prepare = vi.fn(
			() =>
				new Promise<{ success: boolean; error: string }>((resolve) => {
					finish = resolve;
				}),
		);
		const cancel = vi.fn(async () => {
			finish?.({ success: false, error: "Source selection cancelled." });
			return { success: true };
		});
		const start = vi.fn();
		stubNativeLinux({
			prepareNativeLinuxRecording: prepare,
			cancelNativeLinuxPrepare: cancel,
			startNativeMacRecording: start,
		});
		const view = renderHook(() => useScreenRecorder());
		act(() => view.result.current.toggleRecording());
		await settle();
		expect(prepare).toHaveBeenCalledOnce();
		act(() => view.result.current.toggleRecording());
		await settle();
		expect(cancel).toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
	});

	it("uses the same clip controls for Linux Pause, Backspace, Undo, and Continue without another portal", async () => {
		const clip = { index: 0, screenVideoPath: "/tmp/recording-7-clip-0001.mp4", durationMs: 2_000 };
		const prepare = vi.fn(async () => ({ success: true, recordingId: 7 }));
		const resume = vi.fn(async () => ({ success: true, clipIndex: 1 }));
		stubNativeLinux({
			getSelectedSource: vi.fn(async () => null),
			prepareNativeLinuxRecording: prepare,
			pauseNativeMacRecording: vi.fn(async () => ({ success: true, paused: true, clip })),
			removePreviousNativeMacClip: vi.fn(async () => ({ success: true, clip })),
			restoreRemovedNativeMacClip: vi.fn(async () => ({ success: true, clip })),
			resumeNativeMacRecording: resume,
		});
		const view = renderHook(() => useScreenRecorder());
		await startLinuxRecording(view);
		await settle(2_000);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.recordedClips).toEqual([clip]);
		expect(view.result.current.canRemovePreviousClip).toBe(true);
		await act(async () => {
			await view.result.current.removePreviousClip();
		});
		await settle();
		expect(view.result.current.recordedClips).toEqual([]);
		expect(view.result.current.elapsedSeconds).toBe(0);
		await act(async () => {
			await view.result.current.restoreRemovedClip(0);
		});
		await settle();
		expect(view.result.current.elapsedSeconds).toBe(2);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(false);
		expect(resume).toHaveBeenCalledWith(
			expect.objectContaining({
				platform: "linux",
				webcam: expect.objectContaining({ enabled: false }),
			}),
		);
		expect(prepare).toHaveBeenCalledOnce();
	});

	it.each([
		"app-stop",
		"ordinary-stop",
		"ordinary-stop-then-quit",
	])("acknowledges %s only after camera drain and durable attachment", async (action) => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => fakeWebcamStream({ width: 1920, height: 1080, fps: 30 })),
			},
		});
		const clip = { index: 0, screenVideoPath: "/tmp/recording-7-clip-0001.mp4", durationMs: 1_000 };
		const session: RecordingSession = {
			schemaVersion: 2,
			createdAt: 7,
			screenVideoPath: clip.screenVideoPath,
			clips: [clip],
		};
		const attached: RecordingSession = {
			...session,
			clips: [
				{ ...clip, webcamVideoPath: "/tmp/recording-7-clip-0001-webcam.webm", webcamOffsetMs: 0 },
			],
		};
		let appStop: ((request: NativeRecordingAppStopRequest) => void) | undefined;
		let finishAttachment:
			| ((result: { success: boolean; session: RecordingSession }) => void)
			| undefined;
		const attach = vi.fn(
			() =>
				new Promise<{ success: boolean; session: RecordingSession }>((resolve) => {
					finishAttachment = resolve;
				}),
		);
		const acknowledge = vi.fn(async () => {
			expect(window.electronAPI.setCurrentRecordingSession).toHaveBeenLastCalledWith(attached);
			return { success: true };
		});
		stubNativeLinux({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			openRecordingStream: vi.fn(async () => ({ success: true })),
			appendRecordingChunk: vi.fn(async () => ({ success: true })),
			closeRecordingStream: vi.fn(async () => ({ success: true })),
			onNativeMacRecordingStoppedByApp: vi.fn((callback) => {
				appStop = callback;
				return vi.fn();
			}),
			acknowledgeNativeRecordingAppStop: acknowledge,
			attachNativeMacClipWebcams: attach,
			stopNativeMacRecording: vi.fn(async () => ({
				success: true,
				path: clip.screenVideoPath,
				session,
			})),
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		await startLinuxRecording(view);
		const recorder = FakeMediaRecorder.instances[0];
		if (!recorder?.onstop) throw new Error("Camera recorder did not start");
		const finishDrain = recorder.onstop;
		recorder.onstop = null;
		if (action === "app-stop") act(() => appStop?.({ recordingId: 7, token: "take-generation" }));
		else act(() => view.result.current.toggleRecording());
		await settle();
		expect(window.electronAPI.stopNativeMacRecording).toHaveBeenCalledOnce();
		if (action === "ordinary-stop-then-quit") {
			act(() => appStop?.({ recordingId: 7, token: "take-generation" }));
			await settle();
			expect(window.electronAPI.stopNativeMacRecording).toHaveBeenCalledOnce();
			expect(FakeMediaRecorder.instances).toHaveLength(1);
		}
		expect(recorder.state).toBe("inactive");
		expect(attach).not.toHaveBeenCalled();
		expect(acknowledge).not.toHaveBeenCalled();
		expect(window.electronAPI.switchToEditor).not.toHaveBeenCalled();
		await act(async () => finishDrain());
		await settle();
		expect(attach).toHaveBeenCalledOnce();
		expect(acknowledge).not.toHaveBeenCalled();
		await act(async () => finishAttachment?.({ success: true, session: attached }));
		await settle();
		expect(acknowledge).toHaveBeenCalledOnce();
		expect(acknowledge).toHaveBeenCalledWith({
			recordingId: 7,
			token: "take-generation",
			success: true,
		});
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledOnce();
	});

	it("completes a bound take when the helper fails before the renderer receives its start result", async () => {
		let failure: ((value: { code: string; message: string }) => void) | undefined;
		const acknowledge = vi.fn(async () => ({ success: true }));
		const stop = vi.fn(async () => ({ success: true }));
		stubNativeLinux({
			onNativeMacRecordingError: vi.fn((callback) => {
				failure = callback;
				return vi.fn();
			}),
			acknowledgeNativeRecordingAppStop: acknowledge,
			stopNativeMacRecording: stop,
			startNativeMacRecording: vi.fn(async () => {
				failure?.({ code: "capture-helper-exited", message: "Helper exited during startup" });
				return {
					success: true,
					recordingId: 7,
					rendererStop: { recordingId: 7, token: "take-generation" },
				};
			}),
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => view.result.current.startRecordingImmediately());
		expect(stop).toHaveBeenCalledWith(false);
		expect(acknowledge).toHaveBeenCalledWith({
			recordingId: 7,
			token: "take-generation",
			success: false,
			error: "Helper exited during startup",
		});
		expect(view.result.current.recording).toBe(false);
	});

	it("reports a failed renderer handoff instead of acknowledging camera durability", async () => {
		let appStop: ((request: NativeRecordingAppStopRequest) => void) | undefined;
		const acknowledge = vi.fn(async () => ({ success: true }));
		stubNativeLinux({
			onNativeMacRecordingStoppedByApp: vi.fn((callback) => {
				appStop = callback;
				return vi.fn();
			}),
			acknowledgeNativeRecordingAppStop: acknowledge,
			stopNativeMacRecording: vi.fn(async () => ({
				success: false,
				error: "The camera handoff could not be saved",
			})),
		});
		const view = renderHook(() => useScreenRecorder());
		await startLinuxRecording(view);
		act(() => appStop?.({ recordingId: 7, token: "take-generation" }));
		await settle();
		expect(acknowledge).toHaveBeenCalledWith({
			recordingId: 7,
			token: "take-generation",
			success: false,
			error: "The camera handoff could not be saved",
		});
		expect(window.electronAPI.switchToEditor).not.toHaveBeenCalled();
	});

	it("opens review when Stop races Pause with the same renderer camera pending", async () => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => fakeWebcamStream({ width: 1920, height: 1080, fps: 30 })),
			},
		});
		const clip = { index: 0, screenVideoPath: "/tmp/recording-7-clip-0001.mp4", durationMs: 500 };
		let finishPause:
			| ((result: { success: boolean; paused: boolean; clip: RecordingSessionClip }) => void)
			| undefined;
		stubNativeLinux({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			pauseNativeMacRecording: vi.fn(
				() =>
					new Promise((resolve) => {
						finishPause = resolve;
					}),
			),
			stopNativeMacRecording: vi.fn(async () => ({
				success: true,
				path: clip.screenVideoPath,
				session: {
					schemaVersion: 2,
					createdAt: 7,
					screenVideoPath: clip.screenVideoPath,
					clips: [clip],
				},
			})),
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		await startLinuxRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.clipFinalizing).toBe(true);
		expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
		await pressStop(view);
		expect(window.electronAPI.stopNativeMacRecording).not.toHaveBeenCalled();
		expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
		await act(async () => finishPause?.({ success: true, paused: true, clip }));
		await settle();
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledWith({ compactReview: true });
		expect(view.result.current.recording).toBe(false);
	});

	it.each([
		"pause",
		"stop",
	])("keeps Linux camera footage after a rejected Pause through a later %s", async (nextAction) => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => fakeWebcamStream({ width: 1920, height: 1080, fps: 30 })),
			},
		});
		const clip = { index: 0, screenVideoPath: "/tmp/recording-7-clip-0001.mp4", durationMs: 1_000 };
		const session = {
			schemaVersion: 2,
			createdAt: 7,
			screenVideoPath: clip.screenVideoPath,
			clips: [clip],
		};
		const append = vi.fn(async () => ({ success: true }));
		const close = vi.fn(async () => ({ success: true }));
		const attach = vi.fn(async () => ({ success: true, session }));
		const pause = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				paused: false,
				error: "Pause command failed before pausing",
			})
			.mockResolvedValue({ success: true, paused: true, clip });
		stubNativeLinux({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			registerNativeRecordingWebcam: vi.fn(async () => ({ success: true, registered: true })),
			openRecordingStream: vi.fn(async () => ({ success: true })),
			appendRecordingChunk: append,
			closeRecordingStream: close,
			pauseNativeMacRecording: pause,
			attachNativeMacClipWebcams: attach,
			stopNativeMacRecording: vi.fn(async () => ({
				success: true,
				path: clip.screenVideoPath,
				session,
			})),
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		await startLinuxRecording(view);
		const recorder = FakeMediaRecorder.instances[0];
		if (!recorder?.ondataavailable) throw new Error("Camera recorder was not created");
		expect(recorder.options).toMatchObject({
			mimeType: "video/mp4;codecs=avc1",
			videoKeyFrameIntervalDuration: 500,
		});
		const before = new Uint8Array([1, 2, 3]).buffer;
		Reflect.apply(recorder.ondataavailable, recorder, [
			{ data: { size: before.byteLength, arrayBuffer: async () => before } },
		]);
		await settle();
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.recording).toBe(true);
		expect(view.result.current.paused).toBe(false);
		expect(recorder.state).toBe("recording");
		expect(close).not.toHaveBeenCalled();
		const after = new Uint8Array([4, 5, 6]).buffer;
		Reflect.apply(recorder.ondataavailable, recorder, [
			{ data: { size: after.byteLength, arrayBuffer: async () => after } },
		]);
		await settle();
		expect(append).toHaveBeenNthCalledWith(1, "recording-7-clip-0001-webcam.mp4", before);
		expect(append).toHaveBeenNthCalledWith(2, "recording-7-clip-0001-webcam.mp4", after);
		if (nextAction === "pause") {
			await act(async () => view.result.current.togglePaused());
			await settle();
			expect(view.result.current.paused).toBe(true);
			expect(recorder.state).toBe("inactive");
		}
		await pressStop(view);
		expect(attach).toHaveBeenCalledOnce();
		expect(attach).toHaveBeenCalledWith(
			expect.objectContaining({
				webcams: [
					expect.objectContaining({
						clipIndex: 0,
						webcam: expect.objectContaining({ fileName: "recording-7-clip-0001-webcam.mp4" }),
					}),
				],
			}),
		);
		expect(close).not.toHaveBeenCalled();
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledWith({ compactReview: true });
	});

	it("creates a separate renderer webcam recorder for each Linux clip", async () => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => fakeWebcamStream({ width: 1920, height: 1080, fps: 30 })),
			},
		});
		stubNativeLinux({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			pauseNativeMacRecording: vi.fn(async () => ({
				success: true,
				paused: true,
				clip: { index: 0, screenVideoPath: "/tmp/recording-7-clip-0001.mp4", durationMs: 500 },
			})),
			resumeNativeMacRecording: vi.fn(async () => ({ success: true, clipIndex: 1 })),
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		await startLinuxRecording(view);
		expect(FakeMediaRecorder.instances).toHaveLength(1);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive");
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(FakeMediaRecorder.instances).toHaveLength(2);
		expect(FakeMediaRecorder.instances[1]?.state).toBe("recording");
	});

	it("shows Stop guidance without opening review when native Stop reports failure", async () => {
		stubNativeLinux({
			stopNativeMacRecording: vi.fn(async () => ({
				success: false,
				error: "Stop command failed",
			})),
		});
		const view = renderHook(() => useScreenRecorder());
		await startLinuxRecording(view);
		await pressStop(view);

		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not finish Stop or open review. Reopen Klippt, then check Recordings.",
			{ description: "Stop command failed" },
		);
		expect(window.electronAPI.switchToEditor).not.toHaveBeenCalled();
	});

	it("shows Stop guidance with the IPC detail when native Stop throws", async () => {
		stubNativeLinux({
			stopNativeMacRecording: vi.fn(async () => {
				throw new Error("IPC channel closed");
			}),
		});
		const view = renderHook(() => useScreenRecorder());
		await startLinuxRecording(view);
		await pressStop(view);

		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not finish Stop or open review. Reopen Klippt, then check Recordings.",
			{ description: "IPC channel closed" },
		);
		expect(window.electronAPI.switchToEditor).not.toHaveBeenCalled();
	});

	it("localizes native Linux Pause and Continue failures", async () => {
		const pause = vi.fn();
		const resume = vi.fn();
		stubNativeLinux({
			pauseNativeMacRecording: pause,
			resumeNativeMacRecording: resume,
		});
		pause.mockImplementationOnce(async () => ({ success: false, error: "Linux pause failed" }));
		pause.mockResolvedValue({ success: true });
		resume.mockResolvedValue({ success: false, error: "Linux continue failed" });
		const view = renderHook(() => useScreenRecorder());
		await startLinuxRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(toast.error).toHaveBeenCalledWith(
			"Could not pause and save this clip. Press Stop, then check Recordings.",
			{ description: "Linux pause failed" },
		);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(true);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(resume).toHaveBeenCalledOnce();
		expect(toast.error).toHaveBeenCalledWith(
			"Could not continue recording. Press Stop, then check Recordings.",
			{ description: "Linux continue failed" },
		);
	});
});

describe("useScreenRecorder native macOS clip recovery", () => {
	function stubNativeMac(overrides: Record<string, unknown> = {}) {
		stubElectronAPI({
			getPlatform: vi.fn(() => "darwin"),
			isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
			requestNativeMacCursorAccess: vi.fn(async () => ({ success: true, granted: true })),
			startNativeMacRecording: vi.fn(async () => ({
				success: true,
				recordingId: 7,
				rendererStop: { recordingId: 7, token: "take-generation" },
				path: "/tmp/recording-7-clip-0001.mp4",
			})),
			pauseNativeMacRecording: vi.fn(async () => ({ success: true, paused: true })),
			resumeNativeMacRecording: vi.fn(async () => ({ success: true, clipIndex: 1 })),
			removePreviousNativeMacClip: vi.fn(async () => ({ success: true })),
			restoreRemovedNativeMacClip: vi.fn(async () => ({ success: true })),
			stopNativeMacRecording: vi.fn(async () => ({
				success: true,
				path: "/tmp/recording-7-clip-0001.mp4",
				session: {
					schemaVersion: 2,
					createdAt: 7,
					screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
					clips: [
						{
							index: 0,
							screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
							durationMs: 1_000,
						},
					],
				},
			})),
			...overrides,
		});
	}

	it.each([false, true])("records with cursor access granted=%s", async (granted) => {
		vi.mocked(toast.warning).mockClear();
		stubNativeMac({
			getRecordingPrefs: vi.fn(async () => ({ cursorCaptureMode: "editable-overlay" })),
			requestNativeMacCursorAccess: vi.fn(async () => ({ granted, status: "not-determined" })),
		});
		const view = renderHook(() => useScreenRecorder());
		await settle();
		await startNativeRecording(view);
		expect(window.electronAPI.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				cursor: { mode: granted ? "editable-overlay" : "system" },
				video: expect.objectContaining({ hideSystemCursor: granted }),
			}),
		);
		if (granted) expect(toast.warning).not.toHaveBeenCalled();
		else
			expect(toast.warning).toHaveBeenCalledWith("recording.editableCursorOff", {
				action: expect.objectContaining({ label: "recording.allowEditableCursor" }),
			});
	});

	it("counts from the written frame even when the start reply is delayed", async () => {
		stubNativeMac({
			startNativeMacRecording: vi.fn(async () => ({
				success: true,
				recordingId: 7,
				startedAtMs: Date.now() - 20_000,
			})),
		});
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		expect(view.result.current.elapsedSeconds).toBe(20);
	});

	it("uses an ordinary captured cursor by default", async () => {
		const start = vi.fn(async () => ({ success: true, recordingId: 7 }));
		const cursorAccess = vi.fn(async () => ({ granted: true }));
		stubNativeMac({ startNativeMacRecording: start, requestNativeMacCursorAccess: cursorAccess });
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({
				cursor: { mode: "system" },
				video: expect.objectContaining({ hideSystemCursor: false }),
			}),
		);
		expect(cursorAccess).not.toHaveBeenCalled();
	});

	it("keeps native camera ownership out of the browser when startup fails", async () => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => fakeWebcamStream({ width: 1920, height: 1080, fps: 30 })),
			},
		});
		const close = vi.fn(async () => ({ success: true }));
		stubNativeMac({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			openRecordingStream: vi.fn(async () => ({ success: true })),
			appendRecordingChunk: vi.fn(async () => ({ success: true })),
			closeRecordingStream: close,
			startNativeMacRecording: vi.fn(async () => ({ success: false, error: "Capture failed" })),
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		act(() => view.result.current.toggleRecording());
		await settle();
		expect(view.result.current.recording).toBe(false);
		expect(FakeMediaRecorder.instances).toHaveLength(0);
		expect(close).not.toHaveBeenCalled();
	});

	it("cancels native camera ownership when startup is cancelled before confirmation", async () => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => fakeWebcamStream({ width: 1920, height: 1080, fps: 30 })),
			},
		});
		let confirmStart:
			| ((value: {
					success: true;
					recordingId: number;
					rendererStop: NativeRecordingAppStopRequest;
			  }) => void)
			| undefined;
		const close = vi.fn(async () => ({ success: true }));
		const stop = vi.fn(async () => ({ success: true }));
		const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
		const handoff = new RendererRecordingStop();
		const rendererStop = handoff.bind(owner, 7);
		const acknowledge = vi.fn(async (value: unknown) => ({
			success: handoff.acknowledge(owner, value),
		}));
		stubNativeMac({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			openRecordingStream: vi.fn(async () => ({ success: true })),
			appendRecordingChunk: vi.fn(async () => ({ success: true })),
			closeRecordingStream: close,
			stopNativeMacRecording: stop,
			acknowledgeNativeRecordingAppStop: acknowledge,
			startNativeMacRecording: vi.fn(
				() =>
					new Promise((resolve) => {
						confirmStart = resolve;
					}),
			),
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		act(() => view.result.current.toggleRecording());
		await settle();
		expect(view.result.current.starting).toBe(true);
		expect(FakeMediaRecorder.instances).toHaveLength(0);
		act(() => view.result.current.cancelRecording());
		confirmStart?.({
			success: true,
			recordingId: 7,
			rendererStop,
		});
		await settle();
		expect(stop).toHaveBeenCalledWith(true);
		expect(window.electronAPI.acknowledgeNativeRecordingAppStop).toHaveBeenCalledOnce();
		expect(window.electronAPI.acknowledgeNativeRecordingAppStop).toHaveBeenCalledWith({
			...rendererStop,
			success: true,
		});
		expect(handoff.pendingRecordingId()).toBeNull();
		expect(view.result.current.recording).toBe(false);
		expect(view.result.current.starting).toBe(false);
		expect(FakeMediaRecorder.instances).toHaveLength(0);
		expect(close).not.toHaveBeenCalled();
	});

	it("keeps the timer steady while Pause is still saving the clip", async () => {
		const clip = {
			index: 0,
			screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
			durationMs: 2_000,
		};
		const pausing: { finish?: (value: unknown) => void } = {};
		stubNativeMac({
			pauseNativeMacRecording: vi.fn(
				() =>
					new Promise((resolve) => {
						pausing.finish = resolve;
					}),
			),
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await settle(2_000);
		expect(view.result.current.elapsedSeconds).toBe(2);

		act(() => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(true);
		expect(view.result.current.elapsedSeconds).toBe(2);

		pausing.finish?.({ success: true, paused: true, clip });
		await settle();
		expect(view.result.current.elapsedSeconds).toBe(2);
	});

	it("ignores a second toggle while Pause is still saving the clip", async () => {
		const pausing: { finish?: (value: unknown) => void } = {};
		const resumeNativeMacRecording = vi.fn(async () => ({ success: true, clipIndex: 1 }));
		stubNativeMac({
			pauseNativeMacRecording: vi.fn(
				() =>
					new Promise((resolve) => {
						pausing.finish = resolve;
					}),
			),
			resumeNativeMacRecording,
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		act(() => {
			view.result.current.togglePaused();
			view.result.current.togglePaused();
		});
		pausing.finish?.({
			success: true,
			paused: true,
			clip: { index: 0, screenVideoPath: "/tmp/recording-7-clip-0001.mp4", durationMs: 1_000 },
		});
		await settle();
		expect(resumeNativeMacRecording).not.toHaveBeenCalled();
		expect(view.result.current.paused).toBe(true);
	});

	it("stops once with the saved clip when Stop follows Pause before the clip is saved", async () => {
		const clip = {
			index: 0,
			screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
			durationMs: 1_000,
		};
		const pausing: { finish?: (value: unknown) => void } = {};
		const stopNativeMacRecording = vi.fn(async () => ({
			success: true,
			path: clip.screenVideoPath,
			session: {
				schemaVersion: 2,
				createdAt: 7,
				screenVideoPath: clip.screenVideoPath,
				clips: [clip],
			},
		}));
		stubNativeMac({
			pauseNativeMacRecording: vi.fn(
				() =>
					new Promise((resolve) => {
						pausing.finish = resolve;
					}),
			),
			stopNativeMacRecording,
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		act(() => view.result.current.togglePaused());
		await settle();
		await pressStop(view);
		pausing.finish?.({ success: true, paused: true, clip });
		await settle(50);

		expect(stopNativeMacRecording).toHaveBeenCalledTimes(1);
		expect(view.result.current.recording).toBe(false);
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledTimes(1);
	});

	it("updates the kept duration when a removed clip is restored", async () => {
		const clip = {
			index: 0,
			screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
			durationMs: 2_000,
		};
		stubNativeMac({
			pauseNativeMacRecording: vi.fn(async () => ({ success: true, paused: true, clip })),
			removePreviousNativeMacClip: vi.fn(async () => ({ success: true, clip })),
			restoreRemovedNativeMacClip: vi.fn(async () => ({ success: true, clip })),
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await settle(2_000);
		expect(view.result.current.elapsedSeconds).toBe(2);

		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.elapsedSeconds).toBe(2);

		let removedClip: RecordingSessionClip | null = null;
		await act(async () => {
			removedClip = await view.result.current.removePreviousClip();
		});
		await settle();
		expect(removedClip).toEqual(clip);
		expect(view.result.current.elapsedSeconds).toBe(0);

		await act(async () => {
			await view.result.current.restoreRemovedClip(clip.index);
		});
		await settle();
		expect(view.result.current.elapsedSeconds).toBe(2);

		await act(async () => view.result.current.togglePaused());
		await settle(1_000);
		expect(view.result.current.elapsedSeconds).toBe(3);
	});

	it("finalizes without discarding when the recording window closes", async () => {
		stubNativeMac();
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		const stopNativeMacRecording = vi.mocked(window.electronAPI.stopNativeMacRecording);
		stopNativeMacRecording.mockClear();

		view.unmount();
		await settle();

		expect(stopNativeMacRecording).toHaveBeenCalledWith(false, expect.any(Number));
		expect(stopNativeMacRecording).not.toHaveBeenCalledWith(true, expect.anything());
	});

	it("shows Stop guidance without opening review when native Stop reports failure", async () => {
		stubNativeMac({
			stopNativeMacRecording: vi.fn(async () => ({ success: false, error: "Stop command failed" })),
		});
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await pressStop(view);

		expect(view.result.current.recording).toBe(false);
		expect(view.result.current.saving).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not finish Stop or open review. Reopen Klippt, then check Recordings.",
			{ description: "Stop command failed" },
		);
		expect(window.electronAPI.switchToEditor).not.toHaveBeenCalled();
	});

	it("shows Stop guidance with the IPC detail when native Stop throws", async () => {
		stubNativeMac({
			stopNativeMacRecording: vi.fn(async () => {
				throw new Error("IPC channel closed");
			}),
		});
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await pressStop(view);

		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not finish Stop or open review. Reopen Klippt, then check Recordings.",
			{ description: "IPC channel closed" },
		);
		expect(window.electronAPI.switchToEditor).not.toHaveBeenCalled();
	});

	it("rolls the HUD back to recording when Pause fails before the helper pauses", async () => {
		const pause = vi.fn(async () => ({
			success: false,
			paused: false,
			error: "Pause command failed",
		}));
		stubNativeMac({ pauseNativeMacRecording: pause });

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();

		expect(pause).toHaveBeenCalledOnce();
		expect(view.result.current.paused).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not pause and save this clip. Press Stop, then check Recordings.",
			{ description: "Pause command failed" },
		);
	});

	it("identifies Pause when its IPC rejects after the optimistic state change", async () => {
		const pause = vi.fn(async () => {
			throw new Error("IPC channel closed");
		});
		stubNativeMac({ pauseNativeMacRecording: pause });

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();

		expect(pause).toHaveBeenCalledOnce();
		expect(toast.error).toHaveBeenCalledWith(
			"Could not pause and save this clip. Press Stop, then check Recordings.",
			{ description: "IPC channel closed" },
		);
	});

	it("keeps the HUD paused and shows Continue guidance when Continue fails", async () => {
		const resume = vi.fn(async () => ({ success: false, error: "Continue command failed" }));
		stubNativeMac({ resumeNativeMacRecording: resume });

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(true);

		await act(async () => view.result.current.togglePaused());
		await settle();

		expect(resume).toHaveBeenCalledOnce();
		expect(view.result.current.paused).toBe(true);
		expect(toast.error).toHaveBeenCalledWith(
			"Could not continue recording. Press Stop, then check Recordings.",
			{ description: "Continue command failed" },
		);
		expect(window.electronAPI.stopNativeMacRecording).not.toHaveBeenCalled();
	});

	it("keeps the HUD paused and lets Continue start a new clip after finalization fails", async () => {
		const pause = vi.fn(async () => ({
			success: false,
			paused: true,
			error: "Clip finalization failed",
		}));
		const resume = vi.fn(async () => ({ success: true, clipIndex: 1 }));
		stubNativeMac({ pauseNativeMacRecording: pause, resumeNativeMacRecording: resume });

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(true);

		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(resume).toHaveBeenCalledOnce();
		expect(view.result.current.paused).toBe(false);
	});

	it("unlocks setup while paused and sends the latest setup before Continue", async () => {
		const resume = vi.fn(async () => ({ success: true, clipIndex: 1 }));
		stubNativeMac({ resumeNativeMacRecording: resume });

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		expect(view.result.current.canReconfigureWhilePaused).toBe(false);

		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(true);
		expect(view.result.current.canReconfigureWhilePaused).toBe(true);

		act(() => {
			view.result.current.setMicrophoneEnabled(true);
			view.result.current.setMicrophoneDeviceId("mic-id");
			view.result.current.setMicrophoneDeviceName("Studio Mic");
			view.result.current.setSystemAudioEnabled(true);
			view.result.current.setCursorCaptureMode("system");
		});
		await settle();
		expect(view.result.current.paused).toBe(true);
		api.getSelectedSource.mockResolvedValue({
			...SOURCE,
			id: "screen:2:0",
			display_id: "2",
		});

		await act(async () => view.result.current.togglePaused());
		await settle();

		expect(resume).toHaveBeenCalledWith(
			expect.objectContaining({
				source: expect.objectContaining({ sourceId: "screen:2:0", displayId: 2 }),
				audio: {
					system: { enabled: true },
					microphone: expect.objectContaining({
						enabled: true,
						deviceId: "mic-id",
						deviceName: "Studio Mic",
					}),
				},
				cursor: { mode: "system" },
			}),
		);
		expect(window.electronAPI.stopNativeMacRecording).not.toHaveBeenCalled();
		expect(view.result.current.paused).toBe(false);
		expect(view.result.current.canReconfigureWhilePaused).toBe(false);
	});

	it("records a separate camera file for each screen clip", async () => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		const cameraStreams = [
			fakeWebcamStream({ width: 1920, height: 1080, fps: 30 }),
			fakeWebcamStream({ width: 2560, height: 1440, fps: 30 }),
		];
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia: vi.fn(async () => cameraStreams.shift()) },
		});
		const clips = [
			{
				index: 0,
				screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
				webcamVideoPath: "/tmp/recording-7-clip-0001-webcam.mov",
				durationMs: 1_000,
			},
			{
				index: 1,
				screenVideoPath: "/tmp/recording-7-clip-0002.mp4",
				webcamVideoPath: "/tmp/recording-7-clip-0002-webcam.mov",
				durationMs: 800,
			},
		];
		const attach = vi.fn(async (payload) => ({
			success: true,
			path: clips[0].screenVideoPath,
			session: {
				schemaVersion: 2 as const,
				createdAt: 7,
				screenVideoPath: clips[0].screenVideoPath,
				clips: payload.clips,
			},
		}));
		stubNativeMac({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			openRecordingStream: vi.fn(async () => ({ success: true })),
			appendRecordingChunk: vi.fn(async () => ({ success: true })),
			closeRecordingStream: vi.fn(async () => ({ success: true })),
			pauseNativeMacRecording: vi.fn(async () => ({
				success: true,
				paused: true,
				clip: clips[0],
			})),
			stopNativeMacRecording: vi.fn(async () => ({
				success: true,
				path: clips[0].screenVideoPath,
				session: {
					schemaVersion: 2,
					createdAt: 7,
					screenVideoPath: clips[0].screenVideoPath,
					clips,
				},
			})),
			attachNativeMacClipWebcams: attach,
		});

		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		await startNativeRecording(view);

		await act(async () => view.result.current.togglePaused());
		await settle();
		act(() => view.result.current.setWebcamFormat({ width: 2560, height: 1440, fps: 30 }));
		await settle();
		await act(async () => view.result.current.togglePaused());
		await settle(800);
		await pressStop(view);

		expect(FakeMediaRecorder.instances).toHaveLength(0);
		expect(attach).not.toHaveBeenCalled();
		expect(window.electronAPI.setCurrentRecordingSession).toHaveBeenLastCalledWith(
			expect.objectContaining({ clips }),
		);
	});

	it("retries a transient camera constraint failure without turning the saved setting off", async () => {
		vi.mocked(toast.error).mockClear();
		const webcamStream = fakeWebcamStream({ width: 1920, height: 1080, fps: 30 });
		const getUserMedia = vi
			.fn()
			.mockRejectedValueOnce(new DOMException("Camera is still busy", "OverconstrainedError"))
			.mockResolvedValueOnce(webcamStream);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia },
		});
		stubNativeMac({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			setRecordingPrefs: vi.fn(async () => ({ success: true })),
		});

		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();

		expect(getUserMedia).toHaveBeenCalledOnce();
		expect(view.result.current.webcamEnabled).toBe(true);
		await settle(250);

		expect(getUserMedia).toHaveBeenCalledTimes(2);
		expect(view.result.current.webcamPreviewStream).toBe(webcamStream);
		expect(window.electronAPI.setRecordingPrefs).not.toHaveBeenCalledWith({ camEnabled: false });
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("falls back to an available camera when the saved device disappeared", async () => {
		vi.mocked(toast.error).mockClear();
		const webcamStream = fakeWebcamStream({
			width: 1920,
			height: 1080,
			fps: 30,
			deviceId: "replacement-camera",
		});
		const getUserMedia = vi
			.fn()
			.mockRejectedValueOnce(new DOMException("Saved camera is gone", "NotFoundError"))
			.mockResolvedValue(webcamStream);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia },
		});
		stubNativeMac({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			setRecordingPrefs: vi.fn(async () => ({ success: true })),
		});

		const view = renderHook(() => useScreenRecorder());
		act(() => view.result.current.setWebcamDeviceId("missing-camera"));
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();

		expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({
			video: { deviceId: { exact: "missing-camera" } },
		});
		expect(getUserMedia.mock.calls[1]?.[0]).not.toHaveProperty("video.deviceId");
		expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
			camDeviceId: "replacement-camera",
		});
		expect(window.electronAPI.setRecordingPrefs).not.toHaveBeenCalledWith({ camEnabled: false });
		expect(view.result.current.webcamEnabled).toBe(true);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("cancels Continue when Stop runs while the next camera is still loading", async () => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		let finishCameraAcquire: ((stream: MediaStream) => void) | undefined;
		const getUserMedia = vi
			.fn()
			.mockResolvedValueOnce(fakeWebcamStream({ width: 1920, height: 1080, fps: 30 }))
			.mockImplementationOnce(
				() =>
					new Promise<MediaStream>((resolve) => {
						finishCameraAcquire = resolve;
					}),
			);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia },
		});
		const firstClip = {
			index: 0,
			screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
			durationMs: 1_000,
		};
		const resume = vi.fn(async () => ({ success: true, clipIndex: 1 }));
		stubNativeMac({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			openRecordingStream: vi.fn(async () => ({ success: true })),
			appendRecordingChunk: vi.fn(async () => ({ success: true })),
			closeRecordingStream: vi.fn(async () => ({ success: true })),
			pauseNativeMacRecording: vi.fn(async () => ({
				success: true,
				paused: true,
				clip: firstClip,
			})),
			resumeNativeMacRecording: resume,
			stopNativeMacRecording: vi.fn(async () => ({
				success: true,
				path: firstClip.screenVideoPath,
				session: {
					schemaVersion: 2 as const,
					createdAt: 7,
					screenVideoPath: firstClip.screenVideoPath,
					clips: [firstClip],
				},
			})),
			attachNativeMacClipWebcams: vi.fn(async (payload) => ({
				success: true,
				path: firstClip.screenVideoPath,
				session: {
					schemaVersion: 2 as const,
					createdAt: 7,
					screenVideoPath: firstClip.screenVideoPath,
					clips: payload.clips,
				},
			})),
		});

		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		await startNativeRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		act(() => view.result.current.setWebcamFormat({ width: 2560, height: 1440, fps: 30 }));
		await settle();
		act(() => view.result.current.togglePaused());
		await settle();
		expect(resume).not.toHaveBeenCalled();

		await pressStop(view);
		finishCameraAcquire?.(fakeWebcamStream({ width: 2560, height: 1440, fps: 30 }));
		await settle(5_100);

		expect(resume).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledOnce();
	});

	it("gives Stop ownership of native originals while Continue IPC is pending", async () => {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => fakeWebcamStream({ width: 1920, height: 1080, fps: 30 })),
			},
		});
		let finishResume: ((result: { success: true; clipIndex: number }) => void) | undefined;
		const resume = vi.fn(
			() =>
				new Promise<{ success: true; clipIndex: number }>((resolve) => {
					finishResume = resolve;
				}),
		);
		const clips = [
			{
				index: 0,
				screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
				durationMs: 1_000,
			},
			{
				index: 1,
				screenVideoPath: "/tmp/recording-7-clip-0002.mp4",
				durationMs: 300,
			},
		];
		const attach = vi.fn(async (payload) => ({
			success: true,
			path: clips[0].screenVideoPath,
			session: {
				schemaVersion: 2 as const,
				createdAt: 7,
				screenVideoPath: clips[0].screenVideoPath,
				clips: payload.clips,
			},
		}));
		stubNativeMac({
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			openRecordingStream: vi.fn(async () => ({ success: true })),
			appendRecordingChunk: vi.fn(async () => ({ success: true })),
			closeRecordingStream: vi.fn(async () => ({ success: true })),
			pauseNativeMacRecording: vi.fn(async () => ({
				success: true,
				paused: true,
				clip: clips[0],
			})),
			resumeNativeMacRecording: resume,
			stopNativeMacRecording: vi.fn(async () => ({
				success: true,
				path: clips[0].screenVideoPath,
				session: {
					schemaVersion: 2 as const,
					createdAt: 7,
					screenVideoPath: clips[0].screenVideoPath,
					clips,
				},
			})),
			attachNativeMacClipWebcams: attach,
		});

		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await settle();
		await startNativeRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		act(() => view.result.current.togglePaused());
		await settle();
		expect(resume).toHaveBeenCalledOnce();
		expect(FakeMediaRecorder.instances).toHaveLength(0);

		act(() => view.result.current.toggleRecording());
		await settle();
		finishResume?.({ success: true, clipIndex: 1 });
		await settle();

		expect(view.result.current.recording).toBe(false);
		expect(attach).not.toHaveBeenCalled();
		expect(window.electronAPI.setCurrentRecordingSession).toHaveBeenLastCalledWith(
			expect.objectContaining({ clips }),
		);
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledOnce();
	});

	it("stops counting and saves completed clips when the active writer fails", async () => {
		let failureListener: ((failure: { code: string; message: string }) => void) | undefined;
		const stop = vi.fn(async () => ({
			success: true,
			path: "/tmp/recording-7-clip-0001.mp4",
			session: {
				schemaVersion: 2 as const,
				createdAt: 7,
				screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
				clips: [
					{
						index: 0,
						screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
						durationMs: 1_000,
					},
				],
			},
		}));
		stubNativeMac({
			stopNativeMacRecording: stop,
			onNativeMacRecordingError: vi.fn((callback) => {
				failureListener = callback;
				return vi.fn();
			}),
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		expect(failureListener).toBeTypeOf("function");
		act(() => {
			failureListener?.({
				code: "writer-failed-during-capture",
				message: "The active clip failed.",
			});
		});
		await settle();

		expect(stop).toHaveBeenCalledOnce();
		expect(view.result.current.recording).toBe(false);
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledOnce();
		expect(toast.error).toHaveBeenCalledWith("The active clip failed. Saving completed clips now.");
		expect(window.electronAPI.acknowledgeNativeRecordingAppStop).toHaveBeenCalledWith({
			recordingId: 7,
			token: "take-generation",
			success: true,
		});
	});

	it("shows microphone fallback during startup and recording without pausing", async () => {
		let listener: ((reason: string) => void) | undefined;
		stubNativeMac({
			onNativeMacRecordingInterrupted: vi.fn((callback) => {
				listener = callback;
				return vi.fn();
			}),
		});
		const view = renderHook(() => useScreenRecorder());
		await settle();
		act(() => listener?.("microphone-defaulted"));
		expect(toast.warning).toHaveBeenCalledWith(
			"The selected microphone could not be found. Recording the system default microphone.",
		);
		await startNativeRecording(view);
		act(() => listener?.("microphone-defaulted"));
		await settle();
		expect(window.electronAPI.pauseNativeMacRecording).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(true);
	});

	it("pauses a live take when the screen locks and ignores a source that comes back", async () => {
		let interruptionListener: ((reason: string) => void) | undefined;
		stubNativeMac({
			onNativeMacRecordingInterrupted: vi.fn((callback) => {
				interruptionListener = callback;
				return vi.fn();
			}),
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		act(() => interruptionListener?.("source-active"));
		await settle();
		expect(window.electronAPI.pauseNativeMacRecording).not.toHaveBeenCalled();

		act(() => interruptionListener?.("screen-locked"));
		await settle();
		expect(window.electronAPI.pauseNativeMacRecording).toHaveBeenCalledOnce();
		expect(view.result.current.paused).toBe(true);
		expect(toast.warning).toHaveBeenCalledWith("The screen locked, so recording paused.");

		act(() => interruptionListener?.("system-sleep"));
		await settle();
		expect(window.electronAPI.pauseNativeMacRecording).toHaveBeenCalledOnce();
	});

	it("applies a terminal interruption that arrives while Continue is pending", async () => {
		let interruptionListener: ((reason: string) => void) | undefined;
		let finishResume: ((result: { success: true; clipIndex: number }) => void) | undefined;
		const resume = vi.fn(
			() =>
				new Promise<{ success: true; clipIndex: number }>((resolve) => {
					finishResume = resolve;
				}),
		);
		stubNativeMac({
			resumeNativeMacRecording: resume,
			onNativeMacRecordingInterrupted: vi.fn((callback) => {
				interruptionListener = callback;
				return vi.fn();
			}),
		});
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await act(async () => view.result.current.togglePaused());
		await settle();
		expect(view.result.current.paused).toBe(true);

		act(() => view.result.current.togglePaused());
		await settle();
		expect(resume).toHaveBeenCalledOnce();
		act(() => interruptionListener?.("screen-locked"));
		act(() => interruptionListener?.("source-active"));
		await settle();
		finishResume?.({ success: true, clipIndex: 1 });
		await settle();

		expect(window.electronAPI.pauseNativeMacRecording).toHaveBeenCalledTimes(2);
		expect(view.result.current.paused).toBe(true);
		expect(toast.warning).toHaveBeenCalledWith("The screen locked, so recording paused.");
	});

	it("tells the user how many minutes of disk space the take has left", async () => {
		let storageListener:
			| ((status: { freeBytes: number; minutesLeft: number | null }) => void)
			| undefined;
		stubNativeMac({
			onNativeMacRecordingStorageLow: vi.fn((callback) => {
				storageListener = callback;
				return vi.fn();
			}),
		});
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		act(() => storageListener?.({ freeBytes: 3e9, minutesLeft: 4.9 }));
		expect(toast.warning).toHaveBeenCalledWith("About 4 minutes of disk space left for this take.");
	});

	it("leaves the recording state and opens review when the app stopped the take itself", async () => {
		let appStopListener: ((request: NativeRecordingAppStopRequest) => void) | undefined;
		stubNativeMac({
			onNativeMacRecordingStoppedByApp: vi.fn((callback) => {
				appStopListener = callback;
				return vi.fn();
			}),
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		expect(appStopListener).toBeTypeOf("function");
		act(() => appStopListener?.({ recordingId: 7, token: "take-generation" }));
		await settle();

		expect(window.electronAPI.stopNativeMacRecording).toHaveBeenCalledOnce();
		expect(window.electronAPI.acknowledgeNativeRecordingAppStop).toHaveBeenCalledWith({
			recordingId: 7,
			token: "take-generation",
			success: true,
		});
		expect(view.result.current.recording).toBe(false);
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledOnce();
	});
});

describe("useScreenRecorder camera files after Stop", () => {
	const CAMERA = "recording-7-clip-0001-webcam.mp4";

	// These tests watch real file I/O, which fake timers cannot wait for.
	beforeEach(() => {
		vi.useRealTimers();
	});
	const flush = () =>
		act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
	const pressRealStop = async (view: RecorderView) => {
		act(() => view.result.current.toggleRecording());
		await flush();
	};

	/** Routes the renderer's stream API through the real IPC handlers and real files. */
	async function realCameraStreams() {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-camera-files-"));
		const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
		registerRecordingStreamHandlers(
			{
				handle: (channel: string, handler: (...args: never[]) => unknown) =>
					handlers.set(channel, handler as never),
			} as never,
			new RecordingStreamRegistry(),
			(fileName) => path.join(dir, fileName),
		);
		const invoke = (channel: string) =>
			vi.fn((...args: unknown[]) => handlers.get(channel)?.({}, ...args));
		return {
			cameraPath: path.join(dir, CAMERA),
			api: {
				openRecordingStream: invoke("open-recording-stream"),
				appendRecordingChunk: invoke("append-recording-chunk"),
				closeRecordingStream: invoke("close-recording-stream"),
				finalizeRecordingStream: invoke("finalize-recording-stream"),
			},
		};
	}

	async function recordCamera(overrides: Record<string, unknown>) {
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => fakeWebcamStream({ width: 1920, height: 1080, fps: 30 })),
			},
		});
		stubElectronAPI({
			getPlatform: vi.fn(() => "linux"),
			isNativeLinuxCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
			prepareNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
			startNativeMacRecording: vi.fn(async () => ({
				success: true,
				recordingId: 7,
				rendererStop: { recordingId: 7, token: "take-generation" },
			})),
			requestCameraAccess: vi.fn(async () => ({ success: true, granted: true })),
			registerNativeRecordingWebcam: vi.fn(async () => ({ success: true, registered: true })),
			...overrides,
		});
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await flush();
		await act(async () => {
			await view.result.current.startRecordingImmediately();
		});
		expect(view.result.current.recording).toBe(true);
		const recorder = FakeMediaRecorder.instances.at(-1);
		if (!recorder?.ondataavailable) throw new Error("Camera recorder was not created");
		const footage = new Uint8Array([1, 2, 3]).buffer;
		Reflect.apply(recorder.ondataavailable, recorder, [
			{ data: { size: footage.byteLength, arrayBuffer: async () => footage } },
		]);
		await flush();
		return { view, recorder };
	}

	const clip = {
		index: 0,
		screenVideoPath: "/tmp/recording-7-clip-0001.mp4",
		durationMs: 2_000,
	};
	const savedSession = (clips: RecordingSessionClip[]): RecordingSession => ({
		createdAt: 7,
		schemaVersion: 2,
		screenVideoPath: clip.screenVideoPath,
		clips,
	});
	const stopWith = (session: RecordingSession) =>
		vi.fn(async () => ({ success: true, path: clip.screenVideoPath, session }));

	it("keeps the camera file when attaching it to the saved session fails", async () => {
		const { api, cameraPath } = await realCameraStreams();
		const { view } = await recordCamera({
			...api,
			stopNativeMacRecording: stopWith(savedSession([clip])),
			attachNativeMacClipWebcams: vi.fn(async () => ({
				success: false,
				error: "ENOSPC: the manifest could not be written",
			})),
		});

		await pressRealStop(view);

		expect(window.electronAPI.attachNativeMacClipWebcams).toHaveBeenCalledOnce();
		expect([...(await readFile(cameraPath))]).toEqual([1, 2, 3]);
	});

	it("keeps the footage already on disk when a later camera write fails", async () => {
		const { api, cameraPath } = await realCameraStreams();
		const append = api.appendRecordingChunk;
		const { view, recorder } = await recordCamera({
			...api,
			stopNativeMacRecording: stopWith(savedSession([clip])),
			attachNativeMacClipWebcams: vi.fn(async () => ({ success: true })),
		});
		append.mockImplementationOnce(async () => ({ success: false, error: "EIO" }));
		const late = new Uint8Array([4]).buffer;
		Reflect.apply(recorder.ondataavailable as never, recorder, [
			{ data: { size: late.byteLength, arrayBuffer: async () => late } },
		]);
		await flush();

		await pressRealStop(view);

		expect(window.electronAPI.attachNativeMacClipWebcams).not.toHaveBeenCalled();
		expect([...(await readFile(cameraPath))]).toEqual([1, 2, 3]);
	});

	it("keeps the camera file of a removed clip", async () => {
		const { api, cameraPath } = await realCameraStreams();
		const { view } = await recordCamera({
			...api,
			stopNativeMacRecording: stopWith(savedSession([{ ...clip, removed: true }])),
		});

		await pressRealStop(view);

		expect([...(await readFile(cameraPath))]).toEqual([1, 2, 3]);
	});

	it("keeps the camera file for crash recovery when native Stop fails", async () => {
		const { api, cameraPath } = await realCameraStreams();
		const { view } = await recordCamera({
			...api,
			stopNativeMacRecording: vi.fn(async () => ({
				success: false,
				error: "ENOSPC: the manifest could not be written",
			})),
		});

		await pressRealStop(view);

		expect([...(await readFile(cameraPath))]).toEqual([1, 2, 3]);
	});

	it("still deletes the camera file when the owner discards the take", async () => {
		const { api, cameraPath } = await realCameraStreams();
		const { view } = await recordCamera({
			...api,
			stopNativeMacRecording: vi.fn(async () => ({ success: true, discarded: true })),
		});

		act(() => view.result.current.cancelRecording());
		await flush();

		await expect(readFile(cameraPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

it.each(["win32", "darwin", "linux"])("restarts the active native take on %s", async (platform) => {
	let id = 7;
	const start = vi.fn(async () => ({ success: true, recordingId: id++ }));
	stubElectronAPI({
		getPlatform: vi.fn(() => platform),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		isNativeLinuxCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		prepareNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: id })),
		startNativeWindowsRecording: start,
		startNativeMacRecording: start,
		stopNativeMacRecording: vi.fn(async () => ({ success: true, discarded: true })),
	});
	const view = renderHook(() => useScreenRecorder());
	await act(async () => {
		await view.result.current.startRecordingImmediately();
	});
	expect(view.result.current.recording).toBe(true);
	await act(async () => {
		await view.result.current.restartRecording();
	});
	await settle(20);
	expect(start).toHaveBeenCalledTimes(2);
	expect(view.result.current.recording).toBe(true);
});

it.each([
	"win32",
	"darwin",
	"linux",
])("retains start ownership while cancelled startup cleans up on %s", async (platform) => {
	let confirm: ((value: { success: boolean; recordingId: number }) => void) | undefined;
	const start = vi.fn(
		() =>
			new Promise<{ success: boolean; recordingId: number }>((resolve) => {
				confirm = resolve;
			}),
	);
	const stop = vi.fn(async () => ({ success: true, discarded: true }));
	stubElectronAPI({
		getPlatform: vi.fn(() => platform),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		isNativeLinuxCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		prepareNativeLinuxRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		cancelNativeLinuxPrepare: vi.fn(async () => undefined),
		startNativeWindowsRecording: start,
		startNativeMacRecording: start,
		stopNativeWindowsRecording: stop,
		stopNativeMacRecording: stop,
	});
	const view = renderHook(() => useScreenRecorder());
	let pending: Promise<void> | undefined;
	act(() => {
		pending = view.result.current.startRecordingImmediately();
	});
	await settle();
	expect(start).toHaveBeenCalledTimes(1);
	act(() => view.result.current.cancelRecording());
	await act(async () => view.result.current.startRecordingImmediately());
	expect(start).toHaveBeenCalledTimes(1);
	await act(async () => {
		confirm?.({ success: true, recordingId: 7 });
		await pending;
	});
	expect(stop).toHaveBeenCalledWith(true);
	expect(view.result.current.recording).toBe(false);
	await act(async () => {
		void view.result.current.startRecordingImmediately();
	});
	await settle();
	expect(start).toHaveBeenCalledTimes(2);
	await act(async () => {
		confirm?.({ success: true, recordingId: 8 });
	});
	expect(view.result.current.recording).toBe(true);
});

it("joins a pending Windows discard before Restart starts the replacement", async () => {
	let finish: ((value: { success: boolean; discarded: boolean }) => void) | undefined;
	api.stopNativeWindowsRecording.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const view = renderHook(() => useScreenRecorder());
	await act(async () => view.result.current.startRecordingImmediately());
	act(() => view.result.current.cancelRecording());
	await settle();
	let restart: Promise<unknown> | undefined;
	act(() => {
		restart = Promise.resolve(view.result.current.restartRecording());
	});
	await settle();
	expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(1);
	await act(async () => {
		finish?.({ success: true, discarded: true });
		await restart;
	});
	expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(2);
	expect(view.result.current.recording).toBe(true);
});

it.each([
	"pause",
	"resume",
])("queues Windows Stop behind an unacknowledged %s", async (operation) => {
	const pause = vi.fn(async () => ({ success: true }));
	const resume = vi.fn(async () => ({ success: true }));
	stubElectronAPI({ pauseNativeWindowsRecording: pause, resumeNativeWindowsRecording: resume });
	const view = renderHook(() => useScreenRecorder());
	await act(async () => view.result.current.startRecordingImmediately());
	if (operation === "resume") {
		act(() => view.result.current.togglePaused());
		await settle();
	}
	let acknowledge: ((value: { success: boolean }) => void) | undefined;
	(operation === "pause" ? pause : resume).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				acknowledge = resolve;
			}),
	);
	act(() => view.result.current.togglePaused());
	await settle();
	act(() => view.result.current.toggleRecording());
	await settle();
	expect(api.stopNativeWindowsRecording).not.toHaveBeenCalled();
	await act(async () => {
		acknowledge?.({ success: true });
	});
	await settle();
	expect(api.stopNativeWindowsRecording).toHaveBeenCalledTimes(1);
	expect(api.stopNativeWindowsRecording).toHaveBeenCalledWith(false);
	expect(view.result.current.recording).toBe(false);
});
