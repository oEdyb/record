// @vitest-environment jsdom

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { RecStage } from "./RecStage";

const setRecordingPrefs = vi.fn(async () => undefined);
const setMicDevice = vi.fn();
const setCameraDevice = vi.fn();
const getSelectedSource = vi.fn();
const getSources = vi.fn();
const selectSource = vi.fn();
let cameraDevices = [{ deviceId: "cam-1", label: "Desk camera", groupId: "group-2" }];

vi.mock("@/hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0.42 }),
}));

vi.mock("@/hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({
		stream: {} as MediaStream,
		error: null,
		supportedFormats: [{ width: 1920, height: 1080, fps: 60 }],
		activeFormat: { width: 1920, height: 1080, fps: 60 },
	}),
}));

vi.mock("@/hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: () => ({
		devices: [{ deviceId: "mic-1", label: "Studio microphone", groupId: "group-1" }],
		selectedDeviceId: "mic-1",
		setSelectedDeviceId: setMicDevice,
		isLoading: false,
		error: null,
	}),
}));

vi.mock("@/hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({
		devices: cameraDevices,
		selectedDeviceId: "cam-1",
		setSelectedDeviceId: setCameraDevice,
		isLoading: false,
		error: null,
	}),
}));

vi.mock("@/hooks/usePortalOwnsSource", () => ({
	usePortalOwnsSource: () => false,
}));

beforeEach(() => {
	setRecordingPrefs.mockClear();
	setMicDevice.mockClear();
	setCameraDevice.mockClear();
	getSelectedSource.mockReset();
	getSources.mockReset();
	selectSource.mockReset();
	cameraDevices = [{ deviceId: "cam-1", label: "Desk camera", groupId: "group-2" }];
	const selectedScreen = {
		id: "screen:1:0",
		name: "Entire screen",
		thumbnail: "data:image/png;base64,c2NyZWVu",
		display_id: "1",
		appIcon: null,
	};
	getSelectedSource.mockResolvedValue(selectedScreen);
	getSources.mockResolvedValue([selectedScreen]);
	selectSource.mockImplementation(async (source) => source);
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			getRecordingPrefs: vi.fn(async () => ({
				micEnabled: true,
				micDeviceId: "mic-1",
				camEnabled: true,
				camDeviceId: "cam-1",
				camFormat: { width: 1920, height: 1080, fps: 60 },
				systemAudioEnabled: true,
				cursorCaptureMode: "editable-overlay",
			})),
			setRecordingPrefs,
			getSelectedSource,
			getSources,
			selectSource,
		},
	});
});

afterEach(() => cleanup());

function renderStage() {
	return render(
		<I18nProvider>
			<RecStage onStartRecording={vi.fn()} onClose={vi.fn()} />
		</I18nProvider>,
	);
}

describe("RecStage", () => {
	it("shows the webcam preview without starting a second screen capture", async () => {
		renderStage();

		expect(await screen.findByTestId("recording-camera-preview")).toBeInTheDocument();
		expect(screen.queryByTestId("recording-screen-preview")).not.toBeInTheDocument();
		expect(getSources).not.toHaveBeenCalled();
	});

	it("uses one device menu per microphone and camera, including Off", async () => {
		renderStage();

		const microphone = await screen.findByRole("combobox", {
			name: "Microphone",
		});
		const camera = screen.getByRole("combobox", { name: "Camera" });
		expect(microphone).toHaveTextContent("Studio microphone");
		expect(camera).toHaveTextContent("Desk camera");

		fireEvent.keyDown(microphone, { key: "ArrowDown" });
		fireEvent.click(screen.getByRole("option", { name: "Off" }));
		await waitFor(() => {
			expect(setRecordingPrefs).toHaveBeenCalledWith({ micEnabled: false });
		});

		fireEvent.keyDown(camera, { key: "ArrowDown" });
		expect(screen.getByRole("option", { name: "Off" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("option", { name: "Off" }));
		await waitFor(() => {
			expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: false });
		});
	});

	it("turns a stale saved camera off when the device is no longer available", async () => {
		cameraDevices = [];
		renderStage();

		const camera = await screen.findByRole("combobox", { name: "Camera" });
		await waitFor(() => expect(camera).toHaveTextContent("Off"));
		expect(camera).toBeEnabled();
		await waitFor(() => {
			expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: false });
		});
	});

	it("asks for a source instead of claiming an unselected screen", async () => {
		getSelectedSource.mockResolvedValue(null);
		renderStage();

		expect(
			await screen.findByRole("button", {
				name: "Please select a source to record",
			}),
		).toBeInTheDocument();
	});

	it("opens the source picker as a keyboard-contained dialog and restores focus", async () => {
		renderStage();
		const source = await screen.findByRole("button", { name: "Entire screen" });
		source.focus();
		fireEvent.click(source);

		const dialog = await screen.findByRole("dialog", { name: "Source" });
		expect(dialog).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Screens/ })).toHaveFocus();
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(dialog).not.toBeInTheDocument());
		expect(source).toHaveFocus();
	});
});
