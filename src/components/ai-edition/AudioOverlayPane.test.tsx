// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { AudioOverlayPane } from "./AudioOverlayPane";

const mocks = vi.hoisted(() => ({ pick: vi.fn(), save: vi.fn() }));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: { pickAudioAsset: mocks.pick } },
}));
beforeEach(() => {
	vi.clearAllMocks();
	const document = createEmptyDocument({ projectId: "audio_project", title: "Audio" });
	useProjectStore.setState({
		document,
		projectId: document.project.id,
		revision: 0,
		currentTimeSec: 3,
		transactionBusy: false,
		transactionSyncPending: false,
		saveDocumentAsEdit: mocks.save,
	});
	mocks.save.mockResolvedValue(true);
	mocks.pick.mockResolvedValue({
		asset: { id: "music", label: "Music", originalPath: "/tmp/music.wav", durationSec: 10 },
	});
});
afterEach(cleanup);
it("adds the asset and placed clip in one saved edit", async () => {
	render(<AudioOverlayPane />);
	fireEvent.click(screen.getByRole("button", { name: "Add audio file" }));
	await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
	const next = mocks.save.mock.calls[0][0];
	expect(next.audioAssets).toHaveLength(1);
	expect(next.timeline.audioClips[0]).toMatchObject({
		assetId: "music",
		startSec: 3,
		endSec: 13,
		gain: 1,
	});
});
it("preserves local edits if the project changes during the picker", async () => {
	mocks.pick.mockImplementation(async () => {
		useProjectStore.setState({ revision: 1 });
		return {
			asset: { id: "music", label: "Music", originalPath: "/tmp/music.wav", durationSec: 10 },
		};
	});
	render(<AudioOverlayPane />);
	fireEvent.click(screen.getByRole("button", { name: "Add audio file" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("project changed");
	expect(mocks.save).not.toHaveBeenCalled();
});
it("rejects a trim beyond the source duration without saving", async () => {
	const state = useProjectStore.getState();
	useProjectStore.setState({
		document: {
			...state.document!,
			audioAssets: [
				{ id: "music", label: "Music", originalPath: "/tmp/music.wav", durationSec: 10 },
			],
			timeline: {
				...state.document!.timeline,
				audioClips: [
					{
						id: "clip",
						assetId: "music",
						startSec: 0,
						endSec: 10,
						sourceOffsetSec: 0,
						gain: 1,
						fadeInSec: 0,
						fadeOutSec: 0,
					},
				],
			},
		},
	});
	render(<AudioOverlayPane />);
	fireEvent.change(screen.getByLabelText("Source offset (s)"), { target: { value: "2" } });
	fireEvent.click(screen.getByRole("button", { name: "Apply audio edit" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("source duration");
	expect(mocks.save).not.toHaveBeenCalled();
});
it("reports a failed durable save instead of claiming import success", async () => {
	mocks.save.mockResolvedValue(false);
	render(<AudioOverlayPane />);
	fireEvent.click(screen.getByRole("button", { name: "Add audio file" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("not saved");
});
