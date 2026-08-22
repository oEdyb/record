import { describe, expect, it } from "vitest";
import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import {
	automaticDirectionGroups,
	promoteAutomaticDirectionGroup,
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
