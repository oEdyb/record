// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutDocument } from "../schema";
import { saveEditorDefaultPreferences } from "./editingPreferences";
import { DEFAULT_EDITOR_SETTINGS, getEditorSettings } from "./editorSettings";
import { getProjectMutationGeneration, useProjectStore } from "./projectStore";
import { redo, undo } from "./undo";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: toastMocks.error },
}));

const sampleDoc = {
	// ponytail: the bridge contract after the migration hoist is v6 — every
	// load site (DocumentService, browserShim) runs `migrateRawDocumentToCurrent`
	// before returning, and the renderer's `parseDocument` is a pure v6
	// validator. Test fixtures model the post-hoist contract.
	// `as const` and not a bare 7: the document type pins this field to the
	// LITERAL 7, and an unannotated object literal widens it to `number` — so
	// every `document: sampleDoc` below fails to type-check for a fixture that
	// is, in fact, exactly right.
	schemaVersion: 7 as const,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
	},
	assets: [],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
};

describe("useProjectStore", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) {
			mock.mockReset();
		}
		localStorage.clear();
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		toastMocks.error.mockReset();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI = { findRecordingCamera: vi.fn() };
	});

	afterEach(() => {
		vi.clearAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		delete (window as any).electronAPI;
	});

	it("createProject stores the returned document and bumps revision", async () => {
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });

		const doc = await useProjectStore.getState().createProject("Test");

		expect(doc.project.id).toBe("proj_test");
		const state = useProjectStore.getState();
		expect(state.projectId).toBe("proj_test");
		expect(state.document?.project.title).toBe("Test");
		expect(state.revision).toBe(1);
		expect(state.status).toBe("ready");
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});

	it("seeds a new project from the last committed editor settings", async () => {
		saveEditorDefaultPreferences({
			...DEFAULT_EDITOR_SETTINGS,
			padding: 27,
			showBlur: true,
			webcamMaskShape: "circle",
			cursor: { ...DEFAULT_EDITOR_SETTINGS.cursor, smoothing: 0.88 },
		});
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });

		const document = await useProjectStore.getState().createProject("Test");
		const settings = getEditorSettings(document);

		expect(settings.padding).toBe(27);
		expect(settings.showBlur).toBe(true);
		expect(settings.webcamMaskShape).toBe("circle");
		expect(settings.cursor.smoothing).toBe(0.88);
		expect(bridgeMocks.save).toHaveBeenCalledWith(document);
	});

	it("keeps a newly created project open when applying defaults cannot be saved", async () => {
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });

		await expect(useProjectStore.getState().createProject("Test")).resolves.toEqual(sampleDoc);

		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: sampleDoc,
			status: "ready",
		});
		await vi.waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(1));
	});

	it("does not publish an older save after a newer save starts", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		let finishFirst: ((result: unknown) => void) | undefined;
		let finishSecond: ((result: unknown) => void) | undefined;
		bridgeMocks.save
			.mockImplementationOnce(
				(document) =>
					new Promise((resolve) => {
						finishFirst = () => resolve({ success: true, document });
					}),
			)
			.mockImplementationOnce(
				(document) =>
					new Promise((resolve) => {
						finishSecond = () => resolve({ success: true, document });
					}),
			);
		const firstDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "First" },
		};
		const secondDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Second" },
		};

		const firstSave = useProjectStore.getState().saveDocument(firstDocument);
		const secondSave = useProjectStore.getState().saveDocument(secondDocument);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		finishFirst?.({});
		await expect(firstSave).resolves.toBe(false);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		finishSecond?.({});
		await expect(secondSave).resolves.toBe(true);

		expect(useProjectStore.getState().document?.project.title).toBe("Second");
	});

	it("rejects a background continuation after a user save starts", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const guard = {
			revision: 1,
			mutationGeneration: getProjectMutationGeneration("proj_test"),
		};
		let finishUserSave: ((result: unknown) => void) | undefined;
		bridgeMocks.save.mockImplementationOnce(
			(document) =>
				new Promise((resolve) => {
					finishUserSave = () => resolve({ success: true, document });
				}),
		);
		const userDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "User edit" },
		};
		const cameraDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Stale camera continuation" },
		};

		const userSave = useProjectStore.getState().saveDocumentAsEdit(userDocument);
		const cameraSave = useProjectStore.getState().saveDocumentIfCurrent(cameraDocument, guard);

		await expect(cameraSave).resolves.toBe(false);
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		finishUserSave?.({});
		await expect(userSave).resolves.toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit");
	});

	it("rejects a background continuation after an asset mutation starts", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const guard = {
			revision: 1,
			mutationGeneration: getProjectMutationGeneration("proj_test"),
		};
		let finishRemoval: ((result: unknown) => void) | undefined;
		bridgeMocks.removeAsset.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRemoval = () => resolve({ document: sampleDoc });
				}),
		);
		const removal = useProjectStore.getState().removeAsset("asset-1");
		const cameraSave = useProjectStore.getState().saveDocumentIfCurrent(sampleDoc, guard);

		await expect(cameraSave).resolves.toBe(false);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		finishRemoval?.({});
		await expect(removal).resolves.toBeUndefined();
	});

	it("retries a background document patch against the latest user edit", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const completions: Array<(result: unknown) => void> = [];
		bridgeMocks.save.mockImplementation(
			(document) =>
				new Promise((resolve) => {
					completions.push(() => resolve({ success: true, document }));
				}),
		);

		const patching = useProjectStore.getState().applyDocumentPatch(
			"proj_test",
			(document) => ({
				...document,
				project: { ...document.project, title: `${document.project.title} + camera` },
			}),
			{ coalesceIntoHistory: true },
		);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		const userDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "User edit" },
		};
		const userSave = useProjectStore.getState().saveDocumentAsEdit(userDocument);
		completions[0]?.({});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		completions[1]?.({});
		await expect(userSave).resolves.toBe(true);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(3));
		completions[2]?.({});

		await expect(patching).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("User edit + camera");
	});

	it("coalesces a background patch into existing undo snapshots", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const userDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "User edit" },
		};
		await useProjectStore.getState().saveDocumentAsEdit(userDocument);

		await expect(
			useProjectStore.getState().applyDocumentPatch(
				"proj_test",
				(document) => ({
					...document,
					project: { ...document.project, title: `${document.project.title} + camera` },
				}),
				{ coalesceIntoHistory: true },
			),
		).resolves.toBe("applied");

		expect(useProjectStore.getState().document?.project.title).toBe("User edit + camera");
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test + camera");
		expect(undo()).toBe(false);
	});

	it("coalesces a no-op background patch into a pending redo snapshot", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const imported = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Imported" },
		};
		await useProjectStore.getState().saveDocumentAsEdit(imported);
		expect(undo()).toBe(true);

		const patch = (document: AxcutDocument) =>
			document.project.title === "Imported"
				? {
						...document,
						project: { ...document.project, title: "Imported + camera" },
					}
				: document;
		await expect(
			useProjectStore
				.getState()
				.applyDocumentPatch("proj_test", patch, { coalesceIntoHistory: true }),
		).resolves.toBe("unchanged");

		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Imported + camera");
	});

	it("retries one transactional edit patch and keeps a newer edit in its Undo snapshot", async () => {
		const pendingAsset = {
			id: "recording-asset",
			kind: "video" as const,
			label: "Recording",
			originalPath: "/tmp/recording.mp4",
			recordingImportId: "recording-1",
			cameraTrack: null,
		};
		const partialImport = { ...sampleDoc, assets: [pendingAsset] };
		const stripPartialImport = (document: AxcutDocument): AxcutDocument => ({
			...document,
			assets: document.assets.filter((asset) => asset.recordingImportId !== "recording-1"),
		});
		useProjectStore.setState({
			projectId: "proj_test",
			document: partialImport,
			revision: 1,
			status: "ready",
			error: null,
		});
		const completions: Array<(result: unknown) => void> = [];
		bridgeMocks.save.mockImplementation(
			(document) =>
				new Promise((resolve) => {
					completions.push(() => resolve({ success: true, document }));
				}),
		);

		const importing = useProjectStore.getState().applyDocumentPatch(
			"proj_test",
			(document) => ({
				...document,
				project: { ...document.project, title: `${document.project.title} + recording` },
			}),
			{
				createHistorySnapshot: stripPartialImport,
				normalizeHistorySnapshots: stripPartialImport,
			},
		);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		const userDocument = {
			...partialImport,
			project: { ...partialImport.project, title: "User edit" },
		};
		const userSave = useProjectStore.getState().saveDocumentAsEdit(userDocument);
		completions[0]?.({});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		completions[1]?.({});
		await expect(userSave).resolves.toBe(true);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(3));
		completions[2]?.({});

		await expect(importing).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("User edit + recording");
		expect(useProjectStore.getState().document?.assets).toEqual([pendingAsset]);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit");
		expect(useProjectStore.getState().document?.assets).toEqual([]);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(useProjectStore.getState().document?.assets).toEqual([]);
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit");
		expect(useProjectStore.getState().document?.assets).toEqual([]);
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit + recording");
		expect(useProjectStore.getState().document?.assets).toEqual([pendingAsset]);
	});

	it("waits for an in-flight asset mutation before applying a document patch", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		let finishRemoval: ((result: unknown) => void) | undefined;
		bridgeMocks.removeAsset.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRemoval = () =>
						resolve({
							document: {
								...sampleDoc,
								project: { ...sampleDoc.project, title: "After removal" },
							},
						});
				}),
		);

		const removal = useProjectStore.getState().removeAsset("asset-1");
		const patching = useProjectStore.getState().applyDocumentPatch("proj_test", (document) => ({
			...document,
			project: { ...document.project, title: `${document.project.title} + camera` },
		}));
		await Promise.resolve();
		expect(bridgeMocks.save).not.toHaveBeenCalled();

		finishRemoval?.({});
		await removal;
		await expect(patching).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("After removal + camera");
	});

	it("does not publish a completed save after the user switches projects", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		let finishSave: ((result: unknown) => void) | undefined;
		bridgeMocks.save.mockImplementationOnce(
			(document) =>
				new Promise((resolve) => {
					finishSave = () => resolve({ success: true, document });
				}),
		);
		const saving = useProjectStore.getState().saveDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Late save" },
		});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const otherDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_other", title: "Other" },
		};
		useProjectStore.setState({
			projectId: "proj_other",
			document: otherDocument,
			revision: 2,
		});

		finishSave?.({});
		await expect(saving).resolves.toBe(false);

		expect(useProjectStore.getState().projectId).toBe("proj_other");
		expect(useProjectStore.getState().document?.project.title).toBe("Other");
	});

	it("loadProject handles a failed bridge response by setting error status", async () => {
		bridgeMocks.get.mockResolvedValue({ success: false, error: "not found" });

		await useProjectStore.getState().loadProject("proj_x");

		const state = useProjectStore.getState();
		expect(state.status).toBe("error");
		expect(state.error).toBe("not found");
	});

	it("addAsset replaces the document and bumps revision", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const updatedDoc = {
			...sampleDoc,
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "screen.webm",
					originalPath: "/tmp/screen.webm",
				},
			],
			project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
		};
		bridgeMocks.addAsset.mockResolvedValue({ assetId: "asset_1", document: updatedDoc });

		const asset = await useProjectStore.getState().addAsset("/tmp/screen.webm");

		expect(asset?.id).toBe("asset_1");
		expect(useProjectStore.getState().revision).toBe(2);
		expect(useProjectStore.getState().document?.assets).toHaveLength(1);
	});

	it("addAsset resolves an independent camera for every asset added, not just the first", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockImplementation(async (path: string) => {
			if (path === "/tmp/screen1.webm") {
				return { success: true, webcamVideoPath: "/tmp/screen1-webcam.webm", offsetMs: 0 };
			}
			if (path === "/tmp/screen2.webm") {
				return { success: true, webcamVideoPath: "/tmp/screen2-webcam.webm", offsetMs: 0 };
			}
			return { success: false, error: "No camera attached to this recording" };
		});

		bridgeMocks.addAsset.mockResolvedValueOnce({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{
						id: "asset_1",
						kind: "video",
						label: "screen1.webm",
						originalPath: "/tmp/screen1.webm",
					},
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});
		const firstAsset = await useProjectStore.getState().addAsset("/tmp/screen1.webm");

		bridgeMocks.addAsset.mockResolvedValueOnce({
			assetId: "asset_2",
			document: {
				...useProjectStore.getState().document,
				assets: [
					...useProjectStore.getState().document!.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "screen2.webm",
						originalPath: "/tmp/screen2.webm",
					},
				],
			},
		});
		const secondAsset = await useProjectStore.getState().addAsset("/tmp/screen2.webm");

		const assets = useProjectStore.getState().document?.assets ?? [];
		expect(assets).toHaveLength(2);
		expect(assets.find((a) => a.id === "asset_1")?.cameraTrack?.sourcePath).toBe(
			"/tmp/screen1-webcam.webm",
		);
		expect(assets.find((a) => a.id === "asset_2")?.cameraTrack?.sourcePath).toBe(
			"/tmp/screen2-webcam.webm",
		);
		expect(firstAsset?.cameraTrack?.sourcePath).toBe("/tmp/screen1-webcam.webm");
		expect(secondAsset?.cameraTrack?.sourcePath).toBe("/tmp/screen2-webcam.webm");
	});

	it("addAsset links the camera when the recorder measured a sub-millisecond offset", async () => {
		// The native capture paths derive this from `performance.now()` (100 µs
		// resolution), so the offset is almost never a whole number — while
		// `cameraTrackSchema.offsetMs` is an int. Unrounded, the document failed
		// validation, the catch below treated it as a lookup failure, and a
		// recording that HAD a camera silently lost it.
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockResolvedValue({
			success: true,
			webcamVideoPath: "/tmp/screen-webcam.webm",
			offsetMs: -192.80000000447035,
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "screen.mp4", originalPath: "/tmp/screen.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/screen.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).not.toHaveBeenCalled();
		const camera = useProjectStore.getState().document?.assets[0]?.cameraTrack;
		expect(camera?.sourcePath).toBe("/tmp/screen-webcam.webm");
		expect(camera?.offsetMs).toBe(-193);
	});

	it("addAsset stays silent (no toast) when a plain imported video has no camera", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockResolvedValue({
			success: false,
			error: "No camera attached to this recording",
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "video.mp4", originalPath: "/tmp/video.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.assets[0]?.cameraTrack).toBeNull();
	});

	it("addAsset toasts when the camera lookup itself throws", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockRejectedValue(new Error("bridge exploded"));
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "video.mp4", originalPath: "/tmp/video.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).toHaveBeenCalledTimes(1);
		expect(toastMocks.error.mock.calls[0][0]).toContain("video.mp4");
	});

	it("removeAsset requires a loaded project", async () => {
		await expect(useProjectStore.getState().removeAsset("asset_x")).rejects.toThrow(
			"No project loaded",
		);
	});

	it("clear resets the store", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 5,
			status: "ready",
			error: null,
		});
		useProjectStore.getState().clear();
		expect(useProjectStore.getState()).toMatchObject({
			projectId: null,
			document: null,
			revision: 0,
			status: "idle",
			error: null,
		});
	});
});
