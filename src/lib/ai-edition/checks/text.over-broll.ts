import { overlayCollisions } from "./overlayGeometry";
import type { CheckRule } from "./types";
export const textOverBroll: CheckRule = {
	id: "text.over-broll",
	severity: "warning",
	describe: "B-roll draws above intersecting text; text above B-roll is normal.",
	run(context) {
		return overlayCollisions(this, context, "broll");
	},
};
