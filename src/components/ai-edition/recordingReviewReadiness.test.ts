import { describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import {
	awaitRecordingReviewDocument,
	hasPendingRecordingHandoff,
} from "./recordingReviewReadiness";

function recordingDocument(projectId: string, duration: number): AxcutDocument {
	const empty = createEmptyDocument({ title: "Recording", projectId });
	return {
		...empty,
		assets: [
			{
				id: `${projectId}-asset`,
				kind: "video",
				label: "Recording",
				originalPath: `/recordings/${projectId}.mp4`,
				durationSec: duration,
				cameraTrack: null,
			},
		],
		timeline: {
			...empty.timeline,
			clips: [
				{
					id: `${projectId}-clip`,
					assetId: `${projectId}-asset`,
					sourceStartSec: 0,
					sourceEndSec: duration,
					timelineStartSec: 0,
					timelineEndSec: duration,
					wordRefs: [],
					origin: "system",
					reason: "Recorded clip",
				},
			],
		},
	};
}

function projectState(document: AxcutDocument) {
	return {
		document,
		projectId: document.project.id,
		status: "ready" as const,
		transactionBusy: false,
		transactionSyncPending: false,
	};
}

function depsFor(document: AxcutDocument) {
	return {
		refreshWorkspace: vi.fn(async () => false),
		getCurrentRecordingSession: vi.fn(async () => ({ success: false, session: null })),
		getProjectState: vi.fn(() => projectState(document)),
	};
}

describe("recording review readiness", () => {
	it("awaits the 2-second to 120-second handoff and returns the newly committed document", async () => {
		const oldDocument = recordingDocument("old", 2.1);
		const newDocument = recordingDocument("new", 120);
		const deps = depsFor(oldDocument);
		let finishRefresh: (() => void) | undefined;
		deps.refreshWorkspace.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					finishRefresh = () => resolve(true);
				}),
		);
		const ready = awaitRecordingReviewDocument(deps);
		expect(deps.getProjectState).not.toHaveBeenCalled();
		expect(deps.getCurrentRecordingSession).not.toHaveBeenCalled();
		deps.getProjectState.mockReturnValue(projectState(newDocument));
		finishRefresh?.();
		await expect(ready).resolves.toBe(newDocument);
		expect(deps.getProjectState).toHaveBeenCalledOnce();
	});

	it("reads the latest document after the main-process slot query finishes", async () => {
		const deps = depsFor(recordingDocument("old", 2.1));
		const latest = recordingDocument("new", 120);
		let confirmConsumed: (() => void) | undefined;
		deps.getCurrentRecordingSession.mockImplementation(
			() =>
				new Promise((resolve) => {
					confirmConsumed = () => resolve({ success: false, session: null });
				}),
		);
		const ready = awaitRecordingReviewDocument(deps);
		await Promise.resolve();
		expect(deps.getProjectState).not.toHaveBeenCalled();
		deps.getProjectState.mockReturnValue(projectState(latest));
		confirmConsumed?.();
		await expect(ready).resolves.toBe(latest);
	});

	it("fails closed when workspace refresh rejects instead of returning the old recording", async () => {
		const deps = depsFor(recordingDocument("old", 2.1));
		deps.refreshWorkspace.mockRejectedValue(new Error("Import failed"));
		await expect(awaitRecordingReviewDocument(deps)).resolves.toBeNull();
		expect(deps.getCurrentRecordingSession).not.toHaveBeenCalled();
		expect(deps.getProjectState).not.toHaveBeenCalled();
	});

	it("fails closed if a refresh reports success but the new recording remains unconsumed", async () => {
		const document = recordingDocument("old", 2.1);
		const deps = depsFor(document);
		const getCurrentRecordingSession = vi.fn(async () => ({
			success: true,
			session: { createdAt: 120, screenVideoPath: "/recordings/new.mp4" },
		}));
		deps.refreshWorkspace.mockResolvedValue(true);
		await expect(
			awaitRecordingReviewDocument({ ...deps, getCurrentRecordingSession }),
		).resolves.toBeNull();
		expect(deps.getProjectState).not.toHaveBeenCalled();
	});

	it("fails closed when the main-process handoff cannot be checked", async () => {
		const deps = depsFor(recordingDocument("old", 2.1));
		deps.getCurrentRecordingSession.mockRejectedValue(new Error("IPC failed"));
		await expect(awaitRecordingReviewDocument(deps)).resolves.toBeNull();
		expect(deps.getProjectState).not.toHaveBeenCalled();
	});

	it("allows an existing project when no recording is waiting", async () => {
		const existing = recordingDocument("existing", 2.1);
		await expect(awaitRecordingReviewDocument(depsFor(existing))).resolves.toBe(existing);
	});

	it.each([
		{ status: "loading" as const },
		{ status: "error" as const },
		{ transactionBusy: true },
		{ transactionSyncPending: true },
		{ projectId: "different-project" },
	])("rejects a project snapshot that is not committed and ready: %j", async (override) => {
		const document = recordingDocument("old", 2.1);
		const deps = depsFor(document);
		await expect(
			awaitRecordingReviewDocument({
				...deps,
				getProjectState: () => ({ ...projectState(document), ...override }),
			}),
		).resolves.toBeNull();
	});

	it("rejects a partial import with assets but no committed clips", async () => {
		const document = recordingDocument("partial", 120);
		document.timeline.clips = [];
		await expect(awaitRecordingReviewDocument(depsFor(document))).resolves.toBeNull();
	});

	it("rejects a clip whose imported media is still missing", async () => {
		const document = recordingDocument("partial", 120);
		document.timeline.clips[0].assetId = "not-imported-yet";
		await expect(awaitRecordingReviewDocument(depsFor(document))).resolves.toBeNull();
	});
});

describe("recording handoff ownership", () => {
	it("remains blocked after an import failure leaves the native session unconsumed", async () => {
		const getCurrentRecordingSession = vi.fn(async () => ({
			success: true,
			session: { createdAt: 120, screenVideoPath: "/recordings/new.mp4" },
		}));
		await expect(hasPendingRecordingHandoff(getCurrentRecordingSession)).resolves.toBe(true);
	});

	it("allows navigation only after the native slot is empty", async () => {
		await expect(
			hasPendingRecordingHandoff(async () => ({ success: false, session: null })),
		).resolves.toBe(false);
	});

	it("keeps an uncertain handoff blocked when its query fails", async () => {
		await expect(
			hasPendingRecordingHandoff(async () => {
				throw new Error("IPC failed");
			}),
		).resolves.toBe(true);
	});

	it("does not treat a canceled query as a consumed recording", async () => {
		await expect(
			hasPendingRecordingHandoff(async () => ({ success: false, canceled: true })),
		).resolves.toBe(true);
	});
});
