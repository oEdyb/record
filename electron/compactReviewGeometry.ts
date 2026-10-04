export const COMPACT_REVIEW_MIN_SIZE = { width: 480, height: 360 } as const;
/** Widest the small review's video gets on a large screen. */
const PREFERRED_VIDEO_WIDTH = 960;
/** Review's top bar plus transport bar, used until the renderer reports its own. */
export const DEFAULT_REVIEW_CHROME_HEIGHT = 117;
/** Leaves the recorder pill's usual spot at the bottom of the screen uncovered. */
const COMPACT_REVIEW_BOTTOM_GAP = 96;
const EDGE_MARGIN = 16;

export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Small review player sized so the video fills it edge to edge: its width
 * times the recording's aspect ratio, plus the review's own bars. Centred
 * above where the recorder pill sits, or on the display when that is unknown.
 */
export function fitCompactReviewBounds(
	workArea: WindowBounds,
	aspectRatio = 16 / 9,
	chromeHeight = DEFAULT_REVIEW_CHROME_HEIGHT,
	anchorCenterX = workArea.x + workArea.width / 2,
): WindowBounds {
	const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
	const maxVideoHeight = Math.max(
		1,
		workArea.height - COMPACT_REVIEW_BOTTOM_GAP - EDGE_MARGIN - chromeHeight,
	);
	let videoWidth = Math.min(PREFERRED_VIDEO_WIDTH, workArea.width - 2 * EDGE_MARGIN);
	let videoHeight = videoWidth / ratio;
	if (videoHeight > maxVideoHeight) {
		videoHeight = maxVideoHeight;
		videoWidth = videoHeight * ratio;
	}
	const width = Math.max(COMPACT_REVIEW_MIN_SIZE.width, Math.round(videoWidth));
	const height = Math.max(
		COMPACT_REVIEW_MIN_SIZE.height,
		Math.round(videoHeight) + Math.round(chromeHeight),
	);
	return {
		x: Math.round(
			Math.min(
				Math.max(anchorCenterX - width / 2, workArea.x),
				workArea.x + workArea.width - width,
			),
		),
		y: Math.max(
			workArea.y,
			Math.round(workArea.y + workArea.height - height - COMPACT_REVIEW_BOTTOM_GAP),
		),
		width,
		height,
	};
}
