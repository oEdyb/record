// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return { useScopedT: () => translate };
});

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;
let originalMediaDevices: PropertyDescriptor | undefined;

class FakeMediaRecorder {
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

/** Drives the hook through the countdown and native start confirmation. */
async function startNativeRecording(view: RecorderView) {
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle(2_100);
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
	if (originalMediaDevices) {
		Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
	} else {
		Reflect.deleteProperty(navigator, "mediaDevices");
	}
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useScreenRecorder countdown timing", () => {
	it("starts capture on the final countdown value and keeps it visible until the timer is ready", async () => {
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
		await settle(2_000);

		expect(api.setCountdownOverlayValue).toHaveBeenLastCalledWith(1, expect.any(Number));
		expect(api.startNativeWindowsRecording).toHaveBeenCalledOnce();
		expect(api.hideCountdownOverlay).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);

		finishStart?.({ success: true, recordingId: 7 });
		await settle(20);

		expect(view.result.current.recording).toBe(true);
		expect(api.hideCountdownOverlay).toHaveBeenCalledOnce();
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
			"Timed out waiting for native Windows capture to stop.",
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
		expect(toast.error).toHaveBeenCalledWith("IPC channel closed");
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

		expect(stopNativeMacRecording).toHaveBeenCalledWith(false);
		expect(stopNativeMacRecording).not.toHaveBeenCalledWith(true);
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
		expect(toast.error).toHaveBeenCalledWith("Pause command failed");
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
				durationMs: 1_000,
			},
			{
				index: 1,
				screenVideoPath: "/tmp/recording-7-clip-0002.mp4",
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

		expect(FakeMediaRecorder.instances).toHaveLength(2);
		expect(attach).toHaveBeenCalledOnce();
		const webcams = attach.mock.calls[0]?.[0].webcams;
		expect(webcams).toHaveLength(2);
		expect(
			webcams.map((camera: { webcam: { fileName: string } }) => camera.webcam.fileName),
		).toEqual(["recording-7-clip-0001-webcam.webm", "recording-7-clip-0002-webcam.webm"]);
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

	it("gives Stop ownership of a camera recorder while Continue IPC is pending", async () => {
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
		expect(FakeMediaRecorder.instances).toHaveLength(2);

		act(() => view.result.current.toggleRecording());
		await settle();
		finishResume?.({ success: true, clipIndex: 1 });
		await settle();

		expect(view.result.current.recording).toBe(false);
		expect(attach).toHaveBeenCalledOnce();
		expect(attach.mock.calls[0]?.[0].webcams).toHaveLength(2);
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
	});
});
