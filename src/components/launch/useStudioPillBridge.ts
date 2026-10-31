import { useEffect, useRef } from "react";
import type { RecordingQuality } from "@/lib/recording/recordingQuality";
import type { CursorCaptureMode } from "@/lib/recordingSession";

type PillSetupCommand = Parameters<Parameters<Window["electronAPI"]["onStudioSetupCommand"]>[0]>[0];
type PillState = Parameters<Window["electronAPI"]["reportStudioPillState"]>[0];

export interface StudioPillHandlers {
	toggleMicrophone: () => void;
	toggleWebcam: () => void;
	toggleSystemAudio: () => void;
	chooseSource: () => void;
	openNotes: () => void;
	cancelCountdown: () => void;
	undoRemovedClip: () => void;
	selectMic: (device: { deviceId: string; label: string; groupId: string }) => void;
	selectCamera: (device: { deviceId: string; label: string; groupId: string }) => void;
	selectQuality: (quality: RecordingQuality) => void;
	setCursorMode: (mode: CursorCaptureMode) => void;
}

/** Runs one Studio setup command through the pill's own handler, so its predicates decide. */
export function runStudioSetupCommand(command: PillSetupCommand, handlers: StudioPillHandlers) {
	if (typeof command === "object") {
		if (command.kind === "select-mic")
			handlers.selectMic({ deviceId: command.deviceId, label: command.name, groupId: "" });
		if (command.kind === "select-camera")
			handlers.selectCamera({ deviceId: command.deviceId, label: command.name, groupId: "" });
		if (command.kind === "set-quality") handlers.selectQuality(command.value);
		if (command.kind === "set-cursor") handlers.setCursorMode(command.value);
		return;
	}
	if (command === "toggle-mic") handlers.toggleMicrophone();
	if (command === "toggle-camera") handlers.toggleWebcam();
	if (command === "toggle-system-audio") handlers.toggleSystemAudio();
	if (command === "choose-source") handlers.chooseSource();
	if (command === "open-notes") handlers.openNotes();
	if (command === "cancel-countdown") handlers.cancelCountdown();
	if (command === "undo-remove") handlers.undoRemovedClip();
}

/**
 * The pill owns the take and its devices; the Studio asks it for setup changes and mirrors
 * the state only the pill knows (its locks and the clip Undo can bring back).
 */
export function useStudioPillBridge(handlers: StudioPillHandlers, state: PillState) {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;

	useEffect(() => {
		return window.electronAPI?.onStudioSetupCommand?.((command) =>
			runStudioSetupCommand(command, handlersRef.current),
		);
	}, []);

	const {
		controlsLocked,
		canRemovePreviousClip,
		undoClipIndex,
		countingDown,
		saving,
		transportBusy,
		canPause,
	} = state;
	useEffect(() => {
		window.electronAPI?.reportStudioPillState?.({
			controlsLocked,
			canRemovePreviousClip,
			undoClipIndex,
			countingDown,
			saving,
			transportBusy,
			canPause,
		});
	}, [
		controlsLocked,
		canRemovePreviousClip,
		undoClipIndex,
		countingDown,
		saving,
		transportBusy,
		canPause,
	]);
}
