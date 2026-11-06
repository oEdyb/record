// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingInterruptions } from "@/lib/ai-edition/document/recordingInterruptions";
import { type AxcutAsset, type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { type ProjectState, useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { seedProjectState } from "@/lib/ai-edition/store/projectStore.testUtils";
import { toKlipptMediaUrl } from "@/lib/localMediaUrl";
import { importPendingRecording, isPendingRecordingImportInProgress } from "./recordingImport";

const getRecordingData = vi.hoisted(() => vi.fn());
const probeVideoDuration = vi.hoisted(() => vi.fn());
const probeVideoDimensions = vi.hoisted(() => vi.fn());

// The store's own bridge calls are never reached — every project action the
// import uses is stubbed below. Cursor recording data is read directly because
// automatic direction is part of the same import action.
vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: {}, cursor: { getRecordingData } },
}));
vi.mock("@/lib/ai-edition/timeline/duration", () => ({ probeVideoDuration, probeVideoDimensions }));

const createProject = vi.fn<ProjectState["createProject"]>(async (title) => {
	const document = createEmptyDocument({ title, projectId: "test-project" });
	seedProjectState({ projectId: document.project.id, document });
	return document;
});
const addAsset = vi.fn<ProjectState["addAsset"]>(async () => null);
const replaceTimeline = vi.fn(async () => undefined);
const saveDocument = vi.fn<ProjectState["saveDocument"]>(async () => true);
const saveDocumentAsEdit = vi.fn<ProjectState["saveDocumentAsEdit"]>(async () => true);
const applyDocumentPatch = vi.fn<ProjectState["applyDocumentPatch"]>(async (projectId, patch) => {
	const current = useProjectStore.getState().document;
	if (!current || current.project.id !== projectId) return "project-changed";
	const document = patch(current);
	if (document === current) return "unchanged";
	seedProjectState({ document });
	return "applied";
});
const loadProject = vi.fn<ProjectState["loadProject"]>(async () => undefined);

/** Stands in for the main-process recording slot: one value, set and read. */
function setElectronApi(api: unknown) {
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		writable: true,
		value: api,
	});
}

function stubElectronApi(screenVideoPath: string | null) {
	let session = screenVideoPath ? { screenVideoPath, createdAt: 0 } : null;
	const api = {
		getCurrentRecordingSession: vi.fn(async () =>
			session ? { success: true, session } : { success: false },
		),
		setCurrentRecordingSession: vi.fn(async (next: typeof session) => {
			session = next;
			return { success: true };
		}),
	};
	setElectronApi(api);
	return api;
}

describe("importPendingRecording", () => {
	it("persists native originals and their actual per-source offsets on imported assets", async () => {
		const clip = {
			index: 0,
			screenVideoPath: "/screen.mp4",
			durationMs: 1000,
			webcamVideoPath: "/camera.mov",
			webcamOffsetMs: 0,
			microphoneAudioPath: "/mic.m4a",
			microphoneAudioOffsetMs: 23.5,
			systemAudioPath: "/system.m4a",
			systemAudioOffsetMs: 4,
		};
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({
				success: true,
				session: {
					screenVideoPath: clip.screenVideoPath,
					createdAt: 7,
					interruption: { code: "writer-failed", message: "Recording stopped early." },
					schemaVersion: 2,
					clips: [clip],
				},
			})),
			setCurrentRecordingSession: vi.fn(async () => ({ success: true })),
		});
		addAsset.mockImplementationOnce(async () => {
			const asset: AxcutAsset = {
				id: "asset_native",
				recordingImportId: "recording-7",
				kind: "video",
				label: "Recorded",
				originalPath: clip.screenVideoPath,
				cameraTrack: null,
			};
			const document = useProjectStore.getState().document!;
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		await importPendingRecording();
		expect(recordingInterruptions(useProjectStore.getState().document)).toEqual([
			{ code: "writer-failed", message: "Recording stopped early." },
		]);
		expect(useProjectStore.getState().document?.assets[0]).toMatchObject({
			cameraTrack: { sourcePath: clip.webcamVideoPath, offsetMs: 0 },
			microphoneAudioPath: clip.microphoneAudioPath,
			microphoneAudioOffsetMs: 23.5,
			systemAudioPath: clip.systemAudioPath,
			systemAudioOffsetMs: 4,
		});
	});
	beforeEach(() => {
		vi.clearAllMocks();
		probeVideoDuration.mockResolvedValue(null);
		probeVideoDimensions.mockResolvedValue(null);
		getRecordingData.mockResolvedValue({ version: 2, provider: "native", samples: [], assets: [] });
		saveDocumentAsEdit.mockImplementation(async (document) => {
			seedProjectState({ document });
			return true;
		});
		applyDocumentPatch.mockImplementation(async (projectId, patch) => {
			const current = useProjectStore.getState().document;
			if (!current || current.project.id !== projectId) return "project-changed";
			const document = patch(current);
			if (document === current) return "unchanged";
			seedProjectState({ document });
			return "applied";
		});
		seedProjectState({
			document: null,
			revision: 0,
			createProject,
			addAsset,
			replaceTimeline,
			saveDocument,
			saveDocumentAsEdit,
			applyDocumentPatch,
			loadProject,
		});
	});

	it("does nothing when no recording is waiting", async () => {
		stubElectronApi(null);
		await expect(importPendingRecording()).resolves.toBe(false);
		expect(createProject).not.toHaveBeenCalled();
	});

	it("imports the recording into a new project and consumes the hand-off", async () => {
		const api = stubElectronApi("C:\\recordings\\recording-1.mp4");

		await expect(importPendingRecording()).resolves.toBe(true);

		expect(createProject).toHaveBeenCalledTimes(1);
		expect(addAsset).toHaveBeenCalledWith("C:\\recordings\\recording-1.mp4", "recording-1.mp4", {
			recordingImportId: "recording-0",
		});
		expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(null);
	});

	// The regression: the editor window is destroyed and recreated on every open,
	// so a session left in the slot was imported again — a second project on the
	// same recording, at default settings, with the user's saved ones stranded in
	// the first one.
	it("imports one recording once, however often the editor mounts", async () => {
		stubElectronApi("C:\\recordings\\recording-1.mp4");

		await importPendingRecording();
		await expect(importPendingRecording()).resolves.toBe(false);

		expect(createProject).toHaveBeenCalledTimes(1);
		expect(addAsset).toHaveBeenCalledTimes(1);
	});

	it("uses the first recording's actual shape instead of remembered framing", async () => {
		stubElectronApi("/recordings/wide.mp4");
		const asset: AxcutAsset = {
			id: "wide",
			kind: "video",
			label: "Wide",
			originalPath: "/recordings/wide.mp4",
			durationSec: 2,
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			const document = useProjectStore.getState().document!;
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		probeVideoDimensions.mockResolvedValueOnce({ width: 1920, height: 1200 });
		await expect(importPendingRecording()).resolves.toBe(true);
		expect(getEditorSettings(useProjectStore.getState().document).aspectRatio).toBe("8:5");
		expect(useProjectStore.getState().document?.zoomRanges).toEqual([]);
	});

	it("awaits the full raw recording duration before committing and consuming its handoff", async () => {
		const screenPath = "/recordings/two-minute-recording.mp4";
		const api = stubElectronApi(screenPath);
		const asset: AxcutAsset = {
			id: "two-minute-asset",
			kind: "video",
			label: "Two-minute recording",
			originalPath: screenPath,
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			const document = useProjectStore.getState().document!;
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		let resolveDuration!: (duration: number) => void;
		probeVideoDuration.mockImplementationOnce(
			() =>
				new Promise<number>((resolve) => {
					resolveDuration = resolve;
				}),
		);
		const importing = importPendingRecording();
		await vi.waitFor(() => {
			expect(probeVideoDuration).toHaveBeenCalledWith(toKlipptMediaUrl(screenPath), 5_000);
		});
		expect(isPendingRecordingImportInProgress()).toBe(true);
		expect(applyDocumentPatch).not.toHaveBeenCalled();
		expect(api.setCurrentRecordingSession).not.toHaveBeenCalledWith(null);
		resolveDuration(120.081667);
		await expect(importing).resolves.toBe(true);
		const document = useProjectStore.getState().document!;
		expect(document.assets[0].durationSec).toBe(120.081667);
		expect(document.timeline.clips[0]).toMatchObject({
			sourceStartSec: 0,
			sourceEndSec: 120.081667,
			timelineStartSec: 0,
			timelineEndSec: 120.081667,
		});
		expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(null);
		expect(isPendingRecordingImportInProgress()).toBe(false);
	});

	it.each([
		null,
		0,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("keeps the raw recording handoff parked when its duration probe returns %s", async (duration) => {
		const screenPath = "/recordings/unreadable-duration.mp4";
		const api = stubElectronApi(screenPath);
		const asset: AxcutAsset = {
			id: "unreadable-duration-asset",
			kind: "video",
			label: "Recording",
			originalPath: screenPath,
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			const document = useProjectStore.getState().document!;
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		probeVideoDuration.mockResolvedValueOnce(duration);
		await expect(importPendingRecording()).rejects.toThrow("Could not read the recording duration");
		expect(api.setCurrentRecordingSession).not.toHaveBeenCalledWith(null);
		await expect(api.getCurrentRecordingSession()).resolves.toMatchObject({ success: true });
		expect(applyDocumentPatch).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.timeline.clips).toEqual([]);
		expect(isPendingRecordingImportInProgress()).toBe(false);
	});

	it("seeds a placeholder clip when the imported asset has none", async () => {
		stubElectronApi("/recordings/recording-1.webm");
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
			seedProjectState({
				document: {
					...document,
					assets: [
						{
							id: "a1",
							kind: "video",
							label: "Recording",
							originalPath: "/recordings/recording-1.webm",
							cameraTrack: null,
						},
					],
				},
			});
			return null;
		});

		await importPendingRecording();

		expect(replaceTimeline).toHaveBeenCalledWith(
			[{ startSec: 0, endSec: 60 }],
			"Auto-imported recording",
		);
	});

	it("imports kept clip-native files as ordered adjacent timeline clips", async () => {
		let session = {
			screenVideoPath: "/recordings/recording-1-clip-0001.mp4",
			createdAt: 0,
			schemaVersion: 2 as const,
			clips: [
				{ index: 0, screenVideoPath: "/recordings/recording-1-clip-0001.mp4", durationMs: 1500 },
				{
					index: 1,
					screenVideoPath: "/recordings/recording-1-clip-0002.mp4",
					durationMs: 800,
					removed: true,
				},
				{ index: 2, screenVideoPath: "/recordings/recording-1-clip-0003.mp4", durationMs: 2250 },
			],
		};
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
		});

		addAsset
			.mockImplementationOnce(async () => {
				expect(isPendingRecordingImportInProgress()).toBe(true);
				const asset: AxcutAsset = {
					id: "asset_1",
					kind: "video",
					label: "Clip 1",
					originalPath: session.clips[0].screenVideoPath,
					cameraTrack: {
						sourcePath: "/recordings/recording-1-webcam.webm",
						startMs: 0,
						offsetMs: -250,
						visible: true,
					},
				};
				const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
				seedProjectState({
					document: {
						...document,
						assets: [asset],
					},
				});
				return asset;
			})
			.mockImplementationOnce(async () => {
				const asset: AxcutAsset = {
					id: "asset_3",
					kind: "video",
					label: "Clip 3",
					originalPath: session.clips[2].screenVideoPath,
					cameraTrack: {
						sourcePath: "/recordings/recording-1-webcam.webm",
						startMs: 0,
						offsetMs: -250,
						visible: true,
					},
				};
				const document = useProjectStore.getState().document;
				if (!document) throw new Error("Expected the first imported clip document");
				seedProjectState({
					document: { ...document, assets: [...document.assets, asset] },
				});
				return asset;
			});

		await expect(importPendingRecording()).resolves.toBe(true);
		expect(isPendingRecordingImportInProgress()).toBe(false);

		expect(addAsset).toHaveBeenCalledTimes(2);
		const saved = useProjectStore.getState().document!;
		expect(saved.timeline.clips).toMatchObject([
			{ assetId: "asset_1", timelineStartSec: 0, timelineEndSec: 1.5 },
			{ assetId: "asset_3", timelineStartSec: 1.5, timelineEndSec: 3.75 },
		]);
		expect(saved.assets.find((asset) => asset.id === "asset_1")?.cameraTrack?.offsetMs).toBe(-250);
		// The webcam is one continuous recording. Clip 3 starts after both prior
		// screen clips, including the removed one, so it must seek past 2.3 seconds.
		expect(saved.assets.find((asset) => asset.id === "asset_3")?.cameraTrack?.offsetMs).toBe(
			-2_550,
		);
	});

	it("keeps per-clip camera files at their own offsets instead of shifting them by earlier clips", async () => {
		// macOS records one camera file per clip, named after the clip. Each starts with its
		// own clip, so seeking past earlier clips (the continuous-file rule) put the camera
		// tens of seconds off in a real multi-clip recording.
		let session = {
			screenVideoPath: "/recordings/recording-1-clip-0001.mp4",
			createdAt: 0,
			schemaVersion: 2 as const,
			clips: [
				{ index: 0, screenVideoPath: "/recordings/recording-1-clip-0001.mp4", durationMs: 1500 },
				{
					index: 1,
					screenVideoPath: "/recordings/recording-1-clip-0002.mp4",
					durationMs: 800,
					removed: true,
				},
				{ index: 2, screenVideoPath: "/recordings/recording-1-clip-0003.mp4", durationMs: 2250 },
			],
		};
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
		});

		addAsset
			.mockImplementationOnce(async () => {
				const asset: AxcutAsset = {
					id: "asset_1",
					kind: "video",
					label: "Clip 1",
					originalPath: session.clips[0].screenVideoPath,
					cameraTrack: {
						sourcePath: "/recordings/recording-1-clip-0001-webcam.webm",
						startMs: 0,
						offsetMs: -219,
						visible: true,
					},
				};
				const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
				seedProjectState({ document: { ...document, assets: [asset] } });
				return asset;
			})
			.mockImplementationOnce(async () => {
				const asset: AxcutAsset = {
					id: "asset_3",
					kind: "video",
					label: "Clip 3",
					originalPath: session.clips[2].screenVideoPath,
					cameraTrack: {
						sourcePath: "/recordings/recording-1-clip-0003-webcam.webm",
						startMs: 0,
						offsetMs: -180,
						visible: true,
					},
				};
				const document = useProjectStore.getState().document;
				if (!document) throw new Error("Expected the first imported clip document");
				seedProjectState({
					document: { ...document, assets: [...document.assets, asset] },
				});
				return asset;
			});

		await expect(importPendingRecording()).resolves.toBe(true);

		const saved = useProjectStore.getState().document!;
		expect(saved.assets.find((asset) => asset.id === "asset_1")?.cameraTrack?.offsetMs).toBe(-219);
		expect(saved.assets.find((asset) => asset.id === "asset_3")?.cameraTrack?.offsetMs).toBe(-180);
	});

	it("probes a crash-recovered clip before it writes the timeline", async () => {
		const screenVideoPath = "/recordings/recording-9-clip-0001.mp4";
		let session = {
			screenVideoPath,
			createdAt: 9,
			schemaVersion: 2 as const,
			clips: [
				{
					index: 0,
					screenVideoPath,
					durationMs: 60_000,
					provisionalDuration: true,
				},
			],
		};
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
		});
		probeVideoDuration.mockResolvedValueOnce(2.75);
		addAsset.mockImplementationOnce(async () => {
			const document = useProjectStore.getState().document;
			if (!document) throw new Error("Expected a recording import project");
			const asset: AxcutAsset = {
				id: "recovered-asset",
				kind: "video",
				label: "Recovered clip",
				originalPath: screenVideoPath,
				cameraTrack: null,
			};
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});

		await expect(importPendingRecording()).resolves.toBe(true);

		expect(probeVideoDuration).toHaveBeenCalledWith(
			toKlipptMediaUrl("/recordings/recording-9-clip-0001.mp4"),
			5_000,
		);
		const document = useProjectStore.getState().document;
		expect(document?.timeline.clips).toMatchObject([
			{ sourceEndSec: 2.75, timelineStartSec: 0, timelineEndSec: 2.75 },
		]);
		expect(document?.assets[0]?.durationSec).toBe(2.75);
		expect(getRecordingData).not.toHaveBeenCalled();
	});

	it("keeps a crash recovery handoff when its real duration cannot be read", async () => {
		const screenVideoPath = "/recordings/recording-10-clip-0001.mp4";
		let session = {
			screenVideoPath,
			createdAt: 10,
			schemaVersion: 2 as const,
			clips: [
				{
					index: 0,
					screenVideoPath,
					durationMs: 60_000,
					provisionalDuration: true,
				},
			],
		};
		const setCurrentRecordingSession = vi.fn(async (next) => {
			session = next as typeof session;
			return { success: true };
		});
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession,
		});

		await expect(importPendingRecording()).rejects.toThrow(
			"Could not read the recovered clip duration",
		);
		expect(setCurrentRecordingSession).not.toHaveBeenCalledWith(null);
	});

	it("keeps the handoff when durable journal cleanup fails", async () => {
		let session = { screenVideoPath: "/recordings/recording-11.mp4", createdAt: 11 };
		const setCurrentRecordingSession = vi.fn(async (next: typeof session | null) => {
			if (next === null) return { success: false, error: "journal unlink failed" };
			session = next;
			return { success: true };
		});
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession,
		});

		await expect(importPendingRecording()).rejects.toThrow(
			"Could not consume the recording recovery handoff: journal unlink failed",
		);
		expect(session).toEqual({
			screenVideoPath: "/recordings/recording-11.mp4",
			createdAt: 11,
			importProjectId: "test-project",
		});
	});

	it("keeps recordings raw even when clicks could generate automatic direction", async () => {
		const screenVideoPath = "/recordings/directed-clip.mp4";
		let session = {
			screenVideoPath,
			createdAt: 7,
			schemaVersion: 2 as const,
			clips: [{ index: 0, screenVideoPath, durationMs: 5_000 }],
		};
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
		});
		const asset: AxcutAsset = {
			id: "directed-asset",
			kind: "video",
			label: "Directed clip",
			originalPath: screenVideoPath,
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		getRecordingData.mockResolvedValueOnce({
			version: 2,
			provider: "native",
			assets: [],
			samples: [
				{ timeMs: 1_500, cx: 0.2, cy: 0.5, interactionType: "move" },
				{ timeMs: 2_000, cx: 0.6, cy: 0.4, interactionType: "click" },
				{ timeMs: 2_800, cx: 0.6, cy: 0.4, interactionType: "move" },
			],
		});

		await importPendingRecording();

		expect(getRecordingData).not.toHaveBeenCalled();
		const saved = useProjectStore.getState().document!;
		expect(saved.zoomRanges).toEqual([]);
		expect(saved.timeline.trimRanges).toEqual([]);
		expect(getRecordingData).not.toHaveBeenCalled();
	});

	it("keeps rapid click chains unedited on import", async () => {
		const screenVideoPath = "/recordings/connected-clicks.mp4";
		let session = {
			screenVideoPath,
			createdAt: 8,
			schemaVersion: 2 as const,
			clips: [{ index: 0, screenVideoPath, durationMs: 8_000 }],
		};
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
		});
		const asset: AxcutAsset = {
			id: "connected-asset",
			kind: "video",
			label: "Connected clicks",
			originalPath: screenVideoPath,
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		getRecordingData.mockResolvedValueOnce({
			version: 2,
			provider: "native",
			assets: [],
			samples: [
				{ timeMs: 1_500, cx: 0.75, cy: 0.45, interactionType: "move" },
				{ timeMs: 2_000, cx: 0.75, cy: 0.45, interactionType: "click" },
				{ timeMs: 2_600, cx: 0.5, cy: 0.45, interactionType: "move" },
				{ timeMs: 3_200, cx: 0.25, cy: 0.45, interactionType: "click" },
				{ timeMs: 3_800, cx: 0.5, cy: 0.5, interactionType: "move" },
				{ timeMs: 4_400, cx: 0.75, cy: 0.55, interactionType: "click" },
				{ timeMs: 5_200, cx: 0.75, cy: 0.55, interactionType: "move" },
			],
		});

		await importPendingRecording();

		const saved = useProjectStore.getState().document!;
		expect(saved.zoomRanges).toEqual([]);
		expect(saved.timeline.trimRanges).toEqual([]);
		expect(getRecordingData).not.toHaveBeenCalled();
	});

	it("keeps typing unedited on import", async () => {
		const screenVideoPath = "/recordings/typing-focus.mp4";
		let session = {
			screenVideoPath,
			createdAt: 81,
			schemaVersion: 2 as const,
			clips: [{ index: 0, screenVideoPath, durationMs: 6_000 }],
		};
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
		});
		const asset: AxcutAsset = {
			id: "typing-asset",
			kind: "video",
			label: "Typing focus",
			originalPath: screenVideoPath,
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		getRecordingData.mockResolvedValueOnce({
			version: 3,
			provider: "native",
			assets: [],
			samples: Array.from({ length: 25 }, (_, index) => ({
				timeMs: index * 250,
				cx: 0.62,
				cy: 0.42,
				interactionType: "move" as const,
			})),
			keyboardActivity: [
				{ timeMs: 1_500, cx: 0.62, cy: 0.42, count: 1 },
				{ timeMs: 1_800, cx: 0.63, cy: 0.42, count: 1 },
				{ timeMs: 2_100, cx: 0.64, cy: 0.42, count: 1 },
			],
		});

		await importPendingRecording();

		const saved = useProjectStore.getState().document!;
		expect(saved.zoomRanges).toEqual([]);
		expect(saved.timeline.trimRanges).toEqual([]);
		expect(getRecordingData).not.toHaveBeenCalled();
	});

	it("keeps camera recordings raw without analyzing the microphone", async () => {
		const screenVideoPath = "/recordings/camera-emphasis.mp4";
		let session = {
			screenVideoPath,
			createdAt: 9,
			schemaVersion: 2 as const,
			clips: [{ index: 0, screenVideoPath, durationMs: 10_000 }],
		};
		const peaks = new Float32Array(4_000);
		for (let block = 200; block < 1_800; block += 1) {
			const amplitude = block % 40 < 10 ? 0.11 : block % 30 < 10 ? 0.065 : 0.035;
			peaks[block * 2] = -amplitude;
			peaks[block * 2 + 1] = amplitude;
		}
		const getAudioPeaks = vi.fn(async () => ({ success: true, peaks }));
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
			getAudioPeaks,
		});
		const asset: AxcutAsset = {
			id: "camera-asset",
			kind: "video",
			label: "Camera clip",
			originalPath: screenVideoPath,
			cameraTrack: {
				sourcePath: "/recordings/camera-emphasis-webcam.mp4",
				startMs: 0,
				offsetMs: 0,
				visible: true,
			},
		};
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		getRecordingData.mockResolvedValueOnce({
			version: 2,
			provider: "native",
			assets: [],
			samples: Array.from({ length: 41 }, (_, index) => ({
				timeMs: index * 250,
				cx: 0.8,
				cy: 0.7,
				interactionType: "move" as const,
			})),
		});

		await importPendingRecording();

		expect(getAudioPeaks).not.toHaveBeenCalled();
		expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
		const saved = useProjectStore.getState().document!;
		expect(saved.legacyEditor?.cameraFullscreenRegions ?? []).toEqual([]);
		expect(saved.assets[0].cameraTrack).toEqual(asset.cameraTrack);
	});

	it("keeps a camera-linked single-file recording raw", async () => {
		const screenVideoPath = "/recordings/single-file-camera.mp4";
		let session = { screenVideoPath, createdAt: 10 };
		const peaks = new Float32Array(4_000);
		for (let block = 200; block < 1_800; block += 1) {
			const amplitude = block % 40 < 10 ? 0.11 : block % 30 < 10 ? 0.065 : 0.035;
			peaks[block * 2] = -amplitude;
			peaks[block * 2 + 1] = amplitude;
		}
		const getAudioPeaks = vi.fn(async () => ({ success: true, peaks }));
		setElectronApi({
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
			getAudioPeaks,
		});
		const asset: AxcutAsset = {
			id: "single-camera-asset",
			kind: "video",
			label: "Single camera recording",
			originalPath: screenVideoPath,
			durationSec: 10,
			cameraTrack: {
				sourcePath: "/recordings/single-file-camera-webcam.mp4",
				startMs: 0,
				offsetMs: 0,
				visible: true,
			},
		};
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		getRecordingData.mockResolvedValueOnce({
			version: 2,
			provider: "native",
			assets: [],
			samples: Array.from({ length: 41 }, (_, index) => ({
				timeMs: index * 250,
				cx: 0.8,
				cy: 0.7,
				interactionType: "move" as const,
			})),
		});

		await importPendingRecording();

		expect(getAudioPeaks).not.toHaveBeenCalled();
		expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
		const saved = useProjectStore.getState().document!;
		expect(saved.timeline.clips).toMatchObject([
			{ id: "clip_recording_10_1", assetId: "single-camera-asset", timelineEndSec: 10 },
		]);
		expect(saved.legacyEditor?.cameraFullscreenRegions ?? []).toEqual([]);
		expect(saved.assets[0].cameraTrack).toEqual(asset.cameraTrack);
	});

	it("imports the recording when cursor telemetry never responds", async () => {
		vi.useFakeTimers();
		try {
			const screenVideoPath = "/recordings/hung-direction.mp4";
			let session = {
				screenVideoPath,
				createdAt: 8,
				schemaVersion: 2 as const,
				clips: [{ index: 0, screenVideoPath, durationMs: 5_000 }],
			};
			const api = {
				getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
				setCurrentRecordingSession: vi.fn(async (next) => {
					session = next as typeof session;
					return { success: true };
				}),
			};
			setElectronApi(api);
			const asset: AxcutAsset = {
				id: "hung-asset",
				kind: "video",
				label: "Hung direction",
				originalPath: screenVideoPath,
				cameraTrack: null,
			};
			addAsset.mockImplementationOnce(async () => {
				const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
				seedProjectState({ document: { ...document, assets: [asset] } });
				return asset;
			});
			getRecordingData.mockReturnValueOnce(new Promise(() => undefined));

			const importing = importPendingRecording();
			await vi.advanceTimersByTimeAsync(0);
			expect(getRecordingData).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(500);

			await expect(importing).resolves.toBe(true);
			expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
			expect(useProjectStore.getState().document?.zoomRanges).toEqual([]);
			expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(null);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rebases clip insertion on the latest document at commit", async () => {
		const screenVideoPath = "/recordings/rebased-import.mp4";
		let session = {
			screenVideoPath,
			createdAt: 18,
			schemaVersion: 2 as const,
			clips: [{ index: 0, screenVideoPath, durationMs: 2_000 }],
		};
		const api = {
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
		};
		setElectronApi(api);
		const asset: AxcutAsset = {
			id: "rebased-asset",
			kind: "video",
			label: "Rebased clip",
			originalPath: screenVideoPath,
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ title: "Before edit", projectId: "test-project" });
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});
		applyDocumentPatch.mockImplementationOnce(async (projectId, patch) => {
			const current = useProjectStore.getState().document!;
			const latest = { ...current, project: { ...current.project, title: "Edited before commit" } };
			expect(projectId).toBe(latest.project.id);
			seedProjectState({ document: patch(latest) });
			return "applied";
		});
		const importing = importPendingRecording();

		await expect(importing).resolves.toBe(true);
		const saved = useProjectStore.getState().document!;
		expect(saved.project.title).toBe("Edited before commit");
		expect(saved.timeline.clips).toMatchObject([{ id: "clip_recording_18_1" }]);
	});

	it("keeps the handoff and reuses one orphan asset when a conflicted import retries", async () => {
		const screenVideoPath = "/recordings/conflicted-import.mp4";
		const interruption = { code: "capture-stop-failed", message: "Capture stopped early." };
		let session = { screenVideoPath, createdAt: 19, interruption };
		let workspace = {
			origin: "editor" as const,
			projectId: "test-project",
			insertionTimeSec: 0,
			currentTimeSec: 0,
			mode: "edit" as const,
			inspectorOpen: true,
			facet: "effects" as const,
		};
		const api = {
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next: typeof session | null) => {
				session = next as typeof session;
				return { success: true };
			}),
			getRecordingWorkspaceContext: vi.fn(async () => ({ success: true, context: workspace })),
			setRecordingWorkspaceContext: vi.fn(async () => {
				workspace = null as never;
				return { success: true };
			}),
		};
		setElectronApi(api);
		const beforeImport = createEmptyDocument({ title: "Conflict", projectId: "test-project" });
		let persisted = beforeImport;
		loadProject.mockImplementation(async () => {
			seedProjectState({ projectId: "test-project", document: persisted });
		});
		const asset: AxcutAsset = {
			id: "conflicted-asset",
			kind: "video",
			label: "conflicted-import.mp4",
			originalPath: screenVideoPath,
			recordingImportId: "recording-19",
			durationSec: 2,
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			persisted = {
				...beforeImport,
				assets: [asset],
				project: { ...beforeImport.project, primaryAssetId: asset.id },
			};
			seedProjectState({ document: persisted });
			return asset;
		});
		applyDocumentPatch.mockResolvedValueOnce("conflict");

		await expect(importPendingRecording()).rejects.toThrow(
			"The project kept changing while the recording clips were being inserted",
		);
		expect(api.setCurrentRecordingSession).not.toHaveBeenCalledWith(null);
		await expect(api.getCurrentRecordingSession()).resolves.toMatchObject({ success: true });

		await expect(importPendingRecording()).resolves.toBe(true);

		expect(addAsset).toHaveBeenCalledTimes(1);
		const imported = useProjectStore.getState().document!;
		expect(imported.assets).toEqual([asset]);
		expect(recordingInterruptions(imported)).toEqual([interruption]);
		expect(imported.timeline.clips).toMatchObject([
			{ id: "clip_recording_19_1", assetId: asset.id },
		]);
		const createHistorySnapshot = applyDocumentPatch.mock.calls[1][2]?.createHistorySnapshot;
		expect(createHistorySnapshot?.(persisted)).toEqual(beforeImport);
		expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(null);
	});

	it("opens the imported timeline without waiting for microphone analysis", async () => {
		const screenVideoPath = "/recordings/slow-microphone.mp4";
		let session = {
			screenVideoPath,
			createdAt: 12,
			schemaVersion: 2 as const,
			clips: [{ index: 0, screenVideoPath, durationMs: 10_000 }],
		};
		let finishMicrophone: ((value: { success: true; peaks: null }) => void) | undefined;
		const getAudioPeaks = vi.fn(
			() =>
				new Promise<{ success: true; peaks: null }>((resolve) => {
					finishMicrophone = resolve;
				}),
		);
		const api = {
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
			getAudioPeaks,
		};
		setElectronApi(api);
		const asset: AxcutAsset = {
			id: "slow-camera-asset",
			kind: "video",
			label: "Slow camera clip",
			originalPath: screenVideoPath,
			cameraTrack: {
				sourcePath: "/recordings/slow-microphone-webcam.mp4",
				startMs: 0,
				offsetMs: 0,
				visible: true,
			},
		};
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ title: "Test", projectId: "test-project" });
			seedProjectState({ document: { ...document, assets: [asset] } });
			return asset;
		});

		await expect(importPendingRecording()).resolves.toBe(true);

		expect(getAudioPeaks).not.toHaveBeenCalled();
		expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
		expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(null);
		seedProjectState({ revision: 1 });
		finishMicrophone?.({ success: true, peaks: null });
		await Promise.resolve();
		expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
	});

	it("inserts new recording sections into the project and moves later edits with their clips", async () => {
		const base = createEmptyDocument({ title: "Existing", projectId: "existing-project" });
		const existing: AxcutDocument = {
			...base,
			assets: [
				{
					id: "old-asset",
					kind: "video",
					label: "Existing recording",
					originalPath: "/recordings/existing.mp4",
					durationSec: 10,
					cameraTrack: null,
				},
			],
			timeline: {
				...base.timeline,
				clips: [
					{
						id: "old-1",
						assetId: "old-asset",
						sourceStartSec: 0,
						sourceEndSec: 5,
						timelineStartSec: 0,
						timelineEndSec: 5,
						wordRefs: [],
						origin: "user",
						reason: "",
					},
					{
						id: "old-2",
						assetId: "old-asset",
						sourceStartSec: 5,
						sourceEndSec: 10,
						timelineStartSec: 5,
						timelineEndSec: 10,
						wordRefs: [],
						origin: "user",
						reason: "",
					},
				],
			},
			zoomRanges: [
				{
					id: "zoom-later",
					startMs: 5_000,
					endMs: 6_000,
					clipId: "old-2",
					sourceStartSec: 5,
					sourceEndSec: 6,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
		};
		loadProject.mockImplementationOnce(async () => {
			seedProjectState({ projectId: "existing-project", document: existing });
		});
		const newAsset: AxcutAsset = {
			id: "new-asset",
			kind: "video",
			label: "New section",
			originalPath: "/recordings/new-clip.mp4",
			cameraTrack: null,
		};
		addAsset.mockImplementationOnce(async () => {
			seedProjectState({
				document: { ...existing, assets: [...existing.assets, newAsset] },
			});
			return newAsset;
		});
		let session = {
			screenVideoPath: newAsset.originalPath,
			createdAt: 42,
			schemaVersion: 2 as const,
			clips: [{ index: 0, screenVideoPath: newAsset.originalPath, durationMs: 2_000 }],
		};
		let workspace = {
			origin: "editor" as const,
			projectId: "existing-project",
			// Inside old-1, nearer its end: insertion resolves to that boundary, never a split.
			insertionTimeSec: 3,
			currentTimeSec: 3,
			mode: "edit" as const,
			inspectorOpen: true,
			facet: "effects" as const,
		};
		const api = {
			getCurrentRecordingSession: vi.fn(async () => ({ success: true, session })),
			setCurrentRecordingSession: vi.fn(async (next) => {
				session = next as typeof session;
				return { success: true };
			}),
			getRecordingWorkspaceContext: vi.fn(async () => ({ success: true, context: workspace })),
			setRecordingWorkspaceContext: vi.fn(async () => {
				workspace = null as never;
				return { success: true };
			}),
		};
		setElectronApi(api);

		await expect(importPendingRecording()).resolves.toBe(true);

		expect(createProject).not.toHaveBeenCalled();
		expect(loadProject).toHaveBeenCalledWith("existing-project");
		const saved = useProjectStore.getState().document!;
		const createHistorySnapshot = applyDocumentPatch.mock.calls[0][2]?.createHistorySnapshot;
		expect(createHistorySnapshot).toBeTypeOf("function");
		expect(createHistorySnapshot?.(existing)).toEqual(existing);
		expect(
			saved.timeline.clips.map(({ id, timelineStartSec, timelineEndSec }) => ({
				id,
				timelineStartSec,
				timelineEndSec,
			})),
		).toEqual([
			{ id: "old-1", timelineStartSec: 0, timelineEndSec: 5 },
			{ id: "clip_recording_42_1", timelineStartSec: 5, timelineEndSec: 7 },
			{ id: "old-2", timelineStartSec: 7, timelineEndSec: 12 },
		]);
		expect(saved.zoomRanges[0]).toMatchObject({ startMs: 7_000, endMs: 8_000 });
		expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(null);
		expect(api.setRecordingWorkspaceContext).toHaveBeenCalledWith(null);
	});
});
