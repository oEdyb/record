import { RecordingReviewShell } from "./RecordingReviewShell";

// Klippt is recording-only: the editor window is the recording review shell.

export function AiEditionOrLegacy() {
	return <RecordingReviewShell />;
}

export default AiEditionOrLegacy;
