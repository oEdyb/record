// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	notePreviewPaintedFrame,
	notePreviewTransportAnchor,
	resetPreviewSettledFrames,
} from "@/native/previewSettledFrames";

const mocks = vi.hoisted(() => ({
	preview: vi.fn(),
	video: null as HTMLVideoElement | null,
	exportDialog: vi.fn(),
	openProject: vi.fn(),
	applyTheme: vi.fn(),
	importPendingRecording: vi.fn(),
	listProjects: vi.fn(),
	get: vi.fn(),
	getLatest: vi.fn(),
}));

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("@/contexts/ShortcutsContext", () => ({
	useShortcuts: () => ({
		shortcuts: { playPause: { key: " " } },
		isMac: true,
		openConfig: vi.fn(),
	}),
}));
vi.mock("@/hooks/useCleanVoiceRuntime", () => ({
	useCleanVoiceRuntime: () => ({ routes: new Map() }),
}));
vi.mock("@/hooks/useTheme", () => ({ applyTheme: mocks.applyTheme }));
vi.mock("@/native", () => ({
	nativeBridgeClient: {
		aiEdition: { listProjects: mocks.listProjects, delete: vi.fn(), importProject: vi.fn() },
	},
}));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { get: mocks.get, getLatest: mocks.getLatest },
	},
}));
vi.mock("@/lib/ai-edition/store/useAssetDimensionBackfill", () => ({
	useAssetDimensionBackfill: () => undefined,
}));
vi.mock("./recordingImport", () => ({
	importPendingRecording: mocks.importPendingRecording,
	isPendingRecordingImportInProgress: () => false,
}));
vi.mock("./Preview", () => ({
	Preview: (props: Record<string, unknown>) => {
		useEffect(() => {
			const onVideoElement = props.onVideoElement;
			if (typeof onVideoElement === "function" && mocks.video) onVideoElement(mocks.video);
		}, [props.onVideoElement]);
		mocks.preview(props);
		return <div data-testid="preview" />;
	},
}));
vi.mock("./TransportBar", () => ({ TransportBar: () => <div data-testid="transport" /> }));
vi.mock("./TransactionRecoveryBanner", () => ({ TransactionRecoveryBanner: () => null }));
vi.mock("./ExportDialog", () => ({
	ExportDialog: (props: { open: boolean; quickExport?: boolean; sourceOnly?: boolean }) => {
		mocks.exportDialog(props);
		return props.open ? (
			<div
				data-testid="export"
				data-quick={String(Boolean(props.quickExport))}
				data-source-only={String(Boolean(props.sourceOnly))}
			/>
		) : null;
	},
}));
vi.mock("./Modals", () => ({
	OpenProjectModal: (props: { open: boolean; recordingOnly?: boolean }) => {
		mocks.openProject(props);
		return props.open ? <div data-testid="recordings" /> : null;
	},
	UnsavedChangesModal: () => null,
}));

import { RecordingReviewShell } from "./RecordingReviewShell";

type Listener = () => void;
let menuListeners: Record<string, Listener>;
let startNewRecording: ReturnType<typeof vi.fn>;

function installElectronApi(workspaceContext: unknown = null) {
	menuListeners = {};
	startNewRecording = vi.fn().mockResolvedValue({ success: true });
	const subscribe = (name: string) => (listener: Listener) => {
		menuListeners[name] = listener;
		return () => undefined;
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getRecordingWorkspaceContext: vi.fn().mockResolvedValue({
			success: true,
			context: workspaceContext,
		}),
		setRecordingWorkspaceContext: vi.fn().mockResolvedValue(undefined),
		getCurrentRecordingSession: vi.fn().mockResolvedValue({ success: false }),
		startNewRecording,
		setHasUnsavedChanges: vi.fn(),
		onRequestCloseConfirm: () => () => undefined,
		onRequestSaveBeforeClose: () => () => undefined,
		onRecordingWorkspaceReturned: () => () => undefined,
		onMenuNewProject: subscribe("new"),
		onMenuLoadProject: subscribe("load"),
		onMenuSaveProject: subscribe("save"),
		onMenuSaveProjectAs: subscribe("saveAs"),
		markStopStage: vi.fn(),
		isReviewWindowCompact: vi.fn().mockResolvedValue(false),
		onReviewWindowCompactChanged: () => () => undefined,
	};
}

function recordingDocument(): AxcutDocument {
	const document = createEmptyDocument({ title: "Take", projectId: "p1" });
	document.assets = [
		{
			id: "a1",
			kind: "video",
			label: "Screen",
			originalPath: "/tmp/screen.mp4",
			cameraTrack: null,
		},
	];
	document.timeline.clips = [
		{
			id: "c1",
			assetId: "a1",
			sourceStartSec: 0,
			sourceEndSec: 12,
			timelineStartSec: 0,
			timelineEndSec: 12,
			wordRefs: [],
			origin: "system",
			reason: "",
		},
	];
	return document;
}

function loadDocument(document: AxcutDocument) {
	useProjectStore.setState({ document, projectId: document.project.id, status: "ready" });
}

beforeEach(() => {
	installElectronApi();
	mocks.video = null;
	resetPreviewSettledFrames();
	mocks.importPendingRecording.mockResolvedValue(false);
	mocks.listProjects.mockResolvedValue([]);
	mocks.get.mockReset();
	mocks.get.mockResolvedValue({ success: false, error: "not found" });
	mocks.getLatest.mockReset();
	mocks.getLatest.mockResolvedValue({ success: true });
});
afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
	vi.clearAllMocks();
});

describe("recording review shell", () => {
	it.each([
		false,
		true,
	])("waits for the new take's composed screen before revealing review (warm=%s)", async (warm) => {
		const take = recordingDocument();
		const old = recordingDocument();
		old.assets[0].originalPath = "/tmp/old.mp4";
		mocks.video = document.createElement("video");
		Object.defineProperty(mocks.video, "readyState", { value: 2 });
		const videoFrameCallback = vi.fn();
		mocks.video.requestVideoFrameCallback = videoFrameCallback;
		const reviewReady = vi.fn();
		let handoff: ((token: number) => void) | undefined;
		Object.assign(window.electronAPI ?? {}, {
			reviewReady,
			onReviewHandoff: (listener: (token: number) => void) => {
				handoff = listener;
				return () => undefined;
			},
		});
		if (warm) loadDocument(old);
		render(<RecordingReviewShell />);
		await waitFor(() => expect(handoff).toBeDefined());
		mocks.importPendingRecording.mockImplementation(async () => {
			loadDocument(take);
			return true;
		});
		await act(async () => {
			handoff?.(42);
		});
		const anchor = {
			viewId: 7,
			generation: 3,
			clipIndex: 0,
			sourceTimeSec: 0,
			sceneIdentity: take,
			screenPath: "/tmp/screen.mp4",
		};
		const frame = { viewId: 7, transportGeneration: 3, clipIndex: 0, sourceTimeSec: 0 };
		const paint = async (patch: Partial<typeof frame>) => {
			await act(async () => {
				notePreviewPaintedFrame({ ...frame, ...patch });
			});
		};
		await act(async () => {
			notePreviewTransportAnchor(anchor);
		});
		await paint({ transportGeneration: 0 });
		expect(screen.getByTestId("review-loading")).toHaveAttribute("data-ready", "false");
		for (const patch of [
			{ transportGeneration: 2 },
			{ sourceTimeSec: Number.NaN },
			{ sourceTimeSec: -0.1 },
			{ sourceTimeSec: 12 },
			{ clipIndex: 1 },
			{ viewId: 6 },
		]) {
			await paint(patch);
			expect(screen.getByTestId("review-loading")).toHaveAttribute("data-ready", "false");
			expect(reviewReady).not.toHaveBeenCalled();
		}
		for (const patch of [{ sceneIdentity: old }, { screenPath: "/tmp/old.mp4" }]) {
			await act(async () => {
				notePreviewTransportAnchor({ ...anchor, ...patch });
			});
			await paint({});
			expect(screen.getByTestId("review-loading")).toHaveAttribute("data-ready", "false");
			expect(reviewReady).not.toHaveBeenCalled();
		}
		expect(videoFrameCallback).not.toHaveBeenCalled();
		expect(screen.getByTestId("review-loading")).toHaveAttribute("data-ready", "false");
		await act(async () => {
			notePreviewTransportAnchor(anchor);
		});
		await paint({});
		expect(useProjectStore.getState().document).toBe(take);
		expect(screen.getByTestId("review-loading")).toHaveAttribute("data-ready", "true");
		await waitFor(() => expect(reviewReady).toHaveBeenCalledWith(42));
		expect(screen.getByTestId("review-loading")).toHaveAttribute("data-ready", "true");
	});

	it("shows the ready state and starts a new recording without an open project context", async () => {
		render(<RecordingReviewShell />);
		expect(screen.getByText("recordingReview.ready")).toBeInTheDocument();
		await waitFor(() => expect(mocks.applyTheme).toHaveBeenCalledWith("dark"));
		const empty = screen.getByText("recordingReview.ready").parentElement as HTMLElement;
		fireEvent.click(within(empty).getByRole("button", { name: "recordingReview.newRecording" }));
		await waitFor(() => expect(startNewRecording).toHaveBeenCalledWith(undefined));
	});

	it("auto-loads the latest full view without listing the library", async () => {
		const document = recordingDocument();
		mocks.getLatest.mockResolvedValue({ success: true, document });

		render(<RecordingReviewShell />);

		await waitFor(() => {
			expect(useProjectStore.getState().document?.project.id).toBe(document.project.id);
		});
		expect(mocks.getLatest).toHaveBeenCalledOnce();
		expect(mocks.listProjects).not.toHaveBeenCalled();
		expect(mocks.get).not.toHaveBeenCalled();
	});

	it("finishes startup with an empty latest library", async () => {
		render(<RecordingReviewShell />);

		await waitFor(() => {
			expect(window.electronAPI?.markStopStage).toHaveBeenCalledWith("review-project-loaded");
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: null,
			projectId: null,
			status: "idle",
			error: null,
		});
		expect(mocks.listProjects).not.toHaveBeenCalled();
	});

	it("surfaces a failed latest project and retries without showing an empty-library hint", async () => {
		mocks.getLatest
			.mockResolvedValueOnce({ success: false, error: "EACCES" })
			.mockResolvedValueOnce({ success: true, document: recordingDocument() });
		render(<RecordingReviewShell />);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("recordingReview.loadRecordingsFailed");
		expect(alert).toHaveTextContent("EACCES");
		expect(screen.queryByText("recordingReview.readyHint")).not.toBeInTheDocument();
		expect(mocks.getLatest).toHaveBeenCalledOnce();
		expect(within(alert).getByRole("button", { name: "recordingReview.recordings" })).toBeEnabled();

		fireEvent.click(within(alert).getByRole("button", { name: "recordingReview.retryOpen" }));
		await waitFor(() => expect(mocks.getLatest).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
		expect(useProjectStore.getState().document?.project.id).toBe("p1");
	});

	it("does not apply a late latest result after the open project changes", async () => {
		const latest = recordingDocument();
		latest.project = { ...latest.project, id: "latest", title: "Latest" };
		let finishLoad!: () => void;
		mocks.getLatest.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = () => resolve({ success: true, document: latest });
				}),
		);
		render(<RecordingReviewShell />);
		await waitFor(() => expect(mocks.getLatest).toHaveBeenCalledOnce());
		const current = recordingDocument();
		act(() => loadDocument(current));

		await act(async () => finishLoad());

		expect(useProjectStore.getState().document?.project.id).toBe(current.project.id);
		expect(useProjectStore.getState().status).toBe("ready");
		expect(mocks.get).not.toHaveBeenCalled();
	});

	it("plays existing edited projects' regions back in a read-only preview", async () => {
		const document = recordingDocument();
		const zoom = { id: "z1", startMs: 1000, endMs: 3000 } as AxcutDocument["zoomRanges"][number];
		const trim = {
			id: "t1",
			assetId: "a1",
			clipId: "c1",
			startSec: 4,
			endSec: 5,
		} as AxcutDocument["timeline"]["trimRanges"][number];
		document.zoomRanges = [zoom];
		document.timeline.trimRanges = [trim];
		document.legacyEditor = {
			speedRegions: [{ id: "s1", startMs: 0, endMs: 1000, speed: 2 }],
			cameraFullscreenRegions: [{ id: "f1", startMs: 2000, endMs: 4000 }],
		};
		loadDocument(document);
		render(<RecordingReviewShell />);
		await waitFor(() => expect(screen.getByTestId("preview")).toBeInTheDocument());
		const props = mocks.preview.mock.lastCall?.[0] as Record<string, unknown>;
		expect(props.readOnly).toBe(true);
		expect(props.zoomRegions).toEqual([zoom]);
		expect(props.trimRanges).toEqual([trim]);
		expect(props.speedRegions).toEqual([{ id: "s1", startMs: 0, endMs: 1000, speed: 2 }]);
		expect(props.cameraFullscreenRegions).toEqual([{ id: "f1", startMs: 2000, endMs: 4000 }]);
		expect(screen.getByTestId("transport")).toBeInTheDocument();
	});

	it("records an added clip into the open project at its end with the persisted workspace shape", async () => {
		loadDocument(recordingDocument());
		render(<RecordingReviewShell />);
		fireEvent.click(await screen.findByRole("button", { name: "recordingReview.addClip" }));
		await waitFor(() => expect(startNewRecording).toHaveBeenCalledOnce());
		expect(startNewRecording).toHaveBeenCalledWith({
			origin: "editor",
			projectId: "p1",
			insertionTimeSec: 12,
			currentTimeSec: 0,
			mode: "edit",
			inspectorOpen: true,
			facet: "effects",
		});
	});

	it("opens quick export from Save and source recovery from Originals", async () => {
		loadDocument(recordingDocument());
		render(<RecordingReviewShell />);
		await act(async () => menuListeners.save?.());
		await waitFor(() => expect(screen.getByTestId("export")).toHaveAttribute("data-quick", "true"));
		const close = mocks.exportDialog.mock.lastCall?.[0] as { onClose: () => void };
		act(() => close.onClose());
		expect(screen.queryByTestId("export")).toBeNull();
		fireEvent.keyDown(screen.getByRole("button", { name: "recordingReview.more" }), {
			key: "Enter",
		});
		fireEvent.click(screen.getByRole("menuitem", { name: "recordingReview.originals" }));
		await waitFor(() =>
			expect(screen.getByTestId("export")).toHaveAttribute("data-quick", "false"),
		);
		expect(screen.getByTestId("export")).toHaveAttribute("data-source-only", "true");
	});

	it("opens Recordings from the File menu", async () => {
		loadDocument(recordingDocument());
		render(<RecordingReviewShell />);
		await waitFor(() => expect(menuListeners.load).toBeDefined());
		await act(async () => menuListeners.load?.());
		expect(screen.getByTestId("recordings")).toBeInTheDocument();
		expect(mocks.openProject.mock.lastCall?.[0]).toMatchObject({ recordingOnly: true });
	});

	it("restores the playhead to the insertion point after a recording hands back", async () => {
		installElectronApi({
			origin: "editor",
			projectId: "p1",
			insertionTimeSec: 7,
			currentTimeSec: 3,
			mode: "edit",
			inspectorOpen: true,
			facet: "effects",
		});
		mocks.importPendingRecording.mockImplementation(async () => {
			loadDocument(recordingDocument());
			return true;
		});
		render(<RecordingReviewShell />);
		await waitFor(() => expect(useProjectStore.getState().currentTimeSec).toBe(7));
	});
});
