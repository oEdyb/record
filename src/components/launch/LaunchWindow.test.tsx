// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewAudio } from "@/lib/ai-edition/preview/previewAudio";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { loadUserPreferences } from "@/lib/userPreferences";
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
		preferencesReady: true,
		starting: false,
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
		removePreviousClip: vi.fn(async (): Promise<RecordingSessionClip | null> => null),
		restoreRemovedClip: vi.fn(async (): Promise<RecordingSessionClip | null> => null),
		restartRecording: vi.fn(),
		cancelRecording: vi.fn(),
		microphoneEnabled: false,
		setMicrophoneEnabled: vi.fn(),
		microphoneDeviceId: undefined as string | undefined,
		setMicrophoneDeviceId: vi.fn(),
		setMicrophoneDeviceName: vi.fn(),
		webcamEnabled: false,
		webcamPreviewStream: null as MediaStream | null,
		setWebcamEnabled: vi.fn(async () => true),
		webcamDeviceId: undefined,
		setWebcamDeviceId: vi.fn(),
		setWebcamDeviceName: vi.fn(),
		recordingQuality: "high" as "high" | "standard",
		setRecordingQuality: vi.fn(),
		webcamFormat: { width: 1920, height: 1080, fps: 30 },
		setWebcamFormat: vi.fn(),
		webcamFormatAuto: true,
		setWebcamFormatAuto: vi.fn(),
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
let toggleRecordingPauseListeners: Array<() => void> = [];

vi.mock("../../hooks/useScreenRecorder", () => ({
	useScreenRecorder: () => recorderState.value,
}));

const micDevicesState = vi.hoisted(() => ({
	value: [] as Array<{ deviceId: string; label: string; groupId: string }>,
	isLoading: false,
}));
const cameraDevicesState = vi.hoisted(() => ({
	value: [] as Array<{ deviceId: string; label: string; groupId: string }>,
}));

vi.mock("../../hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: () => ({
		devices: micDevicesState.value,
		isLoading: micDevicesState.isLoading,
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

const cameraPreviewState = vi.hoisted(() => ({
	value: {
		supportedFormats: [
			{ width: 3840, height: 2160, fps: 30 },
			{ width: 1920, height: 1080, fps: 30 },
		],
		// A real camera reports the old mode until applyConstraints settles, so the
		// active format lags behind the saved choice.
		activeFormat: { width: 1920, height: 1080, fps: 30 },
	},
}));

vi.mock("../../hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({
		stream: null,
		error: null,
		supportedFormats: cameraPreviewState.value.supportedFormats,
		activeFormat: cameraPreviewState.value.activeFormat,
	}),
}));

vi.mock("../../lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({
		success: true,
		granted: true,
		status: "granted",
	})),
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
	useScopedT: () => (key: string, vars?: Record<string, string | number>) => {
		const translations: Record<string, string> = {
			"sourceSelector.defaultSourceName": "Screen",
			"recordingReview.record": "Record",
			"recording.selectSource": "Please select a source to record",
			"recording.systemPicker": "Your system will ask what to share",
			"recording.inProgress": "Recording",
			"recording.removePreviousClip": "Remove previous clip",
			"recording.removePreviousClipWithDuration": "Remove previous clip ({{duration}})",
			"recording.clipRemoved": "Removed",
			"actions.undo": "Undo",
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
			"recording.recordings": "Recordings",
			"recording.starting": "Starting recording…",
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
		return (translations[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
			String(vars?.[name] ?? `{{${name}}}`),
		);
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
		getSources: vi.fn(async () => []),
		selectSource: vi.fn(async (source: ProcessedDesktopSource) => source),
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
		getRecordingWorkspaceContext: vi.fn(async () => ({
			success: false,
			context: null,
		})),
		setRecordingWorkspaceContext: vi.fn(async () => ({
			success: true,
			context: null,
		})),
		returnToEditorIfRecordingWorkspace: vi.fn(async () => ({
			returned: false,
		})),
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
		onHudToggleRecordingPause: vi.fn((callback) => {
			toggleRecordingPauseListeners.push(callback);
			return () => {
				toggleRecordingPauseListeners = toggleRecordingPauseListeners.filter(
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
	localStorage.clear();
	recorderState.value.preferencesReady = true;
	recorderState.value.starting = false;
	recorderState.value.recording = false;
	recorderState.value.paused = false;
	recorderState.value.canReconfigureWhilePaused = false;
	recorderState.value.microphoneDeviceId = undefined;
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
	recorderState.value.removePreviousClip.mockReset();
	recorderState.value.removePreviousClip.mockResolvedValue(null);
	recorderState.value.restoreRemovedClip.mockReset();
	recorderState.value.restoreRemovedClip.mockResolvedValue(null);
	recorderState.value.togglePaused.mockClear();
	recorderState.value.microphoneEnabled = false;
	recorderState.value.setMicrophoneEnabled.mockClear();
	recorderState.value.setMicrophoneDeviceId.mockClear();
	recorderState.value.webcamEnabled = false;
	recorderState.value.setWebcamEnabled.mockClear();
	recorderState.value.recordingQuality = "high";
	recorderState.value.setRecordingQuality.mockClear();
	recorderState.value.webcamFormat = { width: 1920, height: 1080, fps: 30 };
	recorderState.value.setWebcamFormat.mockClear();
	cameraPreviewState.value = {
		supportedFormats: [
			{ width: 3840, height: 2160, fps: 30 },
			{ width: 1920, height: 1080, fps: 30 },
		],
		activeFormat: { width: 1920, height: 1080, fps: 30 },
	};
	micDevicesState.value = [];
	micDevicesState.isLoading = false;
	cameraDevicesState.value = [];
	selectedSourceChangedListeners = [];
	sourceSelectorClosedListeners = [];
	toggleRecordingPauseListeners = [];
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

	it("warms the capture helper when the pointer reaches Record", async () => {
		const prewarm = vi.fn(async () => undefined);
		window.electronAPI.prewarmNativeMacCapture = prewarm;
		renderLaunchWindow();

		fireEvent.pointerEnter(await screen.findByTestId("launch-record-button"));

		expect(prewarm).toHaveBeenCalledTimes(1);
	});

	it("leaves a paused window take alone when Setup is hovered, so keeping the window costs nothing", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.canReconfigureWhilePaused = true;
		window.electronAPI.getSources = vi.fn(async () => [displayOneSource]);
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();
		act(() => {
			selectedSourceChangedListeners.forEach((listener) =>
				listener({ ...displayOneSource, id: "window:4242:0", name: "Claude", display_id: "" }),
			);
		});

		window.electronAPI.prepareNativeMacContinue = vi.fn(async () => ({
			success: true,
			prepared: true,
		}));
		fireEvent.pointerEnter(await screen.findByTestId("launch-device-settings-button"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(window.electronAPI.prepareNativeMacContinue).not.toHaveBeenCalled();
	});

	it("opens the source panel above the pill instead of disabling Record when no source is selected", async () => {
		window.electronAPI.getSources = vi.fn(async () => []);
		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");

		expect(recordButton).toBeEnabled();
		expect(recordButton).toHaveAttribute("title", "Please select a source to record");

		fireEvent.click(recordButton);

		expect(await screen.findByTestId("hud-source-panel")).toBeInTheDocument();
		expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled();
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("records once a source is chosen in the panel after Record", async () => {
		window.electronAPI.getSources = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValue([displayOneSource]);
		window.electronAPI.selectSource = vi.fn(async (source) => {
			selectedSourceChangedListeners.forEach((listener) => listener(source));
			return source;
		});
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));
		fireEvent.click((await screen.findAllByTestId("source-selector-card"))[0]);

		await waitFor(() => expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByTestId("hud-source-panel")).not.toBeInTheDocument());
	});

	it("drops the pending Record when the source panel is closed through Setup", async () => {
		window.electronAPI.getSources = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValue([displayOneSource]);
		window.electronAPI.selectSource = vi.fn(async (source) => {
			selectedSourceChangedListeners.forEach((listener) => listener(source));
			return source;
		});
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));
		await screen.findByTestId("hud-source-panel");
		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		fireEvent.click(screen.getByTestId("launch-device-settings-button"));

		fireEvent.click(screen.getByTestId("launch-source-selector-button"));
		fireEvent.click((await screen.findAllByTestId("source-selector-card"))[0]);

		await waitFor(() => expect(window.electronAPI.selectSource).toHaveBeenCalled());
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("swaps Setup and the source panel in place, without motion", async () => {
		window.electronAPI.getSources = vi.fn(async () => [displayOneSource]);
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		expect(screen.getByTestId("hud-device-settings")).toHaveAttribute("data-instant", "false");

		fireEvent.click(screen.getByTestId("launch-source-selector-button"));
		const sourcePanel = await screen.findByTestId("hud-source-panel");
		expect(sourcePanel).toHaveAttribute("data-instant", "true");
		expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		expect(screen.getByTestId("hud-device-settings")).toHaveAttribute("data-instant", "true");
		expect(screen.queryByTestId("hud-source-panel")).not.toBeInTheDocument();
	});

	it("keeps Setup up until its Window tile's picker replaces it in place", async () => {
		window.electronAPI.getSources = vi.fn(async () => [displayOneSource]);
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const sourceGroup = screen.getByTestId("hud-setup-source-group");
		const tiles = within(sourceGroup).getAllByRole("radio");
		fireEvent.click(tiles[tiles.length - 1]);

		expect(screen.getByTestId("hud-device-settings")).toBeInTheDocument();
		const sourcePanel = await screen.findByTestId("hud-source-panel");
		expect(sourcePanel).toHaveAttribute("data-instant", "true");
		expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
	});

	it("falls back to the picker window when screen access still has to be granted", async () => {
		window.electronAPI.requestScreenAccess = vi.fn(async () => ({
			success: true,
			granted: false,
			status: "denied",
		}));
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-record-button"));

		await waitFor(() => {
			expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
		});
		expect(screen.queryByTestId("hud-source-panel")).not.toBeInTheDocument();
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

	it("names the idle action Record after manual selection", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(screen.getByTestId("launch-record-button")).toHaveAccessibleName("Record");
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
		window.electronAPI.requestScreenAccess = vi.fn(async () => ({
			success: true,
			granted: false,
			status: "denied",
		}));
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

	it("starts a fresh screen recording with one primary click", async () => {
		let selected: ProcessedDesktopSource | null = null;
		stubElectronAPI(vi.fn(async () => selected));
		window.electronAPI.getSources = vi.fn(async () => [displayOneSource]);
		window.electronAPI.getRecordingWorkspaceContext = vi.fn(async () => ({
			success: true,
			context: null,
		}));
		window.electronAPI.selectSource = vi.fn(async (source) => {
			selected = source;
			return source;
		});
		renderLaunchWindow();
		const record = screen.getByTestId("launch-record-button");
		await waitFor(() => expect(record).toBeEnabled());
		expect(record).toHaveAttribute("title", "Display 1");
		fireEvent.click(record);
		expect(recorderState.value.toggleRecording).toHaveBeenCalledOnce();
		expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled();
		// Keep subsequent tests' API surface unchanged.
		delete (window.electronAPI as Partial<Window["electronAPI"]>).getSources;
		delete (window.electronAPI as Partial<Window["electronAPI"]>).getRecordingWorkspaceContext;
	});

	it("shows pending capture without claiming recording or allowing another start", async () => {
		stubElectronAPI(vi.fn(async () => displayOneSource));
		recorderState.value.starting = true;
		renderLaunchWindow();
		// The pill switches immediately, but nothing claims capture has begun:
		// the timer is held, Pause is unavailable and the transport cancels.
		expect(document.querySelector('[data-recording-layout="recording"]')).not.toBeNull();
		expect(document.querySelector('[data-starting="true"]')).not.toBeNull();
		const transport = await screen.findByTestId("launch-record-button");
		expect(transport).toBeEnabled();
		expect(transport).toHaveAccessibleName("tooltips.cancelRecording");
		expect(screen.getByTestId("hud-recording-timer")).toHaveAttribute("data-paused", "true");
		expect(screen.getByTestId("hud-compact-pause-button")).toBeDisabled();
		fireEvent.click(transport);
		expect(recorderState.value.toggleRecording).toHaveBeenCalledOnce();
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
		await waitFor(() =>
			expect(document.querySelector('[data-recording-layout="idle"]')).not.toBeNull(),
		);
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
		expect(screen.queryByTestId("hud-compact-pause-button")).not.toBeInTheDocument();
		fireEvent.keyDown(window, { key: "Escape" });
		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		fireEvent.click(await screen.findByTestId("launch-open-studio-button"));

		await waitFor(() => {
			expect(window.electronAPI.returnToEditorIfRecordingWorkspace).toHaveBeenCalledTimes(1);
		});
		expect(window.electronAPI.switchToEditor).toHaveBeenCalledTimes(2);
		expect(window.electronAPI.hudOverlayClose).not.toHaveBeenCalled();
	});
	it("returns to review from the idle pill without an insertion workspace", async () => {
		window.history.replaceState(null, "", "?windowType=hud-overlay&returnToReview=true");
		try {
			stubElectronAPI(vi.fn(async () => displayOneSource));
			renderLaunchWindow();
			await waitFor(() => expect(screen.getByTestId("launch-record-button")).toBeEnabled());
			expect(document.querySelector('[data-recording-layout="idle"]')).not.toBeNull();
			expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
			expect(screen.getByTestId("launch-device-settings-button")).toBeVisible();
			fireEvent.keyDown(window, { key: "Escape" });
			expect(window.electronAPI.switchToEditor).toHaveBeenCalledOnce();
			expect(window.electronAPI.hudOverlayClose).not.toHaveBeenCalled();
			expect(window.electronAPI.setRecordingWorkspaceContext).not.toHaveBeenCalled();
		} finally {
			window.history.replaceState(null, "", "/");
		}
	});

	it.each([
		"starting",
		"clipFinalizing",
	] as const)("keeps the recorder open while %s", async (state) => {
		window.history.replaceState(null, "", "?windowType=hud-overlay&returnToReview=true");
		try {
			recorderState.value[state] = true;
			renderLaunchWindow();
			fireEvent.keyDown(window, { key: "Escape" });
			expect(window.electronAPI.switchToEditor).not.toHaveBeenCalled();
			expect(window.electronAPI.hudOverlayClose).not.toHaveBeenCalled();
		} finally {
			window.history.replaceState(null, "", "/");
		}
	});

	it("keeps the restored microphone and resolves its native device name", async () => {
		recorderState.value.microphoneEnabled = true;
		recorderState.value.microphoneDeviceId = "usb-mic";
		micDevicesState.value = [
			{ deviceId: "default", label: "Built-in", groupId: "default" },
			{ deviceId: "usb-mic", label: "Studio microphone", groupId: "usb" },
		];
		renderLaunchWindow();
		await waitFor(() =>
			expect(recorderState.value.setMicrophoneDeviceName).toHaveBeenCalledWith("Studio microphone"),
		);
		expect(recorderState.value.setMicrophoneDeviceId).not.toHaveBeenCalled();
	});

	it("waits for restored preferences before enabling Record", async () => {
		recorderState.value.preferencesReady = false;
		stubElectronAPI(vi.fn(async () => displayOneSource));
		renderLaunchWindow();
		expect(await screen.findByTestId("launch-record-button")).toBeDisabled();
	});

	it("does not block Record when microphone enumeration was cancelled with the mic off", async () => {
		micDevicesState.isLoading = true;
		renderLaunchWindow();
		expect(await screen.findByTestId("launch-record-button")).toBeEnabled();
	});

	it("keeps Stop available while microphone discovery is pending", async () => {
		recorderState.value.recording = true;
		recorderState.value.microphoneEnabled = true;
		micDevicesState.isLoading = true;
		renderLaunchWindow();
		const stop = await screen.findByTestId("launch-record-button");
		expect(stop).toBeEnabled();
		fireEvent.click(stop);
		expect(recorderState.value.toggleRecording).toHaveBeenCalledOnce();
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

	it("uses the same compact recording transport on Linux", async () => {
		platformState.value = "linux";
		recorderState.value.recording = true;
		recorderState.value.canPauseRecording = true;

		renderLaunchWindow();

		expect(await screen.findByTestId("launch-record-button")).toBeEnabled();
		expect(screen.getByTestId("hud-compact-pause-button")).toBeEnabled();
		expect(screen.queryByTestId("launch-source-selector-button")).not.toBeInTheDocument();
	});

	it("keeps Pause in the same slot and the pill the same width through Pause", async () => {
		recorderState.value.recording = true;
		recorderState.value.canPauseRecording = true;
		const view = renderLaunchWindow();
		const buttonsWhileRecording = screen
			.getAllByRole("button")
			.map((button) => button.getAttribute("data-testid"));
		expect(screen.getByTestId("hud-expand-button")).toBeDisabled();

		recorderState.value.paused = true;
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);
		expect(screen.getByTestId("hud-compact-pause-button")).toHaveAccessibleName(
			"tooltips.resumeRecording",
		);
		expect(
			screen.getAllByRole("button").map((button) => button.getAttribute("data-testid")),
		).toEqual(buttonsWhileRecording);
		expect(screen.queryByRole("img", { name: /Clip history/ })).not.toBeInTheDocument();
	});

	it("gives the setup panel's actions stable accessible names", async () => {
		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		expect(await screen.findByTestId("launch-open-studio-button")).toHaveAccessibleName(
			"Recordings",
		);
	});

	it("replays the kept clips while paused and closes the replay on Continue", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.canPauseRecording = true;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 2_000 },
			{ index: 1, screenVideoPath: "/recordings/clip-2.mp4", durationMs: 9_000, removed: true },
			{ index: 2, screenVideoPath: "/recordings/clip-3.mp4", durationMs: 8_000 },
		];
		const view = renderLaunchWindow();

		const expand = screen.getByTestId("hud-expand-button");
		expect(expand).toBeEnabled();
		expect(expand).toHaveAccessibleName("peek.open");
		fireEvent.click(expand);

		const peek = await screen.findByTestId("hud-clip-peek");
		expect(peek).toHaveTextContent("peek.clipOf");
		expect(screen.getByTestId("hud-clip-peek-video").getAttribute("src")).toContain(
			"klippt://app/__media__/",
		);
		expect(screen.getByRole("slider", { name: "peek.seek" })).toHaveAttribute(
			"aria-valuemax",
			"10",
		);

		recorderState.value.paused = false;
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);
		expect(screen.queryByTestId("hud-clip-peek")).not.toBeInTheDocument();
	});

	it("opens the replay with the up arrow only after a completed Pause", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.clipFinalizing = true;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 2_000 },
		];
		const view = renderLaunchWindow();
		const pause = screen.getByTestId("hud-compact-pause-button");
		expect(pause).toHaveAttribute("data-busy", "true");
		expect(pause).toBeDisabled();
		fireEvent.keyDown(window, { key: "ArrowUp" });
		expect(screen.queryByTestId("hud-clip-peek")).not.toBeInTheDocument();

		recorderState.value.clipFinalizing = false;
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);
		expect(screen.getByTestId("hud-compact-pause-button")).toHaveAttribute("data-busy", "false");
		fireEvent.keyDown(window, { key: "ArrowUp" });
		expect(await screen.findByRole("dialog", { name: "peek.title" })).toBeVisible();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog", { name: "peek.title" })).not.toBeInTheDocument();
	});

	it("shows recorder errors at the bottom, right above the pill", async () => {
		renderLaunchWindow();
		await screen.findByTestId("launch-record-button");

		act(() => {
			toast.error("Recording stopped: the writer failed");
		});

		const message = await screen.findByText("Recording stopped: the writer failed");
		expect(message.closest("[data-sonner-toaster]")).toHaveAttribute("data-y-position", "bottom");
	});

	it("shows the idle mic level only while the pill is on screen", async () => {
		recorderState.value.microphoneEnabled = true;
		micDevicesState.value = [{ deviceId: "mic-a", label: "Mic A", groupId: "g" }];
		let setVisible: (visible: boolean) => void = vi.fn();
		window.electronAPI.onHudVisibilityChanged = vi.fn((callback) => {
			setVisible = callback;
			return vi.fn();
		});
		renderLaunchWindow();
		const mic = await screen.findByTestId("launch-microphone-button");
		await waitFor(() => expect(mic.querySelector("span[aria-hidden]")).not.toBeNull());

		act(() => setVisible(false));
		expect(mic.querySelector("span[aria-hidden]")).toBeNull();
		act(() => setVisible(true));
		expect(mic.querySelector("span[aria-hidden]")).not.toBeNull();
	});

	it("sets the replay's listening level from the volume slider and shares it with the review", async () => {
		usePreviewAudio.setState({ volume: 1, muted: false });
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.canPauseRecording = true;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 2_000 },
		];
		renderLaunchWindow();
		fireEvent.keyDown(window, { key: "ArrowUp" });
		const video = (await screen.findByTestId("hud-clip-peek-video")) as HTMLVideoElement;
		expect(video.volume).toBe(1);

		fireEvent.change(screen.getByRole("slider", { name: "peek.volume" }), {
			target: { value: "0.3" },
		});
		expect(video.volume).toBeCloseTo(0.3);
		expect(video.muted).toBe(false);
		expect(loadUserPreferences().previewVolume).toBeCloseTo(0.3);

		fireEvent.click(screen.getByRole("button", { name: "peek.mute" }));
		expect(video.muted).toBe(true);
		expect(screen.getByRole("slider", { name: "peek.volume" })).toHaveValue("0");
		expect(loadUserPreferences().previewMuted).toBe(true);

		fireEvent.keyDown(screen.getByRole("slider", { name: "peek.volume" }), { key: "ArrowDown" });
		expect(screen.getByTestId("hud-clip-peek")).toBeVisible();
	});

	it("keeps the replay's video loaded while it is toggled open and closed", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.canPauseRecording = true;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 2_000 },
		];
		renderLaunchWindow();
		const video = await screen.findByTestId("hud-clip-peek-video");
		expect(screen.getByTestId("hud-clip-peek")).not.toBeVisible();

		for (let index = 0; index < 4; index += 1) {
			fireEvent.keyDown(window, { key: "ArrowUp" });
			expect(screen.getByTestId("hud-clip-peek")).toBeVisible();
			fireEvent.keyDown(window, { key: "ArrowDown" });
			expect(screen.getByTestId("hud-clip-peek")).not.toBeVisible();
		}
		expect(screen.getByTestId("hud-clip-peek-video")).toBe(video);
	});

	it("shows Stop as a secondary control and keeps setup locked while capturing", async () => {
		recorderState.value.recording = true;
		recorderState.value.canPauseRecording = true;
		recorderState.value.canRemovePreviousClip = true;
		recorderState.value.elapsedSeconds = 12;
		recorderState.value.microphoneEnabled = true;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 2200 },
		];

		renderLaunchWindow();
		expect(screen.getByRole("button", { name: "tooltips.pauseRecording" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Remove previous clip" })).toBeEnabled();
		expect(screen.getByTestId("launch-record-button")).toHaveAccessibleName(
			"tooltips.stopRecording",
		);
		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		expect(await screen.findByTestId("hud-setup-source")).toBeDisabled();
		expect(screen.getByRole("switch", { name: "audio.microphone" })).toBeDisabled();
	});

	it("unlocks the setup controls only after a completed macOS Pause", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.canPauseRecording = true;
		recorderState.value.canReconfigureWhilePaused = true;

		renderLaunchWindow();
		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		expect(await screen.findByTestId("hud-setup-source")).toBeEnabled();
		expect(screen.getByRole("switch", { name: "audio.systemAudio" })).toBeEnabled();
		expect(screen.getByRole("switch", { name: "audio.microphone" })).toBeEnabled();
		expect(screen.getByRole("switch", { name: "webcam.camera" })).toBeEnabled();
		expect(screen.getByRole("switch", { name: "deviceSettings.editableCursor" })).toBeEnabled();
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
		expect(stop).toHaveAccessibleName("tooltips.stopRecording");
		expect(screen.getByTestId("hud-recording-timer")).toHaveTextContent("00:12");
		expect(screen.getByRole("button", { name: "tooltips.resumeRecording" })).toBeDisabled();
	});

	it("keeps one timer and the compact transport slots while saving", async () => {
		recorderState.value.recording = true;
		recorderState.value.elapsedSeconds = 12;
		recorderState.value.canPauseRecording = true;
		const view = renderLaunchWindow();
		recorderState.value.saving = true;
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);

		const transport = screen.getByTestId("launch-record-button");
		expect(screen.getByTestId("hud-recording-timer")).toHaveTextContent("00:12");
		expect(transport).not.toHaveTextContent("recording.saving");
		expect(transport).toHaveAccessibleName("recording.saving");
		expect(transport).toHaveAttribute("aria-busy", "true");
		expect(transport).toBeDisabled();
		expect(screen.getByTestId("hud-compact-pause-button")).toBeDisabled();
		expect(screen.getByTestId("hud-remove-previous-clip-button")).toBeDisabled();
		expect(screen.getByTestId("hud-expand-button")).toBeDisabled();
		expect(document.querySelector('[data-recording-layout="recording"]')).not.toBeNull();
	});

	it("retains the last recording presentation through async handoff", async () => {
		recorderState.value.recording = true;
		recorderState.value.paused = true;
		recorderState.value.elapsedSeconds = 12;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 12000 },
		];
		const view = renderLaunchWindow();
		recorderState.value.saving = true;
		recorderState.value.recording = false;
		recorderState.value.paused = false;
		recorderState.value.elapsedSeconds = 0;
		recorderState.value.recordedClips = [];
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);

		expect(screen.getByTestId("hud-recording-timer")).toHaveTextContent("00:12");
		expect(screen.getByRole("button", { name: "tooltips.resumeRecording" })).toBeDisabled();
		expect(document.querySelector('[data-recording-layout="recording"]')).not.toBeNull();

		recorderState.value.saving = false;
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);
		expect(document.querySelector('[data-recording-layout="idle"]')).not.toBeNull();
		expect(screen.getByTestId("launch-record-button")).not.toHaveTextContent("00:12");
	});

	it("handles the global Pause shortcut only while the recorder can transition", async () => {
		recorderState.value.recording = true;
		recorderState.value.canPauseRecording = true;

		const view = renderLaunchWindow();
		await waitFor(() => expect(toggleRecordingPauseListeners).toHaveLength(1));
		act(() => toggleRecordingPauseListeners[0]?.());
		expect(recorderState.value.togglePaused).toHaveBeenCalledTimes(1);

		recorderState.value.clipFinalizing = true;
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);
		act(() => toggleRecordingPauseListeners[0]?.());
		expect(recorderState.value.togglePaused).toHaveBeenCalledTimes(1);
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

	it("shows the removed clip duration and restores that exact clip from Undo", async () => {
		const removedClip: RecordingSessionClip = {
			index: 1,
			screenVideoPath: "/recordings/clip-2.mp4",
			durationMs: 12_400,
			removed: true,
		};
		recorderState.value.recording = true;
		recorderState.value.canRemovePreviousClip = true;
		recorderState.value.recordedClips = [
			{ index: 0, screenVideoPath: "/recordings/clip-1.mp4", durationMs: 2200 },
			{ ...removedClip, removed: undefined },
		];
		recorderState.value.removePreviousClip.mockResolvedValueOnce(removedClip);
		recorderState.value.restoreRemovedClip.mockResolvedValueOnce({
			...removedClip,
			removed: undefined,
		});

		renderLaunchWindow();
		const removeButton = screen.getByRole("button", {
			name: "Remove previous clip",
		});
		fireEvent.focus(removeButton);
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Remove previous clip (00:12)");

		fireEvent.click(removeButton);
		const feedback = await screen.findByTestId("clip-removal-feedback");
		expect(feedback).toHaveTextContent("Removed");
		expect(feedback).toHaveTextContent("00:12");
		fireEvent.click(within(feedback).getByRole("button", { name: "Undo" }));

		await waitFor(() => {
			expect(recorderState.value.restoreRemovedClip).toHaveBeenCalledWith(1);
			expect(screen.queryByTestId("clip-removal-feedback")).not.toBeInTheDocument();
		});
	});

	it("hides the clip removal Undo after four seconds", async () => {
		vi.useFakeTimers();
		try {
			const removedClip: RecordingSessionClip = {
				index: 0,
				screenVideoPath: "/recordings/clip-1.mp4",
				durationMs: 5200,
				removed: true,
			};
			recorderState.value.recording = true;
			recorderState.value.canRemovePreviousClip = true;
			recorderState.value.recordedClips = [{ ...removedClip, removed: undefined }];
			recorderState.value.removePreviousClip.mockResolvedValueOnce(removedClip);

			renderLaunchWindow();
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Remove previous clip" }));
				await Promise.resolve();
			});
			expect(screen.getByTestId("clip-removal-feedback")).toBeInTheDocument();

			act(() => vi.advanceTimersByTime(3999));
			expect(screen.getByTestId("clip-removal-feedback")).toBeInTheDocument();
			act(() => vi.advanceTimersByTime(1));
			expect(screen.getByTestId("clip-removal-feedback")).toHaveAttribute("data-closing", "true");
			act(() => vi.advanceTimersByTime(120));
			expect(screen.queryByTestId("clip-removal-feedback")).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
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
	Object.defineProperty(element, "scrollWidth", {
		value: width,
		configurable: true,
	});
	Object.defineProperty(element, "scrollHeight", {
		value: height,
		configurable: true,
	});
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
			"[data-recording-layout]",
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
			"[data-recording-layout]",
		) as HTMLElement;
		// A bogus oversized reading (e.g. an unstyled first paint in dev) must not
		// leave the overlay permanently inflated.
		stubBox(bar, 1400, 700);
		await flushResizeObservers();
		const [inflatedWidth, inflatedHeight] = lastRequestedHudSize();

		stubBox(bar, 400, 56);
		await flushResizeObservers();

		const [width, height] = lastRequestedHudSize();
		// Horizontal HUDs keep one stable backing width so the compact animation
		// cannot move or resize the native window frame by frame.
		expect(width).toBe(inflatedWidth);
		expect(height).toBeLessThan(inflatedHeight);
	});

	it("does not resize the overlay when a popover opens", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-recording-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		await flushResizeObservers();

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mockClear: () => void;
		};
		sizeMock.mockClear();

		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		fireEvent.click(await screen.findByRole("button", { name: /deviceSettings\.language/ }));
		await screen.findByTestId("hud-language-menu");
		await flushResizeObservers();

		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();
	});

	it("keeps the native backing allocation through Pause and a deferred save", async () => {
		recorderState.value.recording = true;
		recorderState.value.elapsedSeconds = 12;
		const view = renderLaunchWindow();
		const bar = screen
			.getByTestId("hud-drag-handle")
			.closest("[data-recording-layout]") as HTMLElement;
		stubBox(bar, 256, 50);
		await flushResizeObservers();
		const resize = vi.mocked(window.electronAPI.setHudOverlaySize);
		const initialCalls = resize.mock.calls.length;
		recorderState.value.saving = true;
		recorderState.value.recording = false;
		recorderState.value.elapsedSeconds = 0;
		view.rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);
		stubBox(bar, 360, 50);
		await flushResizeObservers();
		expect(resize).toHaveBeenCalledTimes(initialCalls);
		expect(screen.getByTestId("hud-recording-timer")).toHaveTextContent("00:12");
	});

	it("does not resize the overlay when the device-settings panel opens", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-recording-layout]",
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
			"[data-recording-layout]",
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

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		fireEvent.click(await screen.findByRole("button", { name: /deviceSettings\.language/ }));

		const menu = await screen.findByTestId("hud-language-menu");
		// A measured maxHeight/bottom is what used to truncate the list to whatever
		// the (initially tiny) overlay window could fit, then let it grow later when
		// the window grew for an unrelated reason -- e.g. after dragging the HUD.
		expect(menu.style.maxHeight).toBe("");
		expect(menu.style.bottom).toBe("");
		// And it lives inside the HUD stack, not portaled out to the document body.
		expect(menu.closest("[data-recording-layout]")).toBeNull();
		expect(menu.closest("[data-testid='hud-device-settings']")).not.toBeNull();
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
			expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
				micEnabled: true,
			});
			expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
				camEnabled: true,
			});
		});
	});
});

describe("LaunchWindow device settings", () => {
	it("keeps Settings open when its switches are toggled", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");
		for (const toggle of within(panel).getAllByRole("switch")) {
			fireEvent.click(toggle);
		}

		await waitFor(() => {
			expect(recorderState.value.setWebcamEnabled).toHaveBeenCalledWith(true);
		});
		expect(screen.getByTestId("launch-device-settings-button")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});

	it("offers Automatic on High and records a picked camera format exactly", async () => {
		cameraDevicesState.value = [{ deviceId: "cam-a", label: "Camera A", groupId: "g" }];
		cameraPreviewState.value.supportedFormats = [
			{ width: 3840, height: 2160, fps: 30 },
			{ width: 1920, height: 1080, fps: 60 },
		];
		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const formatSelect = await screen.findByTestId("hud-webcam-format");
		expect(formatSelect).toHaveTextContent("deviceSettings.cameraAutomatic");
		fireEvent.keyDown(formatSelect, { key: "ArrowDown" });
		fireEvent.click(screen.getByRole("option", { name: "1080p, 60 FPS" }));
		expect(recorderState.value.setWebcamFormatAuto).toHaveBeenCalledWith(false);
		expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
			camFormat: { width: 1920, height: 1080, fps: 60 },
			camFormatAuto: false,
		});
	});
	it("shows High before recording and remembers a Standard choice", async () => {
		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const quality = await screen.findByTestId("hud-recording-quality");
		expect(within(quality).getByRole("radio", { checked: true })).toHaveTextContent("High");
		fireEvent.click(within(quality).getByRole("radio", { name: /qualityStandard|Standard/ }));
		expect(recorderState.value.setRecordingQuality).toHaveBeenCalledWith("standard");
		expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
			recordingQuality: "standard",
		});
	});
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("opens from the setup button and closes again with Escape", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");
		expect(panel).toBeInTheDocument();
		expect(within(panel).getByRole("button", { name: "Close App" })).toBeInTheDocument();
		fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
		await waitFor(() => {
			expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
		});
		expect(window.electronAPI.hudOverlayClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		await screen.findByTestId("hud-device-settings");
		fireEvent.keyDown(window, { key: "Escape" });

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
		fireEvent.click(within(panel).getByRole("button", { name: /audio\.microphone/ }));

		fireEvent.click(within(panel).getByRole("menuitemradio", { name: /Mic B/ }));

		// Selection is a preference, not an activation — that separation is the
		// whole reason the picker moved out of the mic button.
		expect(recorderState.value.setMicrophoneDeviceId).toHaveBeenCalledWith("mic-b");
		expect(recorderState.value.setMicrophoneEnabled).not.toHaveBeenCalled();
		expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
			micDeviceId: "mic-b",
		});
	});

	it("switches devices on from their rows and opens one device list at a time", async () => {
		micDevicesState.value = [{ deviceId: "mic-a", label: "Mic A", groupId: "g" }];
		cameraDevicesState.value = [{ deviceId: "cam-a", label: "Camera A", groupId: "g" }];

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");

		expect(within(panel).queryByRole("menuitemradio")).toBeNull();
		fireEvent.click(within(panel).getByRole("button", { name: /audio\.microphone/ }));
		expect(within(panel).getByRole("menuitemradio", { name: /Mic A/ })).toBeVisible();
		expect(within(panel).queryByRole("menuitemradio", { name: /Camera A/ })).toBeNull();

		const cameraRow = within(panel).getByRole("button", { name: /webcam\.camera/ });
		fireEvent.pointerDown(cameraRow);
		fireEvent.click(cameraRow);
		expect(screen.getByTestId("hud-device-settings")).toBeInTheDocument();
		expect(within(panel).getByRole("menuitemradio", { name: /Camera A/ })).toBeVisible();
		expect(within(panel).queryByRole("menuitemradio", { name: /Mic A/ })).toBeNull();

		fireEvent.click(within(panel).getByRole("switch", { name: "audio.microphone" }));
		expect(recorderState.value.setMicrophoneEnabled).toHaveBeenCalled();
	});

	it("persists a tested webcam resolution and frame-rate choice", async () => {
		recorderState.value.recordingQuality = "standard";
		cameraDevicesState.value = [{ deviceId: "cam-a", label: "Camera A", groupId: "g" }];

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const formatSelect = await screen.findByTestId("hud-webcam-format");

		fireEvent.keyDown(formatSelect, { key: "ArrowDown" });
		fireEvent.click(screen.getByRole("option", { name: "4K, 30 FPS" }));

		expect(recorderState.value.setWebcamFormat).toHaveBeenCalledWith({
			width: 3840,
			height: 2160,
			fps: 30,
		});
		expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith({
			camFormat: { width: 3840, height: 2160, fps: 30 },
		});
	});

	it("keeps the panel open while choosing a webcam format from the portaled option list", async () => {
		recorderState.value.recordingQuality = "standard";
		cameraDevicesState.value = [{ deviceId: "cam-a", label: "Camera A", groupId: "g" }];

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const formatSelect = await screen.findByTestId("hud-webcam-format");

		fireEvent.keyDown(formatSelect, { key: "ArrowDown" });
		const option = screen.getByRole("option", { name: "4K, 30 FPS" });
		expect(option.closest("[data-testid='hud-device-settings']")).toBeNull();

		fireEvent.pointerDown(option);
		expect(screen.getByTestId("hud-device-settings")).toBeInTheDocument();

		fireEvent.click(option);
		expect(recorderState.value.setWebcamFormat).toHaveBeenCalledWith({
			width: 3840,
			height: 2160,
			fps: 30,
		});
	});

	it("keeps a supported webcam format choice while the camera is still switching to it", async () => {
		recorderState.value.recordingQuality = "standard";
		cameraDevicesState.value = [{ deviceId: "cam-a", label: "Camera A", groupId: "g" }];
		recorderState.value.webcamFormat = { width: 3840, height: 2160, fps: 30 };

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		await screen.findByTestId("hud-webcam-format");

		expect(recorderState.value.setWebcamFormat).not.toHaveBeenCalled();
		expect(window.electronAPI.setRecordingPrefs).not.toHaveBeenCalledWith(
			expect.objectContaining({ camFormat: expect.anything() }),
		);
	});

	it("adopts the camera's resolved format when the saved choice is unsupported", async () => {
		recorderState.value.recordingQuality = "standard";
		cameraDevicesState.value = [{ deviceId: "cam-a", label: "Camera A", groupId: "g" }];
		recorderState.value.webcamFormat = { width: 3840, height: 2160, fps: 30 };
		cameraPreviewState.value = {
			supportedFormats: [{ width: 1920, height: 1080, fps: 30 }],
			activeFormat: { width: 1920, height: 1080, fps: 30 },
		};

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		await screen.findByTestId("hud-webcam-format");

		expect(recorderState.value.setWebcamFormat).toHaveBeenCalledWith({
			width: 1920,
			height: 1080,
			fps: 30,
		});
	});

	it("opens during capture with its rows and device lists locked", async () => {
		recorderState.value.recording = true;
		cameraDevicesState.value = [
			{ deviceId: "cam-a", label: "Camera A", groupId: "g" },
			{ deviceId: "cam-b", label: "Camera B", groupId: "g" },
		];

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));

		const panel = await screen.findByTestId("hud-device-settings");
		expect(within(panel).getByRole("switch", { name: "webcam.camera" })).toBeDisabled();
		expect(within(panel).getByRole("button", { name: "setup.discard" })).toBeEnabled();
		expect(within(panel).queryByRole("button", { name: "Close App" })).toBeNull();
		fireEvent.click(within(panel).getByRole("button", { name: /webcam\.camera/ }));
		expect(within(panel).getByRole("menuitemradio", { name: /Camera B/ })).toBeDisabled();
		fireEvent.click(within(panel).getByRole("menuitemradio", { name: /Camera B/ }));
		expect(recorderState.value.setWebcamDeviceId).not.toHaveBeenCalledWith("cam-b");
		expect(screen.getByTestId("hud-recording-quality")).toBeDisabled();
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

		fireEvent.pointerMove(dragHandle, { screenX: 140, screenY: 130, buttons: 1 });
		fireEvent.pointerMove(dragHandle, { screenX: 150, screenY: 140, buttons: 1 });

		// Absolute offsets from the drag origin: the main process applies them to the
		// position it pinned at pointerdown, so nothing accumulates or drifts.
		expect(window.electronAPI.dragHudOverlayTo).toHaveBeenNthCalledWith(1, 40, 30);
		expect(window.electronAPI.dragHudOverlayTo).toHaveBeenNthCalledWith(2, 50, 40);

		fireEvent.pointerUp(dragHandle, { screenX: 150, screenY: 140 });
		expect(window.electronAPI.endHudOverlayDrag).toHaveBeenCalledTimes(1);
	});

	it("lets go of the window when the button is no longer held", async () => {
		renderLaunchWindow();

		const dragHandle = await screen.findByTestId("hud-drag-handle");

		fireEvent.pointerDown(dragHandle, { screenX: 100, screenY: 100 });
		fireEvent.pointerMove(dragHandle, { screenX: 400, screenY: 100, buttons: 0 });
		fireEvent.pointerMove(dragHandle, { screenX: 900, screenY: 100, buttons: 1 });

		expect(window.electronAPI.dragHudOverlayTo).not.toHaveBeenCalled();
		expect(window.electronAPI.endHudOverlayDrag).toHaveBeenCalledTimes(1);
	});

	it("suppresses ResizeObserver-driven measurement while dragging, and measures once on release", async () => {
		renderLaunchWindow();

		const dragHandle = await screen.findByTestId("hud-drag-handle");

		// A bar wide enough that it genuinely outgrows the reserved window width, so a
		// measurement would produce a `setHudOverlaySize` call if it weren't suppressed.
		const bar = dragHandle.closest("[data-recording-layout]") as HTMLElement;
		stubBox(bar, 900, 900);

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mockClear: () => void;
		};
		sizeMock.mockClear();

		fireEvent.pointerDown(dragHandle, { screenX: 100, screenY: 100 });

		await flushResizeObservers();
		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();

		fireEvent.pointerMove(dragHandle, { screenX: 140, screenY: 130, buttons: 1 });
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
