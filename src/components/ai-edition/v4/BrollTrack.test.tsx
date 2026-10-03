// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { BrollTrack } from "./BrollTrack";
import { brollTimeline } from "./brollTimeline";

vi.mock("./videoThumbnail", () => ({
	videoThumbnail: vi.fn(async () => "data:image/jpeg;base64,thumb"),
}));

function fixture(): AxcutDocument {
	const base = createEmptyDocument({ title: "B-roll", projectId: "test-broll" });
	return {
		...base,
		assets: [
			{
				id: "screen",
				kind: "video",
				label: "Screen",
				originalPath: "/screen.mp4",
				durationSec: 20,
				cameraTrack: null,
			},
			{
				id: "broll",
				kind: "video",
				label: "Demo",
				originalPath: "/demo.mp4",
				durationSec: 60,
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip",
					assetId: "screen",
					sourceStartSec: 10,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "Test",
				},
			],
			trimRanges: [
				{
					id: "trim",
					assetId: "screen",
					clipId: "clip",
					startSec: 13,
					endSec: 15,
					origin: "user",
					reason: "Test",
				},
			],
		},
		videoOverlays: [
			{
				id: "overlay",
				clipId: "clip",
				sourceStartSec: 12,
				sourceEndSec: 18,
				startMs: 2000,
				endMs: 8000,
				assetId: "broll",
				sourceOffsetSec: 5,
				fit: "cover",
				placement: null,
				opacity: 1,
			},
		],
	};
}

beforeEach(() => useProjectStore.setState({ document: fixture() }));

it("uses retained time and matching source offsets after a cut", () => {
	expect(brollTimeline(fixture())).toMatchObject([
		{ start: 2, end: 3, sourceOffsetSec: 5 },
		{ start: 3, end: 6, sourceOffsetSec: 8 },
	]);
});

it("shows a real thumbnail, culls offscreen fragments and seeks a visible fragment", async () => {
	const seek = vi.fn();
	render(<BrollTrack total={8} start={3} end={7} onSeek={seek} />);
	const clip = screen.getByRole("button", { name: "B-roll: Demo" });
	expect(clip).toHaveStyle({ left: "37.5%", width: "37.5%" });
	await vi.waitFor(() =>
		expect(clip.querySelector("img")).toHaveAttribute("src", "data:image/jpeg;base64,thumb"),
	);
	fireEvent.click(clip);
	expect(seek).toHaveBeenCalledWith(3);
});

it("does not reserve an empty row", () => {
	useProjectStore.setState({ document: { ...fixture(), videoOverlays: [] } });
	const { container } = render(<BrollTrack total={8} start={0} end={8} onSeek={vi.fn()} />);
	expect(container).toBeEmptyDOMElement();
});

it("follows an edited-time anchor across retained fragments", () => {
	const doc = fixture();
	doc.videoOverlays![0].anchor = { kind: "edited", fromSec: 1, toSec: 5 };
	expect(brollTimeline(doc)).toMatchObject([
		{ start: 1, end: 3, sourceOffsetSec: 5 },
		{ start: 3, end: 5, sourceOffsetSec: 7 },
	]);
});
