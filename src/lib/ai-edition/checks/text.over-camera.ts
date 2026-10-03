import { overlayCollisions } from "./overlayGeometry";
import type { CheckRule } from "./types";
export const textOverCamera: CheckRule = {
	id: "text.over-camera",
	severity: "error",
	describe:
		"Text intersects the resolved scene camera base rectangle; animated geometry remains compositor-owned.",
	run(context) {
		return overlayCollisions(this, context, "camera");
	},
};
