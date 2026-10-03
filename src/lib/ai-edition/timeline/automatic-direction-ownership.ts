import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { CHAINED_ZOOM_PAN_GAP_MS } from "@/lib/zoomMath/zoomRegionUtils";
import type { AxcutDocument } from "../schema";
import {
	type AutomaticDirectionProvenance,
	type AutomaticDirectionReason,
	automaticDirectionDismissalsSchema,
	automaticDirectionProvenanceSchema,
} from "../schema/automatic-direction-review";
import { anchorRegionsWithDerivedMs } from "./timelineMap";

export type AutomaticDirectionMember = {
	kind: "zoom" | "cameraFullscreen";
	id: string;
};

export interface AutomaticDirectionGroup {
	id: string;
	startMs: number;
	endMs: number;
	members: AutomaticDirectionMember[];
	reasons: AutomaticDirectionReason[];
}

type ZoomRegion = AxcutDocument["zoomRanges"][number];
type OwnedRegion = {
	id: string;
	startMs: number;
	endMs: number;
	source?: "auto" | "manual";
	directionGroupId?: string;
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
	automaticDirection?: AutomaticDirectionProvenance;
};

function addMember(
	groups: Map<string, AutomaticDirectionGroup>,
	groupId: string,
	region: OwnedRegion,
	kind: AutomaticDirectionMember["kind"],
) {
	const provenance = automaticDirectionProvenanceSchema.safeParse(region.automaticDirection);
	const reason = provenance.success ? provenance.data.reason : undefined;
	const current = groups.get(groupId);
	if (current) {
		current.startMs = Math.min(current.startMs, region.startMs);
		current.endMs = Math.max(current.endMs, region.endMs);
		current.members.push({ kind, id: region.id });
		if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
		return;
	}
	groups.set(groupId, {
		id: groupId,
		startMs: region.startMs,
		endMs: region.endMs,
		members: [{ kind, id: region.id }],
		reasons: reason ? [reason] : [],
	});
}

/** Exact authored effect identity, independent of a regeneration's plan and region IDs. */
function dismissalKey(kind: AutomaticDirectionMember["kind"], region: OwnedRegion): string {
	const zoom = region as ZoomRegion;
	const camera = region as CameraFullscreenRegion;
	const anchor =
		region.clipId && region.sourceStartSec !== undefined && region.sourceEndSec !== undefined
			? [
					region.clipId,
					Math.round(region.sourceStartSec * 1_000),
					Math.round(region.sourceEndSec * 1_000),
				]
			: [null, Math.round(region.startMs), Math.round(region.endMs)];
	return JSON.stringify([
		1,
		kind,
		anchor,
		kind === "zoom"
			? [
					zoom.depth,
					zoom.focus?.cx,
					zoom.focus?.cy,
					zoom.focusMode ?? "manual",
					zoom.customScale ?? null,
				]
			: [camera.mode ?? "fullscreen", camera.cameraScale ?? null],
	]);
}

function dismissalKeys(
	document: AxcutDocument,
	kind: AutomaticDirectionMember["kind"],
	region: OwnedRegion,
): string[] {
	if (region.clipId || document.timeline.clips.length === 0) return [dismissalKey(kind, region)];
	// Old current-schema projects can still contain unanchored effects. Match the
	// same clip fragments the materializer will create during regeneration.
	const anchored = anchorRegionsWithDerivedMs([region], document.timeline.clips, () => region.id);
	return (anchored.length ? anchored : [region]).map((fragment) => dismissalKey(kind, fragment));
}

export function automaticDirectionDismissalCount(document: AxcutDocument): number {
	return document.automaticDirectionDismissals?.length ?? 0;
}

/** Restore eligibility; the caller must explicitly regenerate to create new regions. */
export function clearAutomaticDirectionDismissals(document: AxcutDocument): AxcutDocument {
	if (!automaticDirectionDismissalCount(document)) return document;
	return { ...document, automaticDirectionDismissals: [] };
}

/** Called only after planning/materialization so exclusions cannot change detector selection. */
export function filterDismissedAutomaticDirection(document: AxcutDocument): AxcutDocument {
	const keys = new Set(document.automaticDirectionDismissals ?? []);
	if (keys.size === 0) return document;
	const zoomRanges = document.zoomRanges.filter(
		(region) => region.source !== "auto" || !keys.has(dismissalKey("zoom", region)),
	);
	const cameras = documentCameraRegions(document);
	const cameraFullscreenRegions = cameras.filter(
		(region) => region.source !== "auto" || !keys.has(dismissalKey("cameraFullscreen", region)),
	);
	if (
		zoomRanges.length === document.zoomRanges.length &&
		cameraFullscreenRegions.length === cameras.length
	)
		return document;
	return {
		...document,
		zoomRanges,
		legacyEditor:
			cameraFullscreenRegions.length === cameras.length
				? document.legacyEditor
				: { ...document.legacyEditor, cameraFullscreenRegions },
	};
}

function clipsCanConnect(previous: OwnedRegion, current: OwnedRegion) {
	return !previous.clipId || !current.clipId || previous.clipId === current.clipId;
}

function documentCameraRegions(document: AxcutDocument): CameraFullscreenRegion[] {
	return (
		(document.legacyEditor as { cameraFullscreenRegions?: CameraFullscreenRegion[] } | null)
			?.cameraFullscreenRegions ?? []
	);
}

/** Review only current automatic work. Promoted manual passages no longer belong here. */
export function automaticDirectionGroupsForDocument(
	document: AxcutDocument,
): AutomaticDirectionGroup[] {
	return automaticDirectionGroups(document.zoomRanges, documentCameraRegions(document));
}

/** Keep this passage unchanged by future regeneration, using normal manual ownership. */
export function keepAutomaticDirectionGroup(
	document: AxcutDocument,
	groupId: string,
): AxcutDocument {
	return reviewAutomaticDirectionGroups(document, [groupId], "keep");
}

/**
 * Remove a current automatic passage as one ordinary document edit. Resolve
 * membership again on the latest document so a stale review cannot remove manual
 * work. Save bounded exact-effect exclusions, independent of generated IDs.
 * A changed effect after tuning is eligible again. Undo restores both the
 * removed regions and their prior exclusion list through normal history.
 */
export function removeAutomaticDirectionGroup(
	document: AxcutDocument,
	groupId: string,
): AxcutDocument {
	return reviewAutomaticDirectionGroups(document, [groupId], "remove");
}

/** Resolve the latest ownership once, including bulk review of long projects. */
export function reviewAutomaticDirectionGroups(
	document: AxcutDocument,
	groupIds: string[],
	action: "keep" | "remove",
): AxcutDocument {
	const selected = new Set(groupIds);
	if (selected.size === 0) return document;
	const zoomIds = new Set<string>();
	const cameraIds = new Set<string>();
	for (const group of automaticDirectionGroupsForDocument(document)) {
		if (!selected.has(group.id)) continue;
		for (const member of group.members) {
			(member.kind === "zoom" ? zoomIds : cameraIds).add(member.id);
		}
	}
	if (zoomIds.size === 0 && cameraIds.size === 0) return document;
	const cameras = documentCameraRegions(document);
	if (action === "keep") {
		return {
			...document,
			zoomRanges: zoomIds.size
				? document.zoomRanges.map((region) =>
						zoomIds.has(region.id) ? { ...region, source: "manual" as const } : region,
					)
				: document.zoomRanges,
			legacyEditor: cameraIds.size
				? {
						...document.legacyEditor,
						cameraFullscreenRegions: cameras.map((region) =>
							cameraIds.has(region.id) ? { ...region, source: "manual" as const } : region,
						),
					}
				: document.legacyEditor,
		};
	}
	const keys = new Set(document.automaticDirectionDismissals ?? []);
	for (const region of document.zoomRanges) {
		if (zoomIds.has(region.id)) {
			for (const key of dismissalKeys(document, "zoom", region)) keys.add(key);
		}
	}
	for (const region of cameras) {
		if (cameraIds.has(region.id)) {
			for (const key of dismissalKeys(document, "cameraFullscreen", region)) keys.add(key);
		}
	}
	// Fail before removal if the saved bound is reached; never silently forget exclusions.
	const automaticDirectionDismissals = automaticDirectionDismissalsSchema.parse([...keys]);
	return {
		...document,
		automaticDirectionDismissals,
		zoomRanges: zoomIds.size
			? document.zoomRanges.filter((region) => !zoomIds.has(region.id))
			: document.zoomRanges,
		legacyEditor: cameraIds.size
			? {
					...document.legacyEditor,
					cameraFullscreenRegions: cameras.filter((region) => !cameraIds.has(region.id)),
				}
			: document.legacyEditor,
	};
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
