import type { PrivateUiRectangle } from "./privateRecordingUi";

export const LINUX_HUD_INITIAL_SIZE = { width: 472, height: 112 };
const EDGE_SLACK = 24;

/** Linux cannot forward hover through an ignored window. Fit its real input area instead. */
export function linuxHudWindowSize(rectangles: PrivateUiRectangle[]) {
	if (rectangles.length === 0) return null;
	return {
		width: Math.max(
			LINUX_HUD_INITIAL_SIZE.width,
			Math.ceil(Math.max(...rectangles.map((rect) => rect.x + rect.width)) + EDGE_SLACK),
		),
		height: Math.max(
			80,
			Math.ceil(Math.max(...rectangles.map((rect) => rect.y + rect.height)) + EDGE_SLACK),
		),
	};
}
