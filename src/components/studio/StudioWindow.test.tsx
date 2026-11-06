// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeStudioLayout, saveUserPreferences } from "@/lib/userPreferences";
import type { StudioSnapshot } from "../../../electron/studio/types";
import { TooltipProvider } from "../ui/tooltip";
import { StudioWindow } from "./StudioWindow";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("@/hooks/useAudioLevelMeter", () => ({ useAudioLevelMeter: () => ({ level: 20 }) }));
vi.mock("@/hooks/useMicrophoneDevices", () => ({ useMicrophoneDevices: () => ({ devices: [] }) }));
vi.mock("@/hooks/useCameraDevices", () => ({ useCameraDevices: () => ({ devices: [] }) }));

function snapshot(phase: StudioSnapshot["phase"]): StudioSnapshot {
	return {
		phase,
		recordingId: 1,
		clips: phase === "idle" ? [] : [{ index: 4, screenVideoPath: "/take/4.mp4", durationMs: 8000 }],
		committedMs: 8000,
		liveSinceMs: null,
		hiddenForCapture: false,
		holdPlayback: phase === "recording",
		shown: true,
		setup: {
			source: { id: "screen:1", name: "Display", kind: "display" },
			micEnabled: true,
			micDeviceId: null,
			cameraEnabled: true,
			cameraDeviceId: null,
			systemAudioEnabled: true,
			cursorCaptureMode: "system",
			recordingQuality: "high",
		},
		pill: {
			controlsLocked: false,
			canRemovePreviousClip: phase === "paused" || phase === "review",
			undoClipIndex: null,
			countingDown: false,
			transportBusy: false,
			canPause: phase === "recording" || phase === "paused",
			saving: false,
		},
		transcript: {
			recordingId: 1,
			status: "idle",
			clips: [
				{
					index: 4,
					text: "A sentence.",
					words: [
						{ word: "A", startSec: 1, endSec: 1.2, confidence: 1 },
						{ word: "sentence.", startSec: 1.3, endSec: 2, confidence: 1 },
					],
					durationMs: 8000,
					error: null,
				},
			],
			progress: null,
			download: null,
			error: null,
			updatedAt: 0,
		},
	};
}
let listener: (value: StudioSnapshot) => void;
const command = vi.fn();
const unsubscribe = vi.fn();
const refresh = vi.fn();
function mount(value: StudioSnapshot, platform = "darwin") {
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			getPlatform: () => platform,
			getSources: vi.fn(async () => []),
			getStudioSnapshot: vi.fn(async () => value),
			onStudioUpdated: (cb: typeof listener) => {
				listener = cb;
				return unsubscribe;
			},
			studioCommand: command,
			requestCameraPreviewConnection: vi.fn(),
			writeClipboardText: vi.fn(async () => undefined),
			refreshTranscript: refresh,
		},
	});
	return render(
		<TooltipProvider>
			<StudioWindow />
		</TooltipProvider>,
	);
}
beforeEach(() => {
	localStorage.clear();
	command.mockClear();
	unsubscribe.mockClear();
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "");
	};
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Studio phase controls", () => {
	it.each([
		"idle",
		"recording",
		"paused",
		"review",
	] as const)("renders %s from the snapshot", async (phase) => {
		mount(snapshot(phase));
		await screen.findByRole("button", { name: "permissions.microphone" });
		const mic = screen.getByRole("button", { name: "permissions.microphone" });
		expect(mic).toHaveProperty("disabled", phase === "recording");
		expect(screen.queryByRole("button", { name: "studio.finish" }) !== null).toBe(
			phase === "review",
		);
		expect(screen.queryByRole("button", { name: "tooltips.resumeRecording" }) !== null).toBe(
			phase === "paused",
		);
		expect(screen.queryByRole("button", { name: "tooltips.pauseRecording" }) !== null).toBe(
			phase === "recording",
		);
		expect(screen.getAllByRole("status")).toHaveLength(1);
	});
	it("shows the actual Record failure and releases its pending control", async () => {
		command.mockResolvedValueOnce({ success: false, error: "Recording controls are busy." });
		mount(snapshot("idle"));
		fireEvent.click(await screen.findByRole("button", { name: "recordingReview.record" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Recording controls are busy."));
		expect(screen.getByRole("button", { name: "recordingReview.record" })).not.toBeDisabled();
	});

	it("asks the pill for the Linux portal instead of enumerating an empty picker", async () => {
		mount(snapshot("idle"), "linux");
		fireEvent.click(await screen.findByRole("button", { name: "Display" }));
		expect(screen.getByTestId("studio-window")).toHaveAttribute("data-platform", "linux");
		expect(command).toHaveBeenCalledWith("choose-source");
		expect(window.electronAPI.getSources).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});
	it("keeps the shared source dialog on macOS", async () => {
		mount(snapshot("idle"), "darwin");
		fireEvent.click(await screen.findByRole("button", { name: "Display" }));
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(window.electronAPI.getSources).toHaveBeenCalled();
		expect(command).not.toHaveBeenCalledWith("choose-source");
	});

	it("sends setup intents and waits for acknowledgement", async () => {
		mount(snapshot("idle"));
		fireEvent.click(await screen.findByRole("button", { name: "permissions.microphone" }));
		expect(command).toHaveBeenCalledWith("toggle-mic");
		expect(screen.getByRole("button", { name: "permissions.microphone" })).toBeDisabled();
		act(() =>
			listener({ ...snapshot("idle"), setup: { ...snapshot("idle").setup, micEnabled: false } }),
		);
		expect(screen.getByRole("button", { name: "permissions.microphone" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});
	it("resumes through the pill and holds replay immediately", async () => {
		mount(snapshot("paused"));
		fireEvent.click(await screen.findByRole("button", { name: "tooltips.resumeRecording" }));
		expect(command).toHaveBeenCalledWith("resume");
		act(() =>
			listener({
				...snapshot("paused"),
				transcript: { ...snapshot("paused").transcript, updatedAt: 1 },
			}),
		);
		expect(screen.getByRole("button", { name: "peek.play" })).toBeDisabled();
	});
	it("releases replay and controls together after an unanswered resume times out", async () => {
		mount(snapshot("paused"));
		const resume = await screen.findByRole("button", { name: "tooltips.resumeRecording" });
		vi.useFakeTimers();
		try {
			fireEvent.click(resume);
			expect(screen.getByRole("button", { name: "peek.play" })).toBeDisabled();
			act(() => vi.advanceTimersByTime(5001));
			expect(resume).not.toBeDisabled();
			expect(screen.getByRole("button", { name: "peek.play" })).not.toBeDisabled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps Pause and Stop live while the pill locks setup during capture", async () => {
		const value = snapshot("recording");
		value.pill.controlsLocked = true;
		mount(value);
		fireEvent.click(await screen.findByRole("button", { name: "tooltips.pauseRecording" }));
		expect(command).toHaveBeenCalledWith("pause");
		act(() => listener({ ...value, pill: { ...value.pill, transportBusy: true } }));
		expect(screen.getByRole("button", { name: "tooltips.stopRecording" })).toBeDisabled();
	});
	it("finishes review without offering record more", async () => {
		mount(snapshot("review"));
		fireEvent.click(await screen.findByRole("button", { name: "studio.finish" }));
		expect(command).toHaveBeenCalledWith("finish");
		expect(screen.queryByRole("button", { name: "tooltips.resumeRecording" })).toBeNull();
	});
	it("cancels the countdown instead of asking to record again", async () => {
		const value = snapshot("idle");
		value.pill.countingDown = true;
		value.pill.controlsLocked = true;
		mount(value);
		fireEvent.click(await screen.findByRole("button", { name: "countdown.cancelHint" }));
		expect(command).toHaveBeenCalledWith("cancel-countdown");
	});
	it("keeps the view switch in Camera view and paints one live camera", async () => {
		saveUserPreferences({ studioLayout: { ...normalizeStudioLayout(null), view: "camera" } });
		mount(snapshot("paused"));
		fireEvent.click(await screen.findByRole("button", { name: "studio.both" }));
		expect(document.querySelectorAll("#studio-live")).toHaveLength(1);
	});
	it("hides Remove after Stop once the pill can no longer remove a clip", async () => {
		const value = snapshot("review");
		value.pill.canRemovePreviousClip = false;
		mount(value);
		await screen.findByRole("button", { name: "studio.finish" });
		expect(screen.queryByRole("button", { name: "recording.removePreviousClip" })).toBeNull();
	});
	it("uses the pill remove predicate and Undo index", async () => {
		const value = snapshot("paused");
		value.pill.canRemovePreviousClip = false;
		mount(value);
		expect(
			await screen.findByRole("button", { name: "recording.removePreviousClip" }),
		).toBeDisabled();
		act(() => listener({ ...value, pill: { ...value.pill, undoClipIndex: 4 } }));
		fireEvent.click(screen.getByRole("button", { name: "studio.undo" }));
		expect(command).toHaveBeenCalledWith("undo-remove");
	});
	it("seeks and plays native sentence buttons with aria-current", async () => {
		mount(snapshot("paused"));
		fireEvent.click(await screen.findByRole("button", { name: "A sentence." }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "A sentence." })).toHaveAttribute(
				"aria-current",
				"true",
			),
		);
	});
	it("guards shortcuts on controls and honors the off switch", async () => {
		mount(snapshot("paused"));
		const mic = await screen.findByRole("button", { name: "permissions.microphone" });
		fireEvent.keyDown(mic, { key: "Backspace" });
		expect(command).not.toHaveBeenCalled();
		const main = screen.getByRole("main");
		fireEvent.keyDown(main, { key: "Backspace" });
		expect(command).toHaveBeenCalledWith("remove-last");
		act(() => listener(snapshot("paused")));
		command.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "studio.shortcuts" }));
		fireEvent.click(screen.getByRole("switch", { name: "studio.enableShortcuts" }));
		fireEvent.click(screen.getByRole("button", { name: "deviceSettings.done" }));
		fireEvent.keyDown(main, { key: "Backspace" });
		expect(command).not.toHaveBeenCalled();
	});
	it("keeps both dock panels when either separator reaches keyboard extremes", async () => {
		mount(snapshot("paused"));
		await screen.findByRole("button", { name: "studio.both" });
		for (const separator of screen.getAllByRole("separator")) {
			for (const key of ["Home", "End"]) {
				fireEvent.keyDown(separator, { key });
				expect(document.getElementById("studio-dock")).toBeVisible();
				expect(document.getElementById("studio-live")).toBeVisible();
				expect(document.getElementById("studio-replay")).toBeVisible();
			}
		}
	});

	it("offers transcription recovery without discarding completed text", async () => {
		const value = snapshot("review");
		value.transcript.error = "Transcription failed";
		mount(value);
		expect(await screen.findByRole("alert")).toHaveTextContent("Transcription failed");
		fireEvent.click(screen.getByRole("button", { name: "studio.transcribeNow" }));
		expect(refresh).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "A sentence." })).toBeVisible();
	});

	it("releases its snapshot subscription", async () => {
		const view = mount(snapshot("idle"));
		await screen.findByRole("button", { name: "permissions.microphone" });
		view.unmount();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
