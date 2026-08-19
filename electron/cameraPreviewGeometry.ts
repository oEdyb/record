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
