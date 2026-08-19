// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { TooltipProvider } from "../ui/tooltip";
import { HUD_BAR_BOTTOM, HUD_POPOVER_GAP, HUD_POPOVER_MAX_HEIGHT } from "./hudGeometry";
import { LaunchWindow } from "./LaunchWindow";

type SelectedSourceChangedListener = Parameters<
	Window["electronAPI"]["onSelectedSourceChanged"]
>[0];

const platformState = vi.hoisted(() => ({ value: "darwin" }));
const linuxHelperAvailable = vi.hoisted(() => ({ value: true }));
const resizeCallbacks = vi.hoisted(() => [] as Array<ResizeObserverCallback>);

class StubResizeObserver {
	observe() {
		return undefined;
	}
	unobserve() {
		return undefined;
	}
	disconnect() {
		return undefined;
	}
}

class CapturingResizeObserver extends StubResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		super();
		resizeCallbacks.push(callback);
	}
}

const recorderState = vi.hoisted(() => ({
	value: {
		recording: false,
		paused: false,
		saving: false,
		clipFinalizing: false,
		elapsedSeconds: 0,
		activeClipElapsedMs: 0,
		recordedClips: [] as RecordingSessionClip[],
		toggleRecording: vi.fn(),
		togglePaused: vi.fn(),
		canPauseRecording: false,
		canReconfigureWhilePaused: false,
		canRemovePreviousClip: false,
		removePreviousClip: vi.fn(),
		restartRecording: vi.fn(),
		cancelRecording: vi.fn(),
		microphoneEnabled: false,
		setMicrophoneEnabled: vi.fn(),
		microphoneDeviceId: undefined,
		setMicrophoneDeviceId: vi.fn(),
		setMicrophoneDeviceName: vi.fn(),
		webcamEnabled: false,
		webcamPreviewStream: null as MediaStream | null,
		setWebcamEnabled: vi.fn(async () => true),
		webcamDeviceId: undefined,
		setWebcamDeviceId: vi.fn(),
		setWebcamDeviceName: vi.fn(),
		webcamFormat: { width: 1920, height: 1080, fps: 30 },
		setWebcamFormat: vi.fn(),
		systemAudioEnabled: false,
		setSystemAudioEnabled: vi.fn(),
		cursorCaptureMode: "editable-overlay",
		setCursorCaptureMode: vi.fn(),
		softwareEncoderFallbackNoticeVisible: false,
		dismissSoftwareEncoderFallbackNotice: vi.fn(),
	},
}));

let selectedSourceChangedListeners: SelectedSourceChangedListener[] = [];
let sourceSelectorClosedListeners: Array<() => void> = [];

vi.mock("../../hooks/useScreenRecorder", () => ({
	useScreenRecorder: () => recorderState.value,
}));

const micDevicesState = vi.hoisted(() => ({
	value: [] as Array<{ deviceId: string; label: string; groupId: string }>,
}));
const cameraDevicesState = vi.hoisted(() => ({
	value: [] as Array<{ deviceId: string; label: string; groupId: string }>,
}));

vi.mock("../../hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: () => ({
		devices: micDevicesState.value,
		selectedDeviceId: "default",
		setSelectedDeviceId: vi.fn(),
	}),
}));

vi.mock("../../hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({
		devices: cameraDevicesState.value,
		selectedDeviceId: cameraDevicesState.value[0]?.deviceId ?? "",
		setSelectedDeviceId: vi.fn(),
		isLoading: false,
		error: null,
	}),
}));

vi.mock("../../hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0 }),
}));

vi.mock("../../hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({
		stream: null,
		error: null,
		supportedFormats: [
			{ width: 3840, height: 2160, fps: 30 },
			{ width: 1920, height: 1080, fps: 30 },
		],
		activeFormat: recorderState.value.webcamFormat,
	}),
}));

vi.mock("../../lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
}));

vi.mock("@/native", () => ({
	nativeBridgeClient: {
		system: {
			getPlatform: vi.fn(async () => platformState.value),
		},
	},
}));

const i18nState = vi.hoisted(() => ({
	value: {
		locale: "en",
		setLocale: vi.fn(),
		systemLocaleSuggestion: null as string | null,
		acceptSystemLocaleSuggestion: vi.fn(),
		dismissSystemLocaleSuggestion: vi.fn(),
		resolveSystemLocaleSuggestion: vi.fn(),
	},
}));

vi.mock("@/i18n/loader", () => ({
	getAvailableLocales: () => ["en"],
	getLocaleName: () => "English",
}));

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => i18nState.value,
	useScopedT: () => (key: string) => {
		const translations: Record<string, string> = {
			"sourceSelector.defaultSourceName": "Screen",
			"recording.selectSource": "Please select a source to record",
			"recording.systemPicker": "Your system will ask what to share",
			"recording.inProgress": "Recording",
			"tooltips.useVerticalTray": "Use vertical tray",
			"tooltips.useHorizontalTray": "Use horizontal tray",
			"audio.enableSystemAudio": "Enable system audio",
			"audio.disableSystemAudio": "Disable system audio",
			"audio.enableMicrophone": "Enable microphone",
			"audio.disableMicrophone": "Disable microphone",
			"audio.defaultMicrophone": "Default Microphone",
			"webcam.enableWebcam": "Enable webcam",
			"webcam.disableWebcam": "Disable webcam",
			"webcam.defaultCamera": "Default Camera",
			"webcam.searching": "Searching...",
			"webcam.noneFound": "No camera found",
			"webcam.unavailable": "Camera unavailable",
			"deviceSettings.title": "Device settings",
			"deviceSettings.done": "Done",
			"deviceSettings.micLevel": "Input level",
			"deviceSettings.micHint": "Speak to check your microphone",
			"deviceSettings.noMicrophones": "No microphone found",
			"deviceSettings.cameraQuality": "Camera quality",
			"deviceSettings.preview": "Preview",
			"deviceSettings.previewUnavailable": "Preview unavailable",
			"audio.inputDevice": "Input device",
			"webcam.cameraDevice": "Camera device",
			"cursor.useEditableCursor": "Use editable cursor",
			"cursor.useSystemCursor": "Use system cursor",
			"tooltips.openStudio": "Open Studio",
			"tooltips.hideHUD": "Hide HUD",
			"tooltips.closeApp": "Close App",
			language: "Language",
			"systemLanguagePrompt.title": "Use your system language?",
			"systemLanguagePrompt.description":
				"We detected English as your system language. Do you want to switch OpenScreen to English?",
			"systemLanguagePrompt.keepDefault": "Keep current language",
			"systemLanguagePrompt.switch": "Switch to English",
			"softwareEncoderFallback.title": "Switched to software encoding",
			"softwareEncoderFallback.description":
				"The default GPU encoder failed to start, so OpenScreen fell back to software H.264 encoding. Recording should continue as normal, but CPU usage may be higher.",
			"softwareEncoderFallback.dismiss": "Got it",
			"softwareEncoderFallback.dontShowAgain": "Don't show again",
		};
		return translations[key] ?? key;
	},
}));

function renderLaunchWindow() {
	return render(
		<TooltipProvider>
			<LaunchWindow />
		</TooltipProvider>,
	);
}

function renderStrictLaunchWindow() {
	return render(
		<StrictMode>
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>
		</StrictMode>,
	);
}

function stubElectronAPI(getSelectedSource: Window["electronAPI"]["getSelectedSource"]) {
	window.electronAPI = {
		...window.electronAPI,
		getSelectedSource,
		openSourceSelector: vi.fn(async () => ({ opened: true })),
		requestScreenAccess: vi.fn(async () => ({
			success: true,
			granted: true,
			status: "granted",
		})),
		// Follows the platform under test. Pinned to "darwin" before, which was
		// invisible while only `nativeBridgeClient` was consulted for it — and
		// silently wrong the moment anything read the platform through here.
		getPlatform: vi.fn(() => platformState.value),
		// Only the Linux tests read this; the helper being present is what hands
		// source selection to the portal.
		isNativeLinuxCaptureAvailable: vi.fn(async () => ({
			success: true,
			available: linuxHelperAvailable.value,
		})),
		setRecordingPrefs: vi.fn(async (patch) => ({
			micEnabled: false,
			micDeviceId: null,
			camEnabled: false,
			camDeviceId: null,
			camFormat: { width: 1920, height: 1080, fps: 30 },
			systemAudioEnabled: false,
			cursorCaptureMode: "editable-overlay",
			...patch,
		})),
		setHudOverlaySize: vi.fn(),
		setHudDirectionExclusionRectangles: vi.fn(),
		requestCameraPreviewConnection: vi.fn(),
		setHudOverlayIgnoreMouseEvents: vi.fn(),
		beginHudOverlayDrag: vi.fn(),
		dragHudOverlayTo: vi.fn(),
		endHudOverlayDrag: vi.fn(),
		hudOverlayHide: vi.fn(),
		hudOverlayClose: vi.fn(),
		openNotes: vi.fn(),
		switchToEditor: vi.fn(async () => undefined),
		getRecordingWorkspaceContext: vi.fn(async () => ({ success: false, context: null })),
		setRecordingWorkspaceContext: vi.fn(async () => ({ success: true, context: null })),
		returnToEditorIfRecordingWorkspace: vi.fn(async () => ({ returned: false })),
		onSelectedSourceChanged: vi.fn((callback) => {
			selectedSourceChangedListeners.push(callback);
			return () => {
				selectedSourceChangedListeners = selectedSourceChangedListeners.filter(
					(listener) => listener !== callback,
				);
			};
		}),
		onSourceSelectorClosed: vi.fn((callback) => {
			sourceSelectorClosedListeners.push(callback);
			return () => {
				sourceSelectorClosedListeners = sourceSelectorClosedListeners.filter(
					(listener) => listener !== callback,
				);
			};
		}),
	} as typeof window.electronAPI;
}

const displayOneSource = {
	id: "screen:1:0",
	name: "Display 1",
	display_id: "1",
	thumbnail: null,
	appIcon: null,
} satisfies ProcessedDesktopSource;

async function waitForSourceSelectionSubscription() {
	await waitFor(() => {
		expect(selectedSourceChangedListeners.length).toBeGreaterThan(0);
	});
}

function emitSelectedSourceChanged(source: ProcessedDesktopSource) {
	act(() => {
		selectedSourceChangedListeners.forEach((listener) => listener(source));
	});
}

function emitSourceSelectorClosed() {
	act(() => {
		sourceSelectorClosedListeners.forEach((listener) => listener());
	});
}

function resetLaunchMocks() {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	recorderState.value.toggleRecording.mockClear();
	recorderState.value.softwareEncoderFallbackNoticeVisible = false;
	recorderState.value.dismissSoftwareEncoderFallbackNotice.mockClear();
	recorderState.value.recording = false;
	recorderState.value.paused = false;
	recorderState.value.saving = false;
	recorderState.value.clipFinalizing = false;
	recorderState.value.elapsedSeconds = 0;
	recorderState.value.activeClipElapsedMs = 0;
	recorderState.value.recordedClips = [];
	recorderState.value.canPauseRecording = false;
	recorderState.value.canReconfigureWhilePaused = false;
	recorderState.value.canRemovePreviousClip = false;
	recorderState.value.removePreviousClip.mockClear();
	recorderState.value.togglePaused.mockClear();
	recorderState.value.microphoneEnabled = false;
	recorderState.value.setMicrophoneEnabled.mockClear();
	recorderState.value.setMicrophoneDeviceId.mockClear();
	recorderState.value.webcamEnabled = false;
	recorderState.value.setWebcamEnabled.mockClear();
	recorderState.value.webcamFormat = { width: 1920, height: 1080, fps: 30 };
	recorderState.value.setWebcamFormat.mockClear();
	micDevicesState.value = [];
	cameraDevicesState.value = [];
	selectedSourceChangedListeners = [];
	sourceSelectorClosedListeners = [];
	i18nState.value.systemLocaleSuggestion = null;
	i18nState.value.acceptSystemLocaleSuggestion.mockClear();
	i18nState.value.dismissSystemLocaleSuggestion.mockClear();
	i18nState.value.resolveSystemLocaleSuggestion.mockClear();
	linuxHelperAvailable.value = true;
	stubElectronAPI(vi.fn(async () => null));
}

describe("LaunchWindow record button", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("opens the source selector instead of disabling the primary action when no source is selected", async () => {
		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");

		expect(recordButton).toBeEnabled();
		expect(recordButton).toHaveAttribute("title", "Please select a source to record");

		fireEvent.click(recordButton);

		await waitFor(() => {
			expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("restores HUD direction exclusions after a StrictMode effect restart", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 10,
			y: 20,
			width: 240,
			height: 48,
			top: 20,
			right: 250,
			bottom: 68,
			left: 10,
			toJSON: () => ({}),
		});

		renderStrictLaunchWindow();

		await waitFor(() => {
			const calls = vi.mocked(window.electronAPI.setHudDirectionExclusionRectangles).mock.calls;
			expect(calls.at(-1)?.[0]).toEqual([{ x: 10, y: 20, width: 240, height: 48 }]);
		});
	});

	it("records immediately after source selection when the record button opened the picker", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));
		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		});
		expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
	});

	it("does not record after manual source selection", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("clears record-after-selection intent when the source picker closes without a selection", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));
		emitSourceSelectorClosed();
		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("clears record-after-selection intent when opening the source picker fails", async () => {
		window.electronAPI.openSourceSelector = vi.fn(async () => {
			throw new Error("source selector failed");
		});

		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));

		await waitFor(() => {
			expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
		});

		await act(async () => {
			await Promise.resolve();
		});

		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("handles selected source polling failures", async () => {
		const error = new Error("selected source unavailable");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		stubElectronAPI(
			vi.fn(async () => {
				throw error;
			}),
		);

		renderLaunchWindow();

		await waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith("Failed to refresh selected source:", error);
		});

		warnSpy.mockRestore();
	});

	it("starts recording when a source is already selected", async () => {
		stubElectronAPI(vi.fn(async () => displayOneSource));

		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");
		await waitFor(() => {
			expect(recordButton).toHaveAttribute("title", "Display 1");
		});

		fireEvent.click(recordButton);

		expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled();
	});

	it("returns to the editor from the idle HUD with Escape or the close button", async () => {
		stubElectronAPI(vi.fn(async () => displayOneSource));
		window.electronAPI.getRecordingWorkspaceContext = vi.fn(async () => ({
			success: true,
			context: {
				origin: "editor",
				projectId: "project-1",
				insertionTimeSec: 4,
				currentTimeSec: 3,
				mode: "edit",
				inspectorOpen: true,
				facet: "effects",
			} as const,
		}));
		let returnStarted = false;
		window.electronAPI.returnToEditorIfRecordingWorkspace = vi.fn(async () => {
			if (!returnStarted) {
				returnStarted = true;
				await window.electronAPI.switchToEditor();
			}
			return { returned: true };
		});

		renderLaunchWindow();
		const close = await screen.findByRole("button", { name: "Open Studio" });
		fireEvent.keyDown(window, { key: "Escape" });
		fireEvent.click(close);

		await waitFor(() => {
			expect(window.electronAPI.returnToEditorIfRecordingWorkspace).toHaveBeenCalledTimes(2);
		});
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledTimes(1);
		expect(window.electronAPI.hudOverlayClose).not.toHaveBeenCalled();
	});

	it("keeps the HUD interactive on Linux so the drag handle can receive pointer events", async () => {
		platformState.value = "linux";

		renderLaunchWindow();

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlayIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
		});
	});

	// The ScreenCast portal has no parameter naming a source, so nothing this
	// picker returned could ever reach the capture — it only raised a second
	// portal dialog whose grant was discarded. On Linux the compositor's own
	// picker, shown when recording starts, is the only thing that decides.
	it("hides the in-app source button on Linux", async () => {
		platformState.value = "linux";

		renderLaunchWindow();

		// The helper-availability answer arrives asynchronously, so the button is
		// still there on the first frame — wait for it to go rather than race it.
		await waitFor(() => {
			expect(screen.queryByTestId("launch-source-selector-button")).toBeNull();
		});
	});

	it("records straight away on Linux instead of demanding a source that cannot be selected", async () => {
		platformState.value = "linux";

		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");
		expect(recordButton).toBeEnabled();
		await waitFor(() => {
			expect(recordButton).toHaveAttribute("title", "Your system will ask what to share");
		});

		fireEvent.click(recordButton);

		await waitFor(() => {
			expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		});
		expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled();
	});

	// The portal reports a KIND, never a window title, so naming the source here
	// could only ever be a guess — and guessing is what put a window's name on a
	// recording of the whole screen.
	/**
	 * Without the helper the recorder falls back to Chromium's capture, which
	 * DOES consume a source id. Hiding the picker there would leave no way to
	 * start a recording at all.
	 */
	it("keeps the in-app source button on Linux when the native helper is missing", async () => {
		platformState.value = "linux";
		linuxHelperAvailable.value = false;

		renderLaunchWindow();

		expect(await screen.findByTestId("launch-source-selector-button")).toBeInTheDocument();
		expect(screen.getByTestId("launch-record-button")).toHaveAttribute(
			"title",
			"Please select a source to record",
		);
	});

	/**
	 * `portalOwnsSource` is resolved over IPC, so for a moment after mount it
	 * still reads false on Linux. A Record click landing in that window opened a
	 * selector the main process refuses — and the click used to be swallowed,
	 * doing nothing at all. The refusal is authoritative and answers immediately,
	 * so it starts the recording instead.
	 */
	it("records when the picker refuses because the portal owns the choice", async () => {
		platformState.value = "linux";
		// Forces the click down the open-the-selector path, as an unresolved
		// portal check does.
		linuxHelperAvailable.value = false;
		window.electronAPI.openSourceSelector = vi.fn(async () => ({
			opened: false,
			reason: "portal-owns-selection",
		})) as unknown as Window["electronAPI"]["openSourceSelector"];

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-record-button"));

		await waitFor(() => {
			expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		});
	});

	it("keeps the original recording controls on Linux", async () => {
		platformState.value = "linux";
		recorderState.value.recording = true;

		renderLaunchWindow();

		expect(await screen.findByTestId("launch-record-button")).toBeEnabled();
		expect(screen.queryByTestId("launch-source-selector-button")).not.toBeInTheDocument();
	});

	it("keeps one clip-history surface before and during recording", async () => {
		recorderState.value.recording = false;
		recorderState.value.recordedClips = [];

		const view = renderLaunchWindow();

		const history = await screen.findByRole("img", { name: /Clip history: 0 completed clips/ });
		expect(history).toBeVisible();
		expect(history.firstElementChild?.children).toHaveLength(1);
		const surface = history.parentElement;

		recorderState.value.recording = true;
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);

		const activeHistory = screen.getByRole("img", {
			name: /Clip history: 0 completed clips, active clip/,
		});
		expect(activeHistory.parentElement).toBe(surface);
	});

	it("morphs the active history segment into the finalized clip without an empty frame", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = false;
		recorderState.value.clipFinalizing = false;
		recorderState.value.activeClipElapsedMs = 1_200;
		recorderState.value.recordedClips = [];

		const view = renderLaunchWindow();
		const activeHistory = await screen.findByRole("img", {
			name: /Clip history: 0 completed clips, active clip/,
		});
		const activeSegment = activeHistory.firstElementChild?.firstElementChild;

		recorderState.value.paused = true;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 1_200 },
		];
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);

		const finalizedHistory = screen.getByRole("img", {
			name: /Clip history: 1 completed clip$/,
		});
		expect(finalizedHistory.firstElementChild?.children).toHaveLength(1);
		expect(finalizedHistory.firstElementChild?.firstElementChild).toBe(activeSegment);
	});

	it("keeps the existing HUD row and adds proportional clip history below it", async () => {
		recorderState.value.recording = true;
		recorderState.value.canPauseRecording = true;
		recorderState.value.canRemovePreviousClip = true;
		recorderState.value.elapsedSeconds = 12;
		recorderState.value.activeClipElapsedMs = 900;
		recorderState.value.microphoneEnabled = true;
		recorderState.value.systemAudioEnabled = false;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 2200 },
			{ index: 1, screenVideoPath: "/recordings/clip-2.mp4", durationMs: 4100 },
		];

		renderLaunchWindow();

		expect(screen.getByRole("button", { name: "tooltips.pauseRecording" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Remove previous clip" })).toBeEnabled();
		const history = screen.getByRole("img", { name: /Clip history: 2 completed clips/ });
		expect(history).toBeVisible();
		const segments = history.firstElementChild?.children;
		expect((segments?.[0] as HTMLElement).style.flexGrow).toBe("2200");
		expect((segments?.[1] as HTMLElement).style.flexGrow).toBe("4100");
		expect(screen.queryByText(/2 clips/i)).not.toBeInTheDocument();
		expect(screen.getByTestId("launch-source-selector-button")).toBeDisabled();
		expect(screen.getByTestId("launch-microphone-button")).toBeDisabled();
		expect(screen.getByTestId("launch-record-button")).toBeEnabled();
		expect(screen.getByTestId("launch-record-button")).not.toHaveTextContent("Stop Recording");
		expect(
			screen.getByTestId("launch-record-button").querySelector('rect[x="6.5"][y="6.5"]'),
		).toBeInTheDocument();
	});

	it("unlocks the existing setup controls only after a completed macOS Pause", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.canPauseRecording = true;
		recorderState.value.canReconfigureWhilePaused = true;

		renderLaunchWindow();
		const cursorModeButton = await screen.findByTestId("launch-cursor-mode-button");

		expect(screen.getByTestId("launch-source-selector-button")).toBeEnabled();
		expect(screen.getByTestId("launch-system-audio-button")).toBeEnabled();
		expect(screen.getByTestId("launch-microphone-button")).toBeEnabled();
		expect(screen.getByTestId("launch-webcam-button")).toBeEnabled();
		expect(screen.getByTestId("launch-device-settings-button")).toBeEnabled();
		expect(cursorModeButton).toBeEnabled();
		expect(screen.getByTestId("launch-record-button")).toBeEnabled();
	});

	it("keeps the recording transport visually stable while a paused clip finalizes", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.saving = false;
		recorderState.value.clipFinalizing = true;
		recorderState.value.elapsedSeconds = 12;
		recorderState.value.canPauseRecording = false;

		renderLaunchWindow();

		const stop = await screen.findByTestId("launch-record-button");
		expect(stop).toBeDisabled();
		expect(stop).toHaveTextContent("00:12");
		expect(stop).not.toHaveTextContent("recording.saving");
		expect(screen.getByRole("button", { name: "tooltips.resumeRecording" })).toBeDisabled();
	});

	it("removes the previous clip from the button and Backspace key", async () => {
		recorderState.value.recording = true;
		recorderState.value.canRemovePreviousClip = true;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 2200 },
		];

		renderLaunchWindow();
		fireEvent.click(screen.getByRole("button", { name: "Remove previous clip" }));
		fireEvent.keyDown(window, { key: "Backspace" });

		expect(recorderState.value.removePreviousClip).toHaveBeenCalledTimes(2);
	});
});

/** jsdom reports zero layout, so fake a rendered box for the elements we measure. */
function stubBox(element: HTMLElement, width: number, height: number) {
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		top: 0,
		left: 0,
		right: width,
		bottom: height,
		width,
		height,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
	Object.defineProperty(element, "scrollWidth", { value: width, configurable: true });
	Object.defineProperty(element, "scrollHeight", { value: height, configurable: true });
}

async function flushResizeObservers() {
	await act(async () => {
		for (const callback of resizeCallbacks) {
			callback([], {} as ResizeObserver);
		}
	});
}

function lastRequestedHudSize(): [number, number] {
	const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
		mock: { calls: Array<[number, number]> };
	};
	return sizeMock.mock.calls[sizeMock.mock.calls.length - 1];
}

describe("LaunchWindow overlay sizing", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
		resizeCallbacks.length = 0;
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("reserves room for a popover before one is ever opened", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		await flushResizeObservers();

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalled();
		});

		const [, height] = lastRequestedHudSize();
		// The window is already tall enough for a full-height popover, so opening one
		// costs no native resize -- that is what stops the HUD jumping on first open.
		expect(height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 56 + HUD_POPOVER_GAP + HUD_POPOVER_MAX_HEIGHT,
		);
	});

	it("reclaims the overlay once the content drops well below what was granted", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		// A bogus oversized reading (e.g. an unstyled first paint in dev) must not
		// leave the overlay permanently inflated.
		stubBox(bar, 1400, 700);
		await flushResizeObservers();
		const [inflatedWidth, inflatedHeight] = lastRequestedHudSize();

		stubBox(bar, 400, 56);
		await flushResizeObservers();

		const [width, height] = lastRequestedHudSize();
		expect(width).toBeLessThan(inflatedWidth);
		expect(height).toBeLessThan(inflatedHeight);
	});

	it("does not resize the overlay when a popover opens", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		await flushResizeObservers();

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mockClear: () => void;
		};
		sizeMock.mockClear();

		fireEvent.click(screen.getByRole("button", { name: "English" }));
		await screen.findByTestId("hud-language-menu");
		await flushResizeObservers();

		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();
	});

	it("does not resize the overlay when the device-settings panel opens", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		await flushResizeObservers();

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mockClear: () => void;
		};
		sizeMock.mockClear();

		// The panel is the tallest floating surface, so the window reserves room for
		// it up front. Growing on open would shift the bottom-anchored stack and
		// show up as position judder — the exact thing the reserve model prevents.
		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		await screen.findByTestId("hud-device-settings");
		await flushResizeObservers();

		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		await waitFor(() => {
			expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
		});
		await flushResizeObservers();

		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();
	});

	it("grows the HUD overlay tall enough to fit the system language prompt", async () => {
		i18nState.value.systemLocaleSuggestion = "zh-CN";

		renderLaunchWindow();

		expect(await screen.findByText("Use your system language?")).toBeInTheDocument();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		const noticeHeight = 130;
		stubBox(screen.getByTestId("hud-notice-column"), 360, noticeHeight);
		await flushResizeObservers();

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalled();
		});

		const [, height] = lastRequestedHudSize();
		// Bar + popover reserve + the notice stacked above it, all of it on screen.
		expect(height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 56 + HUD_POPOVER_GAP + HUD_POPOVER_MAX_HEIGHT + noticeHeight,
		);
	});
});

describe("LaunchWindow language menu", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("sizes the menu from CSS instead of the overlay window's own height", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByRole("button", { name: "English" }));

		const menu = await screen.findByTestId("hud-language-menu");
		// A measured maxHeight/bottom is what used to truncate the list to whatever
		// the (initially tiny) overlay window could fit, then let it grow later when
		// the window grew for an unrelated reason -- e.g. after dragging the HUD.
		expect(menu.style.maxHeight).toBe("");
		expect(menu.style.bottom).toBe("");
		// And it lives inside the HUD stack, not portaled out to the document body.
		expect(menu.closest("[data-tray-layout]")).toBeNull();
		expect(menu.parentElement?.parentElement).toContainElement(
			screen.getByTestId("hud-drag-handle"),
		);
	});
});

describe("LaunchWindow device buttons", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("turns the microphone on with a single click, without opening anything", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-microphone-button"));

		expect(recorderState.value.setMicrophoneEnabled).toHaveBeenCalledWith(true);
		expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
	});

	it("turns the microphone off with a single click when it is already on", async () => {
		recorderState.value.microphoneEnabled = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-microphone-button"));

		expect(recorderState.value.setMicrophoneEnabled).toHaveBeenCalledWith(false);
	});

	it("turns the camera on with a single click, without opening anything", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-webcam-button"));

		await waitFor(() => {
			expect(recorderState.value.setWebcamEnabled).toHaveBeenCalledWith(true);
		});
		expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
	});

	it("turns the camera off with a single click when it is already on", async () => {
		recorderState.value.webcamEnabled = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-webcam-button"));

		await waitFor(() => {
			expect(recorderState.value.setWebcamEnabled).toHaveBeenCalledWith(false);
		});
	});

	it("persists audio and camera toggles for the next app launch", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-system-audio-button"));
		fireEvent.click(screen.getByTestId("launch-microphone-button"));
		fireEvent.click(screen.getByTestId("launch-webcam-button"));

		await waitFor(() => {
			expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
				systemAudioEnabled: true,
			});
			expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({ micEnabled: true });
			expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: true });
		});
	});
});

describe("LaunchWindow device settings", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("opens from the settings button and closes again from its own Done control", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");
		expect(panel).toBeInTheDocument();

		fireEvent.click(within(panel).getByRole("button", { name: "Done" }));

		await waitFor(() => {
			expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
		});
	});

	it("selects a device without switching it on", async () => {
		micDevicesState.value = [
			{ deviceId: "mic-a", label: "Mic A", groupId: "g" },
			{ deviceId: "mic-b", label: "Mic B", groupId: "g" },
		];

		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");

		fireEvent.click(within(panel).getByRole("menuitemradio", { name: /Mic B/ }));

		// Selection is a preference, not an activation — that separation is the
		// whole reason the picker moved out of the mic button.
		expect(recorderState.value.setMicrophoneDeviceId).toHaveBeenCalledWith("mic-b");
		expect(recorderState.value.setMicrophoneEnabled).not.toHaveBeenCalled();
		expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
			micDeviceId: "mic-b",
		});
	});

	it("persists a tested webcam resolution and frame-rate choice", async () => {
		cameraDevicesState.value = [{ deviceId: "cam-a", label: "Camera A", groupId: "g" }];

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const formatSelect = await screen.findByTestId("hud-webcam-format");

		fireEvent.change(formatSelect, { target: { value: "3840x2160@30" } });

		expect(recorderState.value.setWebcamFormat).toHaveBeenCalledWith({
			width: 3840,
			height: 2160,
			fps: 30,
		});
		expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
			camFormat: { width: 3840, height: 2160, fps: 30 },
		});
	});

	it("stays visible but disabled while recording", async () => {
		recorderState.value.recording = true;

		renderLaunchWindow();

		expect(await screen.findByTestId("launch-device-settings-button")).toBeDisabled();
	});
});

describe("LaunchWindow HUD drag", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
		resizeCallbacks.length = 0;
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
		// jsdom doesn't implement the Pointer Capture API; stub it so the drag handlers
		// (which call set/has/releasePointerCapture) don't throw.
		HTMLElement.prototype.setPointerCapture = vi.fn();
		HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
		HTMLElement.prototype.releasePointerCapture = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("sends the pointer's total travel, not per-frame deltas", async () => {
		renderLaunchWindow();

		const dragHandle = await screen.findByTestId("hud-drag-handle");

		fireEvent.pointerDown(dragHandle, { screenX: 100, screenY: 100 });
		expect(window.electronAPI.beginHudOverlayDrag).toHaveBeenCalledTimes(1);

		fireEvent.pointerMove(dragHandle, { screenX: 140, screenY: 130 });
		fireEvent.pointerMove(dragHandle, { screenX: 150, screenY: 140 });

		// Absolute offsets from the drag origin: the main process applies them to the
		// position it pinned at pointerdown, so nothing accumulates or drifts.
		expect(window.electronAPI.dragHudOverlayTo).toHaveBeenNthCalledWith(1, 40, 30);
		expect(window.electronAPI.dragHudOverlayTo).toHaveBeenNthCalledWith(2, 50, 40);

		fireEvent.pointerUp(dragHandle, { screenX: 150, screenY: 140 });
		expect(window.electronAPI.endHudOverlayDrag).toHaveBeenCalledTimes(1);
	});

	it("suppresses ResizeObserver-driven measurement while dragging, and measures once on release", async () => {
		renderLaunchWindow();

		const dragHandle = await screen.findByTestId("hud-drag-handle");

		// A bar wide enough that it genuinely outgrows the reserved window width, so a
		// measurement would produce a `setHudOverlaySize` call if it weren't suppressed.
		const bar = dragHandle.closest("[data-tray-layout]") as HTMLElement;
		stubBox(bar, 900, 56);

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mockClear: () => void;
		};
		sizeMock.mockClear();

		fireEvent.pointerDown(dragHandle, { screenX: 100, screenY: 100 });

		await flushResizeObservers();
		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();

		fireEvent.pointerMove(dragHandle, { screenX: 140, screenY: 130 });
		fireEvent.pointerUp(dragHandle, { screenX: 140, screenY: 130 });

		// Content is re-measured once the drag ends, so a real size change made mid-drag
		// still gets picked up promptly.
		await waitFor(() => {
			expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalled();
		});
	});
});

describe("LaunchWindow software encoder fallback notice", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("stays hidden while the recorder reports no fallback", () => {
		renderLaunchWindow();

		expect(screen.queryByText("Switched to software encoding")).not.toBeInTheDocument();
	});

	it("shows the notice when the recorder reports a software fallback", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		expect(await screen.findByText("Switched to software encoding")).toBeInTheDocument();
		expect(screen.getByText(/fell back to software H\.264 encoding/)).toBeInTheDocument();
	});

	it("dismisses the notice without persisting when Got it is clicked", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByRole("button", { name: "Got it" }));

		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledTimes(1);
		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledWith();
	});

	it("persists the suppression when Don't show again is clicked", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByRole("button", { name: "Don't show again" }));

		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledTimes(1);
		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledWith(true);
	});
});
