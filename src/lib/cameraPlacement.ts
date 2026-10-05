// Direct manipulation of the picture-in-picture camera in recording review: move it,
// resize it from a corner, nudge it with the keyboard. Pure geometry in canvas pixels,
// so the gesture and `computeCompositeLayout` resolve the same tile from what is saved.
//
// What is saved stays the existing project fields: `webcamPosition` (the tile centre as
// a fraction of the canvas) and `webcamSizePreset` (the tile's long side as a percentage
// of the canvas short side, 10–80). The tile always has the camera file's own aspect.

import {
	MAX_WEBCAM_SIZE_PERCENT,
	MIN_WEBCAM_SIZE_PERCENT,
	pictureInPictureMargin,
	type RenderRect,
	type Size,
	webcamSizeToFraction,
} from "./compositeLayout";

/** A move ending this close to an edge lands on it, as a fraction of the canvas short side. */
export const CAMERA_SNAP_FRACTION = 0.03;

export interface CameraPlacementFrame {
	/** The preview canvas, in pixels. */
	canvas: Size;
	/** The screen box the camera must stay inside, in canvas pixels. */
	bounds: RenderRect;
	/** The camera file's pixel size; only its aspect matters. */
	camera: Size;
}

export interface CameraPlacement {
	webcamPosition: { cx: number; cy: number };
	webcamSizePreset: number;
	rect: RenderRect;
}

/** The tile for a size preset, rounded exactly as `computeCompositeLayout` rounds it. */
export function cameraTileSize(canvas: Size, camera: Size, sizePercent: number): Size {
	const longSide = Math.min(canvas.width, canvas.height) * webcamSizeToFraction(sizePercent);
	const scale = longSide / Math.max(1, camera.width, camera.height);
	return {
		width: Math.round(camera.width * scale),
		height: Math.round(camera.height * scale),
	};
}

/** The allowed area for the tile: the screen box inset by the margin, intersected with the canvas. */
function innerBounds(frame: CameraPlacementFrame) {
	const margin = pictureInPictureMargin(frame.canvas);
	const left = Math.max(0, frame.bounds.x) + margin;
	const top = Math.max(0, frame.bounds.y) + margin;
	const right = Math.min(frame.canvas.width, frame.bounds.x + frame.bounds.width) - margin;
	const bottom = Math.min(frame.canvas.height, frame.bounds.y + frame.bounds.height) - margin;
	return { left, top, right, bottom };
}

function clampAxis(start: number, size: number, low: number, high: number): number {
	if (high - low < size) return low + (high - low - size) / 2;
	return Math.max(low, Math.min(high - size, start));
}

function snapAxis(start: number, size: number, low: number, high: number, snap: number): number {
	if (Math.abs(start - low) <= snap) return low;
	if (Math.abs(start + size - high) <= snap) return high - size;
	return start;
}

function placementOf(
	frame: CameraPlacementFrame,
	sizePercent: number,
	tile: Size,
	x: number,
	y: number,
): CameraPlacement {
	return {
		webcamPosition: {
			cx: (x + tile.width / 2) / frame.canvas.width,
			cy: (y + tile.height / 2) / frame.canvas.height,
		},
		webcamSizePreset: sizePercent,
		rect: { x, y, width: tile.width, height: tile.height },
	};
}

/**
 * Places a tile whose top-left corner the pointer asks for at (`x`, `y`). It snaps to the
 * margin line of any edge it comes near, so the four corners and edges are easy to hit,
 * then stays inside the screen box.
 */
export function moveCameraTile(
	frame: CameraPlacementFrame,
	sizePercent: number,
	x: number,
	y: number,
	options: { snap?: boolean } = {},
): CameraPlacement {
	const tile = cameraTileSize(frame.canvas, frame.camera, sizePercent);
	const inner = innerBounds(frame);
	const snap =
		options.snap === false
			? -1
			: Math.min(frame.canvas.width, frame.canvas.height) * CAMERA_SNAP_FRACTION;
	const nextX = clampAxis(
		snapAxis(x, tile.width, inner.left, inner.right, snap),
		tile.width,
		inner.left,
		inner.right,
	);
	const nextY = clampAxis(
		snapAxis(y, tile.height, inner.top, inner.bottom, snap),
		tile.height,
		inner.top,
		inner.bottom,
	);
	return placementOf(frame, sizePercent, tile, nextX, nextY);
}

/** Which corner carries the resize handle: the one facing the middle of the screen box. */
export function cameraResizeCorner(
	frame: CameraPlacementFrame,
	rect: RenderRect,
): { left: boolean; top: boolean } {
	return {
		left: rect.x + rect.width / 2 > frame.bounds.x + frame.bounds.width / 2,
		top: rect.y + rect.height / 2 > frame.bounds.y + frame.bounds.height / 2,
	};
}

/**
 * Resizes from the handle corner while the opposite corner stays put. The aspect is the
 * camera's own; the size stays within 10–80% and never grows past the screen box.
 */
export function resizeCameraTile(
	frame: CameraPlacementFrame,
	start: RenderRect,
	corner: { left: boolean; top: boolean },
	pointer: { x: number; y: number },
): CameraPlacement {
	const anchorX = corner.left ? start.x + start.width : start.x;
	const anchorY = corner.top ? start.y + start.height : start.y;
	const inner = innerBounds(frame);
	const wanted = {
		width: Math.max(0, corner.left ? anchorX - pointer.x : pointer.x - anchorX),
		height: Math.max(0, corner.top ? anchorY - pointer.y : pointer.y - anchorY),
	};
	const room = {
		width: corner.left ? anchorX - inner.left : inner.right - anchorX,
		height: corner.top ? anchorY - inner.top : inner.bottom - anchorY,
	};
	const camera = frame.camera;
	const longSide = Math.max(1, camera.width, camera.height);
	const shortCanvas = Math.min(frame.canvas.width, frame.canvas.height);
	const percentFor = (scale: number) => ((longSide * scale) / shortCanvas) * 100;
	const wantedPercent = percentFor(
		Math.max(wanted.width / camera.width, wanted.height / camera.height),
	);
	const roomPercent = percentFor(
		Math.max(0, Math.min(room.width / camera.width, room.height / camera.height)),
	);
	const percent = Math.max(
		MIN_WEBCAM_SIZE_PERCENT,
		Math.min(MAX_WEBCAM_SIZE_PERCENT, roomPercent, wantedPercent),
	);
	const sizePercent = Math.round(percent * 100) / 100;
	const tile = cameraTileSize(frame.canvas, camera, sizePercent);
	const x = corner.left ? anchorX - tile.width : anchorX;
	const y = corner.top ? anchorY - tile.height : anchorY;
	return moveCameraTile(frame, sizePercent, x, y, { snap: false });
}
