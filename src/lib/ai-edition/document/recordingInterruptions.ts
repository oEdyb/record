import { normalizeRecordingInterruption, type RecordingInterruption } from "../../recordingSession";
import type { AxcutDocument } from "../schema";

export function recordingInterruptions(document: AxcutDocument | null): RecordingInterruption[] {
	const stored = document?.legacyEditor?.recordingInterruptions;
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
	const activeAssets = new Set(document?.timeline.clips.map((clip) => clip.assetId));
	const activeImports = new Set(
		document?.assets
			.filter((asset) => activeAssets.has(asset.id))
			.map((asset) => asset.recordingImportId),
	);
	return Object.entries(stored).flatMap(([id, value]) => {
		const interruption = normalizeRecordingInterruption(value);
		return activeImports.has(id) && interruption ? [interruption] : [];
	});
}

export function withRecordingInterruption(
	document: AxcutDocument,
	importId: string,
	interruption: RecordingInterruption | undefined,
): AxcutDocument {
	if (!interruption) return document;
	const stored = document.legacyEditor?.recordingInterruptions;
	const existing = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
	return {
		...document,
		legacyEditor: {
			...document.legacyEditor,
			recordingInterruptions: { ...existing, [importId]: interruption },
		},
	};
}
