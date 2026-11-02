import { useScopedT } from "@/contexts/I18nContext";
import type { StudioSnapshot } from "../../../electron/studio/types";
import type { StudioSection } from "./studioTranscriptModel";

const MB = 1024 * 1024;
export function useStudioTranscriptStatus(
	snapshot: StudioSnapshot | null,
	sections: StudioSection[],
) {
	const t = useScopedT("launch");
	const phase = snapshot?.phase;
	const paused = phase === "paused";
	const status = (() => {
		const transcript = snapshot?.transcript;
		if (!transcript) return { text: "", tone: "info" as const };
		// The transcriber keeps its last take until it runs again; that one's news is old.
		const ours = transcript.recordingId === snapshot?.recordingId;
		if (ours && transcript.error) return { text: transcript.error, tone: "error" as const };
		if (ours && transcript.status === "downloading-model" && transcript.download)
			return {
				text: t("transcript.downloading", {
					done: Math.round(transcript.download.downloadedBytes / MB),
					total: Math.round(transcript.download.totalBytes / MB),
				}),
				tone: "info" as const,
			};
		// Nothing runs on its own without the speech model: offer it, never download unasked.
		if (
			(paused || phase === "review") &&
			(!ours || transcript.status === "idle") &&
			sections.some((s) => s.state === "waiting")
		)
			return {
				text: t("studio.notTranscribed"),
				tone: "info" as const,
				action: {
					label: t("studio.transcribeNow"),
					run: () => void window.electronAPI.refreshTranscript(),
				},
			};
		return { text: "", tone: "info" as const };
	})();

	return status;
}
