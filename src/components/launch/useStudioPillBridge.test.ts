import { describe, expect, it, vi } from "vitest";
import { runStudioSetupCommand, type StudioPillHandlers } from "./useStudioPillBridge";

function handlers(): StudioPillHandlers {
	return {
		toggleMicrophone: vi.fn(),
		toggleWebcam: vi.fn(),
		toggleSystemAudio: vi.fn(),
		chooseSource: vi.fn(),
		openNotes: vi.fn(),
		cancelCountdown: vi.fn(),
		undoRemovedClip: vi.fn(),
		selectMic: vi.fn(),
		selectCamera: vi.fn(),
		selectQuality: vi.fn(),
		setCursorMode: vi.fn(),
	};
}

describe("runStudioSetupCommand", () => {
	it("runs each Studio setup command through the matching pill handler", () => {
		const h = handlers();
		runStudioSetupCommand("toggle-camera", h);
		runStudioSetupCommand("undo-remove", h);
		runStudioSetupCommand("cancel-countdown", h);
		runStudioSetupCommand({ kind: "select-mic", deviceId: "mic-2", name: "USB mic" }, h);
		runStudioSetupCommand({ kind: "set-quality", value: "high" }, h);
		expect(h.toggleWebcam).toHaveBeenCalledOnce();
		expect(h.undoRemovedClip).toHaveBeenCalledOnce();
		expect(h.cancelCountdown).toHaveBeenCalledOnce();
		expect(h.selectMic).toHaveBeenCalledWith({ deviceId: "mic-2", label: "USB mic", groupId: "" });
		expect(h.selectQuality).toHaveBeenCalledWith("high");
		expect(h.toggleMicrophone).not.toHaveBeenCalled();
	});
});
