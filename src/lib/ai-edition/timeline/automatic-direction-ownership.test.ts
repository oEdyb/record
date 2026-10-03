import { describe, expect, it } from "vitest";
import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { type AxcutDocument, createEmptyDocument, documentSchema } from "../schema";
import {
	automaticDirectionDismissalCount,
	automaticDirectionGroups,
	automaticDirectionGroupsForDocument,
	clearAutomaticDirectionDismissals,
	filterDismissedAutomaticDirection,
	keepAutomaticDirectionGroup,
	promoteAutomaticDirectionGroup,
	removeAutomaticDirectionGroup,
	reviewAutomaticDirectionGroups,
} from "./automatic-direction-ownership";

function documentWithDirection(): AxcutDocument {
	const base = createEmptyDocument({ title: "Direction", projectId: "direction-project" });
	return {
		...base,
		zoomRanges: [
			{
				id: "zoom-a",
				startMs: 1_000,
				endMs: 3_000,
				depth: 3,
				focus: { cx: 0.25, cy: 0.5 },
				source: "auto",
				directionGroupId: "screen-passage",
			},
			{
				id: "zoom-b",
				startMs: 3_500,
				endMs: 5_500,
				depth: 3,
				focus: { cx: 0.75, cy: 0.5 },
				source: "auto",
				directionGroupId: "screen-passage",
			},
		],
		legacyEditor: {
			cameraFullscreenRegions: [
				{
					id: "camera-a",
					startMs: 7_000,
					endMs: 10_000,
					mode: "emphasis",
					source: "auto",
					directionGroupId: "camera-passage",
				},
			],
		},
	};
}

describe("automatic direction ownership", () => {
	it("shows one group for a connected screen passage and one for camera emphasis", () => {
		const document = documentWithDirection();
		const camera = (document.legacyEditor as { cameraFullscreenRegions: CameraFullscreenRegion[] })
			.cameraFullscreenRegions;
		const groups = automaticDirectionGroups(document.zoomRanges, camera);

		expect(groups).toEqual([
			expect.objectContaining({
				id: "screen-passage",
				startMs: 1_000,
				endMs: 5_500,
				members: [
					{ kind: "zoom", id: "zoom-a" },
					{ kind: "zoom", id: "zoom-b" },
				],
			}),
			expect.objectContaining({
				id: "camera-passage",
				startMs: 7_000,
				endMs: 10_000,
				members: [{ kind: "cameraFullscreen", id: "camera-a" }],
			}),
		]);
	});

	it("promotes the complete automatic passage when one member is edited", () => {
		const promoted = promoteAutomaticDirectionGroup(documentWithDirection(), "zoom", "zoom-b");

		expect(promoted.zoomRanges.map((region) => region.source)).toEqual(["manual", "manual"]);
		const camera = (promoted.legacyEditor as { cameraFullscreenRegions: CameraFullscreenRegion[] })
			.cameraFullscreenRegions;
		expect(camera[0].source).toBe("auto");
	});

	it("groups legacy connected automatic zooms without crossing a manual region", () => {
		const base = documentWithDirection();
		const legacyZooms = [
			{ ...base.zoomRanges[0], id: "legacy-a", directionGroupId: undefined },
			{
				...base.zoomRanges[1],
				id: "legacy-b",
				startMs: 4_000,
				endMs: 6_000,
				directionGroupId: undefined,
			},
			{
				...base.zoomRanges[1],
				id: "manual-wall",
				startMs: 6_200,
				endMs: 7_000,
				source: "manual" as const,
				directionGroupId: undefined,
			},
			{
				...base.zoomRanges[1],
				id: "legacy-c",
				startMs: 7_100,
				endMs: 8_000,
				directionGroupId: undefined,
			},
		];
		const groups = automaticDirectionGroups(legacyZooms, []);

		expect(groups.map((group) => group.members.map((member) => member.id))).toEqual([
			["legacy-a", "legacy-b"],
			["legacy-c"],
		]);
	});
});

describe("automatic direction review", () => {
	it("keeps a complete passage and makes a stale Remove harmless", () => {
		const original = documentWithDirection();
		const kept = keepAutomaticDirectionGroup(original, "screen-passage");
		expect(kept.zoomRanges.every((region) => region.source === "manual")).toBe(true);
		expect(removeAutomaticDirectionGroup(kept, "screen-passage")).toBe(kept);
		expect(automaticDirectionGroupsForDocument(kept).map((group) => group.id)).toEqual([
			"camera-passage",
		]);
		expect(original.zoomRanges.every((region) => region.source === "auto")).toBe(true);
	});
	it("removes one whole passage, persists its exclusions, and preserves unrelated state", () => {
		const original = documentWithDirection();
		const removed = removeAutomaticDirectionGroup(original, "screen-passage");
		expect(removed.zoomRanges).toEqual([]);
		expect(removed.legacyEditor).toBe(original.legacyEditor);
		expect(removed.timeline).toBe(original.timeline);
		expect(automaticDirectionDismissalCount(removed)).toBe(2);
		expect(documentSchema.parse(removed).automaticDirectionDismissals).toEqual(
			removed.automaticDirectionDismissals,
		);
		expect(removeAutomaticDirectionGroup(removed, "screen-passage")).toBe(removed);
		const replayed = {
			...removed,
			zoomRanges: original.zoomRanges.map((region) => ({
				...region,
				id: `new-${region.id}`,
				directionGroupId: "new-plan",
			})),
		};
		expect(filterDismissedAutomaticDirection(replayed).zoomRanges).toEqual([]);
		expect(
			filterDismissedAutomaticDirection(clearAutomaticDirectionDismissals(replayed)).zoomRanges,
		).toEqual(replayed.zoomRanges);
	});
	it("never filters promoted manual regions, even if their exact framing was dismissed", () => {
		const original = documentWithDirection();
		const removed = removeAutomaticDirectionGroup(original, "screen-passage");
		const manual = keepAutomaticDirectionGroup(original, "screen-passage");
		const restored = {
			...manual,
			automaticDirectionDismissals: removed.automaticDirectionDismissals,
		};
		expect(filterDismissedAutomaticDirection(restored)).toBe(restored);
	});
	it("removes camera emphasis without changing zooms or other legacy settings", () => {
		const original = documentWithDirection();
		original.legacyEditor = { ...original.legacyEditor, padding: 24 };
		const removed = removeAutomaticDirectionGroup(original, "camera-passage");
		expect(removed.zoomRanges).toBe(original.zoomRanges);
		expect(removed.legacyEditor).toMatchObject({ padding: 24, cameraFullscreenRegions: [] });
		expect(
			filterDismissedAutomaticDirection({
				...original,
				automaticDirectionDismissals: removed.automaticDirectionDismissals,
			}).legacyEditor,
		).toMatchObject({ cameraFullscreenRegions: [] });
	});
	it("shows only stored reasons and retains provenance when keeping an effect", () => {
		const original = documentWithDirection();
		expect(
			automaticDirectionGroupsForDocument(original).every((group) => group.reasons.length === 0),
		).toBe(true);
		original.zoomRanges[0].automaticDirection = { version: 1, reason: "typing" };
		original.zoomRanges[1].automaticDirection = { version: 1, reason: "screen-activity" };
		expect(automaticDirectionGroupsForDocument(original)[0].reasons).toEqual([
			"typing",
			"screen-activity",
		]);
		const kept = keepAutomaticDirectionGroup(original, "screen-passage");
		expect(kept.zoomRanges[0].automaticDirection).toEqual({ version: 1, reason: "typing" });
		expect(documentSchema.parse(kept).zoomRanges[0].automaticDirection).toEqual(
			kept.zoomRanges[0].automaticDirection,
		);
	});
	it("rejects invalid saved provenance and bounded dismissal overflow", () => {
		const original = documentWithDirection();
		expect(
			documentSchema.safeParse({
				...original,
				zoomRanges: [
					{ ...original.zoomRanges[0], automaticDirection: { version: 1, reason: "invented" } },
				],
			}).success,
		).toBe(false);
		const full = {
			...original,
			automaticDirectionDismissals: Array.from({ length: 5000 }, (_, i) => `existing-${i}`),
		};
		expect(() => removeAutomaticDirectionGroup(full, "screen-passage")).toThrow();
		expect(full.zoomRanges).toHaveLength(2);
	});
});

it("keeps exact dismissals attached to source spans when clips move", () => {
	const original = documentWithDirection();
	original.zoomRanges = original.zoomRanges.map((region) => ({
		...region,
		clipId: "clip-a",
		sourceStartSec: region.startMs / 1000,
		sourceEndSec: region.endMs / 1000,
	}));
	const removed = removeAutomaticDirectionGroup(original, "screen-passage");
	const moved = {
		...removed,
		zoomRanges: original.zoomRanges.map((region) => ({
			...region,
			id: `new-${region.id}`,
			startMs: region.startMs + 20000,
			endMs: region.endMs + 20000,
		})),
	};
	expect(filterDismissedAutomaticDirection(moved).zoomRanges).toEqual([]);
	const otherClip = {
		...moved,
		zoomRanges: moved.zoomRanges.map((region) => ({ ...region, clipId: "other-clip" })),
	};
	expect(filterDismissedAutomaticDirection(otherClip)).toBe(otherClip);
});

it("rejects invalid camera provenance without tightening unrelated legacy fields", () => {
	const original = documentWithDirection();
	expect(
		documentSchema.safeParse({
			...original,
			legacyEditor: {
				cameraFullscreenRegions: [
					{ id: "camera", automaticDirection: { version: 1, reason: "invented" } },
				],
			},
		}).success,
	).toBe(false);
	expect(
		documentSchema.safeParse({ ...original, legacyEditor: { customSetting: "preserved" } }).success,
	).toBe(true);
});

it("reviews many selected groups together without changing manual work", () => {
	const original = documentWithDirection();
	original.zoomRanges.push({
		...original.zoomRanges[0],
		id: "manual",
		source: "manual",
		directionGroupId: "manual-group",
	});
	const ids = ["screen-passage", "camera-passage", "manual-group", "stale-group", "screen-passage"];
	const kept = reviewAutomaticDirectionGroups(original, ids, "keep");
	expect(automaticDirectionGroupsForDocument(kept)).toEqual([]);
	expect(kept.zoomRanges[2]).toBe(original.zoomRanges[2]);
	const removed = reviewAutomaticDirectionGroups(original, ids, "remove");
	expect(removed.zoomRanges).toEqual([original.zoomRanges[2]]);
	expect(removed.legacyEditor).toMatchObject({ cameraFullscreenRegions: [] });
	expect(automaticDirectionDismissalCount(removed)).toBe(3);
	expect(reviewAutomaticDirectionGroups(kept, ids, "remove")).toBe(kept);
	expect(reviewAutomaticDirectionGroups(original, [], "remove")).toBe(original);
	expect(original.zoomRanges).toHaveLength(3);
});
