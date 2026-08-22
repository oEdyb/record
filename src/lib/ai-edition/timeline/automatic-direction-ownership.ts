import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { CHAINED_ZOOM_PAN_GAP_MS } from "@/lib/zoomMath/zoomRegionUtils";
import type { AxcutDocument } from "../schema";

export type AutomaticDirectionMember = {
	kind: "zoom" | "cameraFullscreen";
	id: string;
};

export interface AutomaticDirectionGroup {
	id: string;
	startMs: number;
	endMs: number;
	members: AutomaticDirectionMember[];
}

type ZoomRegion = AxcutDocument["zoomRanges"][number];
type OwnedRegion = {
	id: string;
	startMs: number;
	endMs: number;
	source?: "auto" | "manual";
	directionGroupId?: string;
	clipId?: string;
};

function addMember(
	groups: Map<string, AutomaticDirectionGroup>,
	groupId: string,
	region: OwnedRegion,
	kind: AutomaticDirectionMember["kind"],
) {
	const current = groups.get(groupId);
	if (current) {
		current.startMs = Math.min(current.startMs, region.startMs);
		current.endMs = Math.max(current.endMs, region.endMs);
		current.members.push({ kind, id: region.id });
		return;
	}
	groups.set(groupId, {
		id: groupId,
		startMs: region.startMs,
		endMs: region.endMs,
		members: [{ kind, id: region.id }],
	});
}

function clipsCanConnect(previous: OwnedRegion, current: OwnedRegion) {
	return !previous.clipId || !current.clipId || previous.clipId === current.clipId;
}

/**
 * Return the calm, user-visible passages for automatic Zoom and Camera Emphasis.
 * New regions use an explicit stable ID. The small legacy fallback reconstructs
 * connected Zoom passages so projects created before the ID existed still read well.
 */
export function automaticDirectionGroups(
	zoomRegions: ZoomRegion[],
	cameraRegions: CameraFullscreenRegion[],
): AutomaticDirectionGroup[] {
	const groups = new Map<string, AutomaticDirectionGroup>();
	const orderedZooms = [...zoomRegions].sort(
		(a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id),
	);
	let previousLegacy: ZoomRegion | null = null;
	let legacyGroupId: string | null = null;

	for (const region of orderedZooms) {
		if (region.source !== "auto") {
			previousLegacy = null;
			legacyGroupId = null;
			continue;
		}
		if (region.directionGroupId) {
			addMember(groups, region.directionGroupId, region, "zoom");
			previousLegacy = null;
			legacyGroupId = null;
			continue;
		}
		const connects =
			previousLegacy !== null &&
			region.startMs - previousLegacy.endMs <= CHAINED_ZOOM_PAN_GAP_MS &&
			clipsCanConnect(previousLegacy, region);
		const groupId: string = connects && legacyGroupId ? legacyGroupId : `legacy:zoom:${region.id}`;
		legacyGroupId = groupId;
		addMember(groups, groupId, region, "zoom");
		previousLegacy = region;
	}

	for (const region of cameraRegions) {
		if (region.source !== "auto") continue;
		addMember(
			groups,
			region.directionGroupId ?? `legacy:camera:${region.id}`,
			region,
			"cameraFullscreen",
		);
	}

	return [...groups.values()].sort(
		(a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id),
	);
}

/** Promote every member of the selected automatic passage before a user edit. */
export function promoteAutomaticDirectionGroup(
	document: AxcutDocument,
	kind: AutomaticDirectionMember["kind"],
	regionId: string,
): AxcutDocument {
	const legacy = (document.legacyEditor as Record<string, unknown> | null) ?? {};
	const cameraRegions =
		(legacy.cameraFullscreenRegions as CameraFullscreenRegion[] | undefined) ?? [];
	const group = automaticDirectionGroups(document.zoomRanges, cameraRegions).find((candidate) =>
		candidate.members.some((member) => member.kind === kind && member.id === regionId),
	);
	if (!group) return document;

	const zoomIds = new Set(
		group.members.filter((member) => member.kind === "zoom").map((member) => member.id),
	);
	const cameraIds = new Set(
		group.members.filter((member) => member.kind === "cameraFullscreen").map((member) => member.id),
	);
	return {
		...document,
		zoomRanges: document.zoomRanges.map((region) =>
			zoomIds.has(region.id) ? { ...region, source: "manual" as const } : region,
		),
		legacyEditor:
			cameraIds.size > 0
				? {
						...legacy,
						cameraFullscreenRegions: cameraRegions.map((region) =>
							cameraIds.has(region.id) ? { ...region, source: "manual" as const } : region,
						),
					}
				: document.legacyEditor,
	};
}
