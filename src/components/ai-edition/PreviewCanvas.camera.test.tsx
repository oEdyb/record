// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutClip, createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { PreviewCanvas } from "./PreviewCanvas";

// Owner decision 2026-10-05: in review the camera is moved by dragging it and resized
// from a corner, straight on the preview, through the normal editor-settings path.

const actions = vi.hoisted(() => ({ setLive: vi.fn(), commit: vi.fn(async () => undefined) }));
vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({
		settings: getEditorSettings(useProjectStore.getState().document),
		...actions,
	}),
}));
vi.mock("./NativeCompositorOverlay", () => ({ NativeCompositorOverlay: () => null }));
vi.mock("./AudioOverlayPlayback", () => ({ AudioOverlayPlayback: () => null }));
vi.mock("./VirtualPreview", () => ({ VirtualPreview: () => null }));
vi.mock("./WebcamOverlay", () => ({ WebcamOverlay: () => null }));

const clip: AxcutClip = {
	id: "c1",
	assetId: "a1",
	sourceStartSec: 0,
	sourceEndSec: 10,
	timelineStartSec: 0,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "system",
	reason: "",
};

// jsdom measures nothing: the frame falls back to 1280×720 and its 16:9 screen fills it.
const FRAME = { width: 1280, height: 720 };
const MARGIN = Math.round(720 * 0.02);

function load(legacyEditor: Record<string, unknown> = {}) {
	const document = createEmptyDocument({ title: "Recording", projectId: "p1" });
	document.assets = [
		{
			id: "a1",
			kind: "video",
			label: "Screen",
			originalPath: "/tmp/screen.mp4",
			cameraTrack: {
				sourcePath: "/tmp/camera.mp4",
				startMs: 0,
				offsetMs: 0,
				visible: true,
				width: 1920,
				height: 1080,
			},
		},
	];
	document.timeline.clips = [clip];
	document.legacyEditor = { padding: 0, ...legacyEditor };
	useProjectStore.setState({ document });
}

function renderCanvas(cameraEditable: boolean) {
	return render(
		<PreviewCanvas
			readOnly
			cameraEditable={cameraEditable}
			videoSources={[]}
			clips={[clip]}
			currentTimeSec={0}
			seekTarget={null}
			onTimeChange={vi.fn()}
			onSeek={vi.fn()}
			onLoadedMetadata={vi.fn()}
			onVideoElement={vi.fn()}
		/>,
	);
}

const percent = (value: string) => Number.parseFloat(value) / 100;

beforeEach(() => {
	load();
	actions.setLive.mockClear();
	actions.commit.mockClear();
	HTMLElement.prototype.setPointerCapture = vi.fn();
	HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

describe("camera placement in review", () => {
	it("sizes the hit area to the camera file's own shape", () => {
		renderCanvas(true);
		const camera = screen.getByLabelText("preview.webcamPreview");
		const width = percent(camera.style.width) * FRAME.width;
		const height = percent(camera.style.height) * FRAME.height;
		expect(width / height).toBeCloseTo(16 / 9, 1);
	});

	it("drags the camera into a corner and saves it in its real shape", () => {
		renderCanvas(true);
		const camera = screen.getByLabelText("preview.webcamPreview");
		const allowed = fireEvent.pointerDown(camera, { pointerId: 1, clientX: 100, clientY: 100 });
		// The press is consumed, so it neither focuses the camera nor reaches review keys.
		expect(allowed).toBe(false);
		fireEvent.pointerMove(camera, { pointerId: 1, clientX: -3000, clientY: -3000 });
		fireEvent.pointerUp(camera, { pointerId: 1 });
		const patch = actions.setLive.mock.calls.at(-1)?.[0];
		const tile = { width: Math.round(720 * 0.25), height: Math.round(720 * 0.25 * (1080 / 1920)) };
		expect(patch).toMatchObject({
			webcamLayoutPreset: "picture-in-picture",
			webcamMaskShape: "rectangle",
			webcamAspectRatio: "source",
			webcamCornerRadius: 0,
			webcamZoom: 1,
			webcamFocalPoint: { cx: 0.5, cy: 0.5 },
			webcamSizePreset: 25,
		});
		expect(patch.webcamPosition.cx).toBeCloseTo((MARGIN + tile.width / 2) / FRAME.width, 6);
		expect(patch.webcamPosition.cy).toBeCloseTo((MARGIN + tile.height / 2) / FRAME.height, 6);
		expect(actions.commit).toHaveBeenCalledTimes(1);
	});

	it("leaves an older project untouched by a click that does not move", () => {
		load({ webcamMaskShape: "squircle", webcamAspectRatio: "16:9", webcamCornerRadius: 32 });
		renderCanvas(true);
		const camera = screen.getByLabelText("preview.webcamPreview");
		fireEvent.pointerDown(camera, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerMove(camera, { pointerId: 1, clientX: 101, clientY: 101 });
		fireEvent.pointerUp(camera, { pointerId: 1 });
		expect(actions.setLive).not.toHaveBeenCalled();
		expect(actions.commit).not.toHaveBeenCalled();
	});

	it("resizes from the corner handle with the aspect locked", () => {
		renderCanvas(true);
		const handle = screen.getByTestId("camera-resize-handle");
		// Default placement is bottom-right, so the handle faces the middle: top-left.
		expect(handle).toHaveAttribute("data-corner", "top-left");
		fireEvent.pointerDown(handle, { pointerId: 2, clientX: 500, clientY: 300 });
		fireEvent.pointerMove(screen.getByLabelText("preview.webcamPreview"), {
			pointerId: 2,
			clientX: 400,
			clientY: 200,
		});
		fireEvent.pointerUp(screen.getByLabelText("preview.webcamPreview"), { pointerId: 2 });
		const patch = actions.setLive.mock.calls.at(-1)?.[0];
		expect(patch.webcamSizePreset).toBeGreaterThan(25);
		expect(patch.webcamSizePreset).toBeLessThanOrEqual(80);
		expect(patch.webcamMaskShape).toBe("rectangle");
		expect(actions.commit).toHaveBeenCalledTimes(1);
	});

	it("nudges with the arrows only while the camera itself has keyboard focus", () => {
		renderCanvas(true);
		const camera = screen.getByLabelText("preview.webcamPreview");
		expect(camera).toHaveAttribute("tabindex", "0");
		const allowed = fireEvent.keyDown(camera, { key: "ArrowLeft" });
		expect(allowed).toBe(false);
		expect(actions.setLive).toHaveBeenCalledTimes(1);
		fireEvent.keyUp(camera, { key: "ArrowLeft" });
		expect(actions.commit).toHaveBeenCalledTimes(1);
		// Space is not the camera's: it stays a review playback key.
		expect(fireEvent.keyDown(camera, { key: " " })).toBe(true);
	});

	it("offers no handle or gesture when editing is off (read-only, exporting)", () => {
		renderCanvas(false);
		const camera = screen.getByLabelText("preview.webcamPreview");
		expect(screen.queryByTestId("camera-resize-handle")).toBeNull();
		expect(camera).not.toHaveAttribute("tabindex");
		fireEvent.pointerDown(camera, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerMove(camera, { pointerId: 1, clientX: 400, clientY: 400 });
		fireEvent.pointerUp(camera, { pointerId: 1 });
		fireEvent.keyDown(camera, { key: "ArrowLeft" });
		expect(actions.setLive).not.toHaveBeenCalled();
		expect(actions.commit).not.toHaveBeenCalled();
	});

	it("does not offer editing for a block layout", () => {
		load({ webcamLayoutPreset: "dual-frame" });
		renderCanvas(true);
		expect(screen.queryByTestId("camera-resize-handle")).toBeNull();
	});
});
