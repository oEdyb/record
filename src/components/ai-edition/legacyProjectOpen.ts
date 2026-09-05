import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { applyProbedDuration } from "@/lib/ai-edition/document/timeline";
import { probeVideoDuration } from "@/lib/ai-edition/timeline/duration";
import { toKlipptMediaUrl } from "@/lib/localMediaUrl";

/** Complete a legacy file before its first GUI save, independent of preview mounting. */
export async function prepareLegacyProjectForOpen(input: EditorProjectData) {
	let document = migrateProjectDataToAxcutDocument(input);
	for (const asset of document.assets) {
		// The project picker approves local media. The protocol checks that approval
		// again; a project value must never turn this probe into an arbitrary URL fetch.
		const duration = await probeVideoDuration(toKlipptMediaUrl(asset.originalPath));
		if (duration !== null) document = applyProbedDuration(document, asset.id, duration);
	}
	return document;
}
