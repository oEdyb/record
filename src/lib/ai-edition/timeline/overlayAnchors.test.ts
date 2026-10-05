import { describe, expect, it } from "vitest";
import {
	buildSceneDescription,
	projectVideoOverlays,
	resolveVisibleClips,
} from "../../../native/sceneDescription";
import { editFixture, word } from "../checks/fixtures";
import { moveClip, splitClipAt } from "../document/timeline";
import { findPhrase, resolveOverlaySpan } from "./overlayAnchors";
import {
	buildTimelinePlaybackProjection,
	playbackTimeToRawTime,
	rawTimeToPlaybackTime,
} from "./timelineMap";

type Fixture = ReturnType<typeof editFixture>;
type Annotation = Fixture["annotations"][number];
type VideoOverlay = NonNullable<Fixture["videoOverlays"]>[number];

// The shapes the archived `klippt agent` placement wrote for these intents.
function withText(
	document: Fixture,
	anchor: Annotation["anchor"],
	content: string,
	range: [number, number],
	motion: "fade" | "rise" = "fade",
): Fixture {
	const annotation = {
		anchor,
		motion,
		id: "ann_fixture",
		startMs: range[0] * 1000,
		endMs: range[1] * 1000,
		type: "text",
		content,
		position: { x: 26.796875, y: 4 },
		size: { width: 46.40625, height: 16.5 },
		style: {
			preset: "card",
			color: "#ffffff",
			backgroundColor: "#171717",
			fontSize: 81,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: motion,
		},
		zIndex: 1,
	} as Annotation;
	return { ...document, annotations: [...document.annotations, annotation] };
}

function withBroll(
	document: Fixture,
	anchor: VideoOverlay["anchor"],
	range: [number, number],
): Fixture {
	const overlay = {
		anchor,
		motion: "cut",
		id: "vo_fixture",
		startMs: range[0] * 1000,
		endMs: range[1] * 1000,
		assetId: "asset",
		sourceOffsetSec: 0,
		fit: "cover",
		placement: null,
		opacity: 1,
	} as VideoOverlay;
	return { ...document, videoOverlays: [...(document.videoOverlays ?? []), overlay] };
}

describe("independent overlay anchoring", () => {
	it("round trips edited/raw times through a trim, with seam edge affinity", () => {
		const document = editFixture({ trims: [[2, 5]] });
		const projection = buildTimelinePlaybackProjection(
			resolveVisibleClips(document),
			document.timeline.clips,
		);
		expect(playbackTimeToRawTime(2, projection, "before")).toBe(2);
		expect(playbackTimeToRawTime(2, projection, "after")).toBe(5);
		expect(rawTimeToPlaybackTime(4, projection)).toBe(2);
		for (const at of [0, 1, 2, 6, 17])
			expect(rawTimeToPlaybackTime(playbackTimeToRawTime(at, projection), projection)).toBe(at);
	});
	it("keeps edited position and duration after trims and source replacement", () => {
		const candidate = structuredClone(
			withText(editFixture(), { kind: "edited", fromSec: 6, toSec: 9 }, "Kept", [6, 9]),
		);
		candidate.timeline.trimRanges = [
			{
				id: "cut",
				clipId: "clip",
				assetId: "asset",
				startSec: 0,
				endSec: 3,
				origin: "user",
				reason: "",
			},
		];
		expect(buildSceneDescription(candidate).annotations[0]).toMatchObject({
			startSec: 9,
			endSec: 12,
		});
		candidate.timeline.clips[0].assetId = "replacement";
		candidate.assets.push({
			...candidate.assets[0],
			id: "replacement",
			originalPath: "/replacement.mp4",
		});
		expect(buildSceneDescription(candidate).annotations[0]).toMatchObject({
			startSec: 9,
			endSec: 12,
		});
		expect(candidate.annotations).toHaveLength(1);
	});
	it("preserves overlay identity across clip split and reorder", () => {
		const candidate = structuredClone(
			withText(editFixture(), { kind: "edited", fromSec: 4, toSec: 9 }, "Stable", [4, 9]),
		);
		const split = splitClipAt(candidate, "clip", 6);
		const moved = moveClip(split, split.timeline.clips[1].id, 0);
		expect(moved.annotations).toEqual(candidate.annotations);
		expect(buildSceneDescription(split).annotations).toHaveLength(2);
	});
	it("re-finds shifted transcript words and rejects removed words", () => {
		const document = editFixture({ words: [word("exact", 5, 5.2), word("phrase", 5.2, 5.5)] });
		const anchor = findPhrase(document, "exact phrase")[0];
		document.transcripts[0].words = [word("exact", 7, 7.2), word("phrase", 7.2, 7.5)];
		expect(resolveOverlaySpan(document, resolveVisibleClips(document), anchor)).toEqual({
			fromSec: 7,
			toSec: 7.5,
		});
		document.timeline.trimRanges = [
			{
				id: "cut",
				clipId: "clip",
				assetId: "asset",
				startSec: 7.1,
				endSec: 7.4,
				origin: "user",
				reason: "",
			},
		];
		expect(resolveOverlaySpan(document, resolveVisibleClips(document), anchor)).toBeNull();
	});
	it("advances B-roll source across kept time, excluding removed footage", () => {
		const candidate = structuredClone(
			withBroll(
				editFixture({ trims: [[4, 8]] }),
				{ kind: "edited", fromSec: 2, toSec: 7 },
				[2, 11],
			),
		);
		const overlays = projectVideoOverlays(candidate, resolveVisibleClips(candidate));
		expect(overlays).toHaveLength(2);
		expect(overlays.map((o) => o.sourceOffsetSec)).toEqual([0, 2]);
		expect(candidate.videoOverlays).toHaveLength(1);
	});
});

it("follows anchored words onto the right half of a split", () => {
	const document = editFixture({ words: [word("keep", 8, 8.5), word("this", 8.5, 9)] });
	const candidate = withText(
		document,
		{
			kind: "words",
			clipId: "clip",
			assetId: "asset",
			text: "keep this",
			sourceStartSec: 8,
			sourceEndSec: 9,
			minimumDurationSec: 1.5,
		},
		"Kept",
		[8, 9.5],
	);
	const split = splitClipAt(candidate, "clip", 5);
	expect(buildSceneDescription(split).annotations[0]).toMatchObject({
		startSec: 8,
		endSec: 9.5,
		clipIndex: 1,
	});
});
it("keeps the text animation clock across clip boundaries", () => {
	const candidate = withText(
		editFixture(),
		{ kind: "edited", fromSec: 4, toSec: 9 },
		"Stable",
		[4, 9],
		"rise",
	);
	const split = splitClipAt(candidate, "clip", 6);
	const annotations = buildSceneDescription(split).annotations;
	expect(annotations).toHaveLength(2);
	expect(annotations.map((a) => a.startSec)).toEqual([4, 4]);
});

it("keeps the original occurrence when a repeated phrase moves after a split", () => {
	const document = editFixture({ words: [word("same", 2, 3), word("same", 7, 8)] });
	const anchor = findPhrase(document, "same")[1];
	const split = splitClipAt(document, "clip", 5);
	expect(resolveOverlaySpan(split, resolveVisibleClips(split), anchor)).toEqual({
		fromSec: 7,
		toSec: 8,
	});
});
it("follows phrase words across a contiguous source split", () => {
	const document = editFixture({ words: [word("keep", 4, 5), word("together", 5, 6)] });
	const anchor = findPhrase(document, "keep together")[0];
	const split = splitClipAt(document, "clip", 5);
	expect(resolveOverlaySpan(split, resolveVisibleClips(split), anchor)).toEqual({
		fromSec: 4,
		toSec: 6,
	});
});

it("keeps words after the original split half is removed", async () => {
	const { removeClip } = await import("../document/timeline");
	const document = editFixture({ words: [word("keep", 7, 8)] });
	const anchor = findPhrase(document, "keep")[0];
	const split = splitClipAt(document, "clip", 5);
	const remaining = removeClip(split, "clip");
	expect(resolveOverlaySpan(remaining, resolveVisibleClips(remaining), anchor)).toEqual({
		fromSec: 2,
		toSec: 3,
	});
});
