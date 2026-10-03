import { rawTimeToPlaybackTime } from "../timeline/timelineMap";
import { type CheckRule, finding } from "./types";

export const layoutUnusedOverride: CheckRule = {
	id: "layout.unused-override",
	severity: "info",
	describe: "A clip layout override has no kept footage.",
	fix: "setClipLayout with layout:null clears the unused override.",
	run(context) {
		const kept = new Set(context.fragments.map((fragment) => fragment.clip));
		return {
			findings: context.document.timeline.clips
				.filter((clip) => context.document.clipLayouts?.[clip.id] && !kept.has(clip.id))
				.map((clip) => {
					const at = rawTimeToPlaybackTime(clip.timelineStartSec, context.projection);
					return finding(
						layoutUnusedOverride,
						{ startSec: at, endSec: at },
						clip.id,
						`Layout override for ${clip.id} has no kept footage.`,
						[{ type: "setClipLayout", clipId: clip.id, layout: null }],
					);
				}),
		};
	},
};
