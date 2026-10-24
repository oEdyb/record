// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

const mocks = vi.hoisted(() => ({
	preview: vi.fn(),
	exportDialog: vi.fn(),
	openProject: vi.fn(),
	applyTheme: vi.fn(),
	importPendingRecording: vi.fn(),
	listProjects: vi.fn(),
	get: vi.fn(),
	getLatest: vi.fn(),
	entitlement: {
		snapshot: { status: "active", access: "full", trialDaysRemaining: null },
		openDialog: vi.fn(),
	},
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
vi.mock("@/lib/entitlements/store", () => {
	return {
		requireEntitlement: () => mocks.entitlement.snapshot.access === "full",
		useEntitlementStore: (select: (s: typeof mocks.entitlement) => unknown) =>
			select(mocks.entitlement),
	};
});
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
		mocks.preview(props);
		return <div data-testid="preview" />;
	},
}));
vi.mock("./TransportBar", () => ({ TransportBar: () => <div data-testid="transport" /> }));
vi.mock("./TransactionRecoveryBanner", () => ({ TransactionRecoveryBanner: () => null }));
vi.mock("./ExportDialog", () => ({
	ExportDialog: (props: { open: boolean; quickExport?: boolean }) => {
		mocks.exportDialog(props);
		return props.open ? (
			<div data-testid="export" data-quick={String(Boolean(props.quickExport))} />
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
	mocks.entitlement.snapshot.access = "full";
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
