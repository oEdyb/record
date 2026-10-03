import type { AxcutDocument } from "@/lib/ai-edition/schema";
import type { ProjectState } from "@/lib/ai-edition/store/projectStore";

type ReviewProjectState = Pick<
	ProjectState,
	"document" | "projectId" | "status" | "transactionBusy" | "transactionSyncPending"
>;

export async function hasPendingRecordingHandoff(
	getCurrentRecordingSession: Window["electronAPI"]["getCurrentRecordingSession"],
): Promise<boolean> {
	try {
		const pending = await getCurrentRecordingSession();
		return Boolean(pending.success || pending.session != null || pending.canceled);
	} catch {
		return true;
	}
}

export async function awaitRecordingReviewDocument(deps: {
	refreshWorkspace: () => Promise<unknown>;
	getCurrentRecordingSession: Window["electronAPI"]["getCurrentRecordingSession"];
	getProjectState: () => ReviewProjectState;
}): Promise<AxcutDocument | null> {
	try {
		await deps.refreshWorkspace();
		// A warm review can still contain the previous recording while the new
		// handoff is importing. Its consumption, rather than the refresh boolean,
		// confirms the recording has reached a committed project document.
		if (await hasPendingRecordingHandoff(deps.getCurrentRecordingSession)) return null;
		const state = deps.getProjectState();
		const document = state.document;
		if (
			state.status !== "ready" ||
			state.transactionBusy ||
			state.transactionSyncPending ||
			!document ||
			!state.projectId ||
			state.projectId !== document.project.id ||
			document.assets.length === 0 ||
			document.timeline.clips.length === 0
		)
			return null;
		const assetIds = new Set(document.assets.map((asset) => asset.id));
		if (document.timeline.clips.some((clip) => !assetIds.has(clip.assetId))) return null;
		return document;
	} catch {
		// Import/query failures must not export an older document that happened
		// to be visible before this recording was handed back to the review.
		return null;
	}
}
