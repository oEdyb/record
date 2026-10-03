import { overlayCollisions } from "./overlayGeometry";
import type { CheckRule } from "./types";
export const brollOverCaption: CheckRule = {
	id: "broll.over-caption",
	severity: "warning",
	describe:
		"B-roll draws above an intersecting caption line, or captions are disabled for its span.",
	run(context) {
		return overlayCollisions(this, context, "caption");
	},
};
