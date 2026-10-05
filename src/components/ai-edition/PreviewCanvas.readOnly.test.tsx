// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutClip, createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { PreviewCanvas } from "./PreviewCanvas";

const actions = vi.hoisted(() => ({ setLive: vi.fn(), commit: vi.fn() }));
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
beforeEach(() => {
	const document = createEmptyDocument({ title: "Recording", projectId: "p1" });
	document.assets = [
		{
			id: "a1",
			kind: "video",
			label: "Screen",
			originalPath: "/tmp/screen.mp4",
			cameraTrack: { sourcePath: "/tmp/camera.mp4", startMs: 0, offsetMs: 0, visible: true },
		},
	];
	document.timeline.clips = [clip];
	useProjectStore.setState({ document });
	actions.setLive.mockClear();
	actions.commit.mockClear();
});
afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});
describe("recording preview", () => {
	it("keeps the camera visible while disabling layout changes in review", () => {
		render(
			<PreviewCanvas
				readOnly
				screenFramingEnabled
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
		const camera = screen.getByLabelText("preview.webcamPreview");
		expect(camera).toHaveStyle({ cursor: "default" });
		fireEvent.pointerDown(camera, { pointerId: 1, clientX: 20, clientY: 20 });
		fireEvent.pointerMove(camera, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerUp(camera, { pointerId: 1 });
		expect(actions.setLive).not.toHaveBeenCalled();
		expect(actions.commit).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("layout.screenFramingPreview")).toBeNull();
		expect(screen.queryByTestId("zoom-edit")).toBeNull();
		expect(screen.queryByTestId("annotation-edit")).toBeNull();
	});
});
