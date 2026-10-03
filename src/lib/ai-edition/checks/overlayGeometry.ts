import { z } from "zod";
import { resolveEffectiveState } from "../agent/effectiveState";
import { getCaptionSettings } from "../captions";
import type { ResolvedEdit, ResolvedRegion } from "./context";
import { type CheckRule, type Finding, finding } from "./types";

const box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export function regionBox(context: ResolvedEdit, region: ResolvedRegion) {
	const layout = context.scene.layout.layoutByClip?.[region.clipIndex];
	const screen = layout?.screenRect ?? context.scene.layout.screenRect;
	const video = z.object({ rect: box.nullable() }).safeParse(region.value);
	const annotation = box.safeParse(region.value);
	const rect = video.success
		? (video.data.rect ?? { x: 0, y: 0, w: 1, h: 1 })
		: annotation.success
			? annotation.data
			: null;
	return rect && screen
		? {
				x: screen.x + rect.x * screen.width,
				y: screen.y + rect.y * screen.height,
				w: rect.w * screen.width,
				h: rect.h * screen.height,
			}
		: null;
}
export function intersects(
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
) {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
export function overlayCollisions(
	rule: CheckRule,
	context: ResolvedEdit,
	target: "camera" | "broll" | "caption",
) {
	const findings: Finding[] = [];
	const primary = context.regions.filter((r) =>
		target === "caption"
			? r.kind === "video-overlay"
			: r.kind === "annotation" && z.object({ kind: z.literal("text") }).safeParse(r.value).success,
	);
	for (const region of primary) {
		const rect = regionBox(context, region);
		if (!rect) continue;
		if (
			target === "caption" &&
			!(
				context.document.clipLayouts?.[region.clip]?.captions ??
				getCaptionSettings(context.document).enabled
			)
		) {
			const fragment = context.projection[region.clipIndex];
			const span = {
				startSec: Math.max(region.edited.startSec, fragment?.playbackStartSec ?? 0),
				endSec: Math.min(region.edited.endSec, fragment?.playbackEndSec ?? context.durationSec),
			};
			if (span.endSec <= span.startSec) continue;
			findings.push(
				finding(
					rule,
					span,
					region.clip,
					`${region.id} is visible while captions are disabled for this span.`,
					null,
				),
			);
			continue;
		}
		if (target === "camera") {
			const state = resolveEffectiveState(context, region.edited.startSec);
			const camera = state.layout.cameraBaseRect.value;
			if (
				camera &&
				intersects(rect, { x: camera.x, y: camera.y, w: camera.width, h: camera.height })
			)
				findings.push(
					finding(
						rule,
						region.edited,
						region.clip,
						`Text ${region.id} intersects the scene camera base rectangle.`,
						null,
					),
				);
		} else {
			for (const other of context.regions.filter(
				(r) =>
					r.kind === (target === "broll" ? "video-overlay" : "caption") &&
					r.clipIndex === region.clipIndex,
			)) {
				const from = Math.max(region.edited.startSec, other.edited.startSec);
				const to = Math.min(region.edited.endSec, other.edited.endSec);
				if (to <= from) continue;
				const covering = target === "caption" ? region : other;
				const covered = target === "caption" ? other : region;
				if (covering.drawOrder <= covered.drawOrder) continue;
				const otherRect = regionBox(context, other);
				if (otherRect && intersects(rect, otherRect))
					findings.push(
						finding(
							rule,
							{ startSec: from, endSec: to },
							region.clip,
							`${region.id} intersects ${other.id}.`,
							null,
						),
					);
			}
		}
	}
	return { findings };
}
