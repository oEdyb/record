// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { type ComponentProps, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RecordingQuality } from "../../lib/recording/recordingQuality";
import { HudDeviceSettings } from "./HudDeviceSettings";

vi.mock("../../hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0 }),
}));
vi.mock("../../hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({ supportedFormats: [], activeFormat: null, stream: null }),
}));

function settingsProps(): ComponentProps<typeof HudDeviceSettings> {
	return {
		micDevices: [],
		cameraDevices: [],
		activeMicId: undefined,
		activeCameraId: undefined,
		cameraEnabled: false,
		cameraStream: null,
		webcamFormat: { width: 1920, height: 1080, fps: 30 },
		cameraLoading: false,
		cameraError: null,
		onSelectMic: vi.fn(),
		onSelectCamera: vi.fn(),
		onSelectWebcamFormat: vi.fn(),
		onClose: vi.fn(),
		labels: {
			title: "Settings",
			done: "Done",
			microphone: "Microphone",
			camera: "Camera",
			micLevel: "Level",
			micHint: "Microphone",
			noMicrophones: "No microphones",
			searching: "Searching",
			noCameras: "No cameras",
			cameraUnavailable: "Unavailable",
			cameraQuality: "Camera quality",
			preview: "Preview",
			previewUnavailable: "Unavailable",
		},
	};
}

describe("HudDeviceSettings radio keyboard controls", () => {
	it("selects quality through its callback with wrapping arrows and Home/End", () => {
		const selected = vi.fn();
		const props = settingsProps();
		function Settings() {
			const [quality, setQuality] = useState<RecordingQuality>("high");
			return (
				<HudDeviceSettings
					{...props}
					recordingQuality={quality}
					onSelectRecordingQuality={(value) => {
						selected(value);
						setQuality(value);
					}}
				/>
			);
		}
		render(<Settings />);
		const group = screen.getByRole("radiogroup", { name: "Recording quality" });
		const high = within(group).getByRole("radio", { name: "High" });
		const standard = within(group).getByRole("radio", { name: "Standard" });
		expect(high).toHaveAttribute("tabindex", "0");
		expect(standard).toHaveAttribute("tabindex", "-1");
		fireEvent.keyDown(high, { key: "ArrowRight" });
		expect(standard).toHaveFocus();
		expect(standard).toHaveAttribute("aria-checked", "true");
		expect(standard).toHaveAttribute("tabindex", "0");
		expect(high).toHaveAttribute("tabindex", "-1");
		expect(selected).toHaveBeenLastCalledWith("standard");
		fireEvent.keyDown(standard, { key: "ArrowDown" });
		expect(high).toHaveFocus();
		expect(selected).toHaveBeenLastCalledWith("high");
		fireEvent.keyDown(high, { key: "ArrowUp" });
		expect(standard).toHaveFocus();
		fireEvent.keyDown(standard, { key: "Home" });
		expect(high).toHaveFocus();
		fireEvent.keyDown(high, { key: "End" });
		expect(standard).toHaveFocus();
		expect(selected).toHaveBeenLastCalledWith("standard");
	});

	it("opens one portal source action and preserves its recording lock", () => {
		const onChooseSource = vi.fn();
		const props = settingsProps();
		const { rerender } = render(<HudDeviceSettings {...props} extras={{ onChooseSource }} />);
		const source = screen.getByTestId("hud-setup-choose-source");
		expect(source).toHaveAttribute("aria-haspopup", "dialog");
		expect(screen.queryByRole("radiogroup", { name: "Source" })).not.toBeInTheDocument();
		fireEvent.click(source);
		expect(onChooseSource).toHaveBeenCalledOnce();
		rerender(<HudDeviceSettings {...props} extras={{ onChooseSource, sourceDisabled: true }} />);
		expect(source).toBeDisabled();
		fireEvent.click(source);
		expect(onChooseSource).toHaveBeenCalledOnce();
	});

	it("uses existing screen-selection and window-picker callbacks from source arrows", () => {
		const onOpenSource = vi.fn();
		const onSelectDisplay = vi.fn();
		const props = settingsProps();
		const extras = { sourceLabel: "Display 1", onOpenSource, onSelectDisplay };
		const { rerender } = render(<HudDeviceSettings {...props} extras={extras} />);
		const group = screen.getByRole("radiogroup", { name: "Source" });
		const display = within(group).getByRole("radio", { name: "Display 1" });
		const window = within(group).getByRole("radio", { name: "Window" });
		expect(display).toHaveAttribute("tabindex", "0");
		expect(window).toHaveAttribute("tabindex", "-1");
		fireEvent.keyDown(display, { key: "End" });
		expect(window).toHaveFocus();
		expect(onOpenSource).toHaveBeenCalledTimes(1);
		expect(onSelectDisplay).not.toHaveBeenCalled();
		rerender(
			<HudDeviceSettings
				{...props}
				extras={{ ...extras, sourceKind: "window", sourceLabel: "Editor" }}
			/>,
		);
		expect(window).toHaveAttribute("aria-checked", "true");
		expect(window).toHaveAttribute("tabindex", "0");
		fireEvent.keyDown(window, { key: "Home" });
		expect(display).toHaveFocus();
		expect(onSelectDisplay).toHaveBeenCalledTimes(1);
	});

	it("preserves recording locks for both groups even when keys are dispatched directly", () => {
		const onOpenSource = vi.fn();
		const onSelectDisplay = vi.fn();
		const onSelectRecordingQuality = vi.fn();
		render(
			<HudDeviceSettings
				{...settingsProps()}
				controlsLocked
				onSelectRecordingQuality={onSelectRecordingQuality}
				extras={{ sourceLabel: "Display 1", sourceDisabled: true, onOpenSource, onSelectDisplay }}
			/>,
		);
		for (const radio of screen.getAllByRole("radio")) {
			expect(radio).toBeDisabled();
			for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
				fireEvent.keyDown(radio, { key });
			}
		}
		expect(onOpenSource).not.toHaveBeenCalled();
		expect(onSelectDisplay).not.toHaveBeenCalled();
		expect(onSelectRecordingQuality).not.toHaveBeenCalled();
	});
});
