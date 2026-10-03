import path from "node:path";
import { documentSchema, migrateRawDocumentToCurrent } from "../../src/lib/ai-edition/schema";
import type { RecordingSession } from "../../src/lib/recordingSession";

/** Approve current-format assets through the same trusted-directory gate as legacy media. */
export async function approveCurrentProjectMedia(
	project: unknown,
	projectFilePath: string | undefined,
	recordingsDirectory: string,
	approve: (file: string, trusted: string[]) => Promise<string | null>,
	approveAudio?: (file: string, trusted: string[]) => Promise<string | null>,
): Promise<RecordingSession | null> {
	if (!project || typeof project !== "object" || !("schemaVersion" in project)) return null;
	const parsed = documentSchema.parse(migrateRawDocumentToCurrent(project));
	const trusted = [recordingsDirectory];
	if (projectFilePath) trusted.push(path.dirname(path.resolve(projectFilePath)));
	for (const asset of parsed.audioAssets ?? []) await approveAudio?.(asset.originalPath, trusted);
	let primary: RecordingSession | null = null;
	for (const asset of parsed.assets) {
		if (asset.kind !== "video") continue;
		const screenVideoPath = await approve(asset.originalPath, trusted);
		const webcamVideoPath = asset.cameraTrack?.sourcePath
			? await approve(asset.cameraTrack.sourcePath, trusted)
			: null;
		if (screenVideoPath && (!primary || asset.id === parsed.project.primaryAssetId)) {
			primary = {
				screenVideoPath,
				createdAt: Date.now(),
				...(webcamVideoPath ? { webcamVideoPath } : {}),
			};
		}
	}
	return primary;
}
