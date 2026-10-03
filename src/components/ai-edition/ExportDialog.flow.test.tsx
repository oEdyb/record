// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutAsset,
	type AxcutClip,
	type AxcutDocument,
	axcutSchemaVersion,
} from "@/lib/ai-edition/schema";
import { useExportRunStore } from "@/lib/ai-edition/store/exportRunStore";
import { ExportDialog } from "./ExportDialog";

const mocks = vi.hoisted(() => ({
	export: vi.fn(),
	pick: vi.fn(),
	reveal: vi.fn(),
	phase: undefined as undefined | ((phase: string) => void),
	progress: undefined as undefined | ((frames: number) => void),
}));
vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("@/hooks/useCleanVoiceRuntime", () => ({ useCleanVoiceRuntime: () => ({ routes: [] }) }));
vi.mock("@/native", () => ({
	exportMultiNative: mocks.export,
	exportGifNative: mocks.export,
	useIsCpuCompositor: () => false,
}));
vi.mock("@/native/sceneDescription", () => ({
	buildCompositorClipInputs: () => [
		{ path: "/tmp/a.mp4", sourceStartSec: 0, sourceEndSec: 10, hasAudio: false },
	],
	buildSceneDescription: () => ({ speedRegions: [] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
function asset(p: Partial<AxcutAsset> & Pick<AxcutAsset, "id">): AxcutAsset {
	return {
		kind: "video",
		label: "asset",
		originalPath: "/tmp/a.mp4",
		cameraTrack: null,
		...p,
	};
}

function clip(p: Partial<AxcutClip> & Pick<AxcutClip, "id" | "assetId">): AxcutClip {
	return {
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...p,
	};
}

function doc(assets: AxcutAsset[], clips: AxcutClip[]): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-06-26T10:00:00Z",
			updatedAt: "2026-06-26T10:00:00Z",
			primaryAssetId: assets[0]?.id ?? "asset_1",
		},
		assets,
		transcript: null,
		transcripts: [],
		timeline: {
			clips,
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
}

function show() {
	const document = doc(
		[asset({ id: "a1", video: { width: 1920, height: 1080, codec: "h264", fps: 30 } })],
		[clip({ id: "c1", assetId: "a1" })],
	);
	const onClose = vi.fn();
	render(<ExportDialog open onClose={onClose} document={document} />);
	fireEvent.click(screen.getByRole("button", { name: "One video" }));
	return onClose;
}

beforeEach(() => {
	localStorage.clear();
	useExportRunStore.getState().abandon();
	mocks.export.mockReset();
	mocks.pick.mockReset().mockResolvedValue({ path: "/tmp/export.mp4" });
	mocks.reveal.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			pickExportSavePath: mocks.pick,
			revealInFolder: mocks.reveal,
			onNativeExportPhase: (callback: (phase: string) => void) => {
				mocks.phase = callback;
				return vi.fn();
			},
			onNativeExportProgress: (callback: (frames: number) => void) => {
				mocks.progress = callback;
				return vi.fn();
			},
		},
	});
});
afterEach(cleanup);

describe("ExportDialog task completion", () => {
	it("replaces export settings and duplicate export with the saved file action", async () => {
		mocks.export.mockResolvedValue({ videoDurationS: 10, wallS: 1 });
		const onClose = show();
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.exportMp4" }));
		const reveal = await screen.findByRole("button", { name: "exportDialog.showInFolder" });
		expect(screen.getByRole("status")).toHaveTextContent("exportDialog.exportedVideo");
		expect(
			screen.queryByRole("button", { name: "exportDialog.exportMp4" }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "exportFormat.gif" })).not.toBeInTheDocument();
		fireEvent.click(reveal);
		expect(mocks.reveal).toHaveBeenCalledWith("/tmp/export.mp4");
		expect(mocks.export).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.close" }));
		expect(onClose).toHaveBeenCalled();
	});
	it("keeps failure recoverable and preserves the selected settings", async () => {
		mocks.export.mockRejectedValueOnce(new Error("Disk is full"));
		show();
		fireEvent.click(screen.getByRole("button", { name: "H.265" }));
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.exportMp4" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Disk is full");
		expect(screen.getByRole("button", { name: "H.265" })).toHaveAttribute("aria-pressed", "true");
		mocks.export.mockResolvedValueOnce({ videoDurationS: 10, wallS: 1 });
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.retryExport" }));
		await screen.findByRole("button", { name: "exportDialog.showInFolder" });
		expect(mocks.export).toHaveBeenCalledTimes(2);
	});
	it("does not show render ETA or a completion percentage while checking the file", async () => {
		mocks.export.mockReturnValue(
			new Promise(() => {
				/* Keep the export pending during finalization. */
			}),
		);
		show();
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.exportMp4" }));
		await waitFor(() => expect(mocks.export).toHaveBeenCalledOnce());
		act(() => {
			mocks.progress?.(300);
			mocks.phase?.("validating");
		});
		expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
		expect(screen.getByText("exportDialog.finishingFile")).toBeInTheDocument();
		expect(screen.queryByText("100%")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "exportDialog.showInFolder" }),
		).not.toBeInTheDocument();
	});
	it("cancels the active export and returns to the same settings", async () => {
		mocks.export.mockImplementation(
			(_clips, _path, _scene, _options, transaction: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					transaction.signal.addEventListener("abort", () => reject(new Error("Cancelled")));
				}),
		);
		show();
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.exportMp4" }));
		await waitFor(() => expect(mocks.export).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.cancelExport" }));
		expect(await screen.findByRole("button", { name: "exportDialog.exportMp4" })).toBeEnabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	it("keeps the export running when the window closes and reports it to the shared run", async () => {
		const aborted = vi.fn();
		mocks.export.mockImplementation(
			(_clips, _path, _scene, _options, transaction: { signal: AbortSignal }) =>
				new Promise(() => {
					transaction.signal.addEventListener("abort", aborted);
				}),
		);
		const onClose = show();
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.exportMp4" }));
		await waitFor(() => expect(mocks.export).toHaveBeenCalledOnce());
		act(() => mocks.progress?.(30));
		expect(screen.getByText("exportDialog.backgroundHint")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.close" }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(aborted).not.toHaveBeenCalled();
		expect(useExportRunStore.getState().phase).toBe("rendering");
		expect(useExportRunStore.getState().progress?.currentFrame).toBe(30);
	});
	it("returns to settings when the save picker is cancelled", async () => {
		mocks.pick.mockResolvedValue({});
		show();
		fireEvent.click(screen.getByRole("button", { name: "exportDialog.exportMp4" }));
		expect(await screen.findByRole("button", { name: "exportDialog.exportMp4" })).toBeEnabled();
		expect(mocks.export).not.toHaveBeenCalled();
	});
	it("exposes selected format and changes the available settings", () => {
		show();
		expect(screen.getByRole("button", { name: "exportFormat.mp4" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		fireEvent.click(screen.getByRole("button", { name: "exportFormat.gif" }));
		expect(screen.getByRole("button", { name: "exportFormat.gif" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: "exportFormat.mp4" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		expect(screen.getByRole("button", { name: "exportDialog.exportGif" })).toBeInTheDocument();
	});
});
