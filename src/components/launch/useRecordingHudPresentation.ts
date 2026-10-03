import { useLayoutEffect, useState } from "react";
import type { RecordingSessionClip } from "@/lib/recordingSession";

type RecordingPresentation = {
	paused: boolean;
	elapsedSeconds: number;
	activeClipElapsedMs: number;
	recordedClips: RecordingSessionClip[];
};

export function useRecordingHudPresentation(
	recording: boolean,
	saving: boolean,
	presentation: RecordingPresentation,
) {
	const { paused, elapsedSeconds, activeClipElapsedMs, recordedClips } = presentation;
	const [lastRecording, setLastRecording] = useState(presentation);
	useLayoutEffect(() => {
		if (recording) {
			setLastRecording({ paused, elapsedSeconds, activeClipElapsedMs, recordedClips });
		}
	}, [recording, paused, elapsedSeconds, activeClipElapsedMs, recordedClips]);
	return {
		...(saving && !recording ? lastRecording : presentation),
		active: recording || saving,
	};
}
