import { describe, expect, it } from "vitest";
import { prepareAgentEditPlan } from "../../../../electron/ai-edition/agentEditPlan";
import { buildPlacement, placementIntentSchema } from "../../../../electron/cli/agentPlacement";
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
		const document = editFixture();
		const built = buildPlacement(
			document,
			placementIntentSchema.parse({
				kind: "text",
				action: "add",
				project_id: "project",
				from: 6,
				to: 9,
				text: "Kept",
			}),
		);
		const candidate = structuredClone(prepareAgentEditPlan(document, built.operations).candidate);
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
		const built = buildPlacement(
			editFixture(),
			placementIntentSchema.parse({
				kind: "text",
				action: "add",
				project_id: "project",
				from: 4,
				to: 9,
				text: "Stable",
			}),
		);
		const candidate = structuredClone(
			prepareAgentEditPlan(editFixture(), built.operations).candidate,
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
		const document = editFixture({ trims: [[4, 8]] });
		const built = buildPlacement(
			document,
			placementIntentSchema.parse({
				kind: "broll",
				action: "add",
				project_id: "project",
				from: 2,
				to: 7,
				file: "/take.mp4",
			}),
		);
		const candidate = structuredClone(prepareAgentEditPlan(document, built.operations).candidate);
		const overlays = projectVideoOverlays(candidate, resolveVisibleClips(candidate));
		expect(overlays).toHaveLength(2);
		expect(overlays.map((o) => o.sourceOffsetSec)).toEqual([0, 2]);
		expect(candidate.videoOverlays).toHaveLength(1);
	});
});

it("follows anchored words onto the right half of a split", () => {
	const document = editFixture({ words: [word("keep", 8, 8.5), word("this", 8.5, 9)] });
	const built = buildPlacement(
		document,
		placementIntentSchema.parse({
			kind: "text",
			action: "add",
			project_id: "project",
			words: "keep this",
			text: "Kept",
		}),
	);
	const candidate = prepareAgentEditPlan(document, built.operations).candidate;
	const split = splitClipAt(candidate, "clip", 5);
	expect(buildSceneDescription(split).annotations[0]).toMatchObject({
		startSec: 8,
		endSec: 9.5,
		clipIndex: 1,
	});
});
it("keeps the text animation clock across clip boundaries", () => {
	const built = buildPlacement(
		editFixture(),
		placementIntentSchema.parse({
			kind: "text",
			action: "add",
			project_id: "project",
			from: 4,
			to: 9,
			text: "Stable",
			motion: "rise",
		}),
	);
	const candidate = prepareAgentEditPlan(editFixture(), built.operations).candidate;
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
