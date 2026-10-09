export interface CameraPreviewPoint {
	x: number;
	y: number;
}

export interface CameraPreviewSize {
	width: number;
	height: number;
}

export interface CameraPreviewWorkArea extends CameraPreviewPoint, CameraPreviewSize {}

/** Keeps the complete preview reachable after a display or work-area change. */
export function clampCameraPreviewPosition(
	position: CameraPreviewPoint,
	size: CameraPreviewSize,
	workArea: CameraPreviewWorkArea,
): CameraPreviewPoint {
	const maxX = workArea.x + Math.max(0, workArea.width - size.width);
	const maxY = workArea.y + Math.max(0, workArea.height - size.height);
	return {
		x: Math.min(maxX, Math.max(workArea.x, Math.round(position.x))),
		y: Math.min(maxY, Math.max(workArea.y, Math.round(position.y))),
	};
}

/** Calm top-right default that stays away from the bottom-centred recording panel. */
export function defaultCameraPreviewPosition(
	workArea: CameraPreviewWorkArea,
	size: CameraPreviewSize,
	margin = 24,
): CameraPreviewPoint {
	return clampCameraPreviewPosition(
		{
			x: workArea.x + workArea.width - size.width - margin,
			y: workArea.y + margin,
		},
		size,
		workArea,
	);
}

export interface CameraPreviewBounds extends CameraPreviewPoint, CameraPreviewSize {}

/** Transparent gutter around the painted surface; keeps its shadow inside the window. */
export const CAMERA_PREVIEW_GUTTER = 12;

/** Default compact monitor: a 288 × 162 surface plus the gutter. */
export const COMPACT_CAMERA_PREVIEW_SIZE: CameraPreviewSize = { width: 312, height: 186 };

/**
 * Largest 16:9 surface (plus gutter) that fits inside the work area with a margin,
 * centred. Used while the confidence monitor is expanded so the whole camera frame is
 * readable; it stays a preview and never changes the recorded camera layout.
 */
export function expandedCameraPreviewBounds(
	workArea: CameraPreviewWorkArea,
	margin = 48,
	gutter = CAMERA_PREVIEW_GUTTER,
): CameraPreviewBounds {
	const availableWidth = Math.max(0, workArea.width - 2 * (margin + gutter));
	const availableHeight = Math.max(0, workArea.height - 2 * (margin + gutter));
	const surfaceWidth = Math.floor(Math.min(availableWidth, (availableHeight * 16) / 9));
	const surfaceHeight = Math.floor((surfaceWidth * 9) / 16);
	const width = surfaceWidth + 2 * gutter;
	const height = surfaceHeight + 2 * gutter;
	return {
		x: workArea.x + Math.round((workArea.width - width) / 2),
		y: workArea.y + Math.round((workArea.height - height) / 2),
		width,
		height,
	};
}

/**
 * Window size for a 16:9 painted surface at the given window width, kept between
 * the compact size and the largest surface the work area can hold.
 */
export function clampCameraPreviewSize(
	width: number,
	workArea: CameraPreviewWorkArea,
	gutter = CAMERA_PREVIEW_GUTTER,
): CameraPreviewSize {
	const largest = expandedCameraPreviewBounds(workArea, 0, gutter);
	const minSurfaceWidth = COMPACT_CAMERA_PREVIEW_SIZE.width - 2 * gutter;
	const maxSurfaceWidth = Math.max(minSurfaceWidth, largest.width - 2 * gutter);
	const surfaceWidth = Math.round(
		Math.min(maxSurfaceWidth, Math.max(minSurfaceWidth, width - 2 * gutter)),
	);
	const surfaceHeight = Math.round((surfaceWidth * 9) / 16);
	return { width: surfaceWidth + 2 * gutter, height: surfaceHeight + 2 * gutter };
}

/**
 * Size after dragging the bottom-right grip by a total pointer travel. The larger
 * of the two axes wins so a straight pull down grows the monitor as much as a pull
 * to the right; the result stays 16:9 and inside the work area.
 */
export function resizedCameraPreviewSize(
	origin: CameraPreviewSize,
	delta: CameraPreviewPoint,
	workArea: CameraPreviewWorkArea,
	gutter = CAMERA_PREVIEW_GUTTER,
): CameraPreviewSize {
	const growth = Math.max(delta.x, (delta.y * 16) / 9);
	return clampCameraPreviewSize(origin.width + growth, workArea, gutter);
}
