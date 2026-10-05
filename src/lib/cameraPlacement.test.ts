import { describe, expect, it } from "vitest";
import {
	CAMERA_SNAP_FRACTION,
	type CameraPlacementFrame,
	cameraResizeCorner,
	cameraTileSize,
	moveCameraTile,
	resizeCameraTile,
} from "./cameraPlacement";
import { computeCompositeLayout, pictureInPictureMargin } from "./compositeLayout";

const canvas = { width: 1600, height: 900 };
const square: CameraPlacementFrame = {
	canvas,
	bounds: { x: 0, y: 0, width: 1600, height: 900 },
	camera: { width: 1552, height: 1552 },
};
const wide: CameraPlacementFrame = { ...square, camera: { width: 1920, height: 1080 } };
const margin = pictureInPictureMargin(canvas); // 18

function inside(
	frame: CameraPlacementFrame,
	rect: { x: number; y: number; width: number; height: number },
) {
	const b = frame.bounds;
	return (
		rect.x >= b.x + margin - 1e-9 &&
		rect.y >= b.y + margin - 1e-9 &&
		rect.x + rect.width <= b.x + b.width - margin + 1e-9 &&
		rect.y + rect.height <= b.y + b.height - margin + 1e-9
	);
}

describe("cameraTileSize", () => {
	it("keeps the camera file's own aspect with the size as the long side", () => {
		expect(cameraTileSize(canvas, square.camera, 50)).toEqual({ width: 450, height: 450 });
		expect(cameraTileSize(canvas, wide.camera, 50)).toEqual({ width: 450, height: 253 });
		expect(cameraTileSize(canvas, { width: 1080, height: 1920 }, 50)).toEqual({
			width: 253,
			height: 450,
		});
	});

	it("holds the shared 10% to 80% range", () => {
		expect(cameraTileSize(canvas, square.camera, 2).width).toBe(90);
		expect(cameraTileSize(canvas, square.camera, 200).width).toBe(720);
	});

	it("matches the tile computeCompositeLayout draws for the real shape", () => {
		for (const camera of [square.camera, wide.camera, { width: 640, height: 480 }]) {
			const layout = computeCompositeLayout({
				canvasSize: canvas,
				screenSize: canvas,
				webcamSize: camera,
				webcamSizePreset: 33,
				webcamMaskShape: "rectangle",
				webcamAspectRatio: "source",
				webcamCornerRadius: 0,
			});
			const tile = cameraTileSize(canvas, camera, 33);
			expect(layout?.webcamRect).toMatchObject({
				...tile,
				borderRadius: 0,
				maskShape: "rectangle",
			});
		}
	});
});

describe("moveCameraTile", () => {
	it("snaps to each corner with the same margin as the default placement", () => {
		const tile = cameraTileSize(canvas, wide.camera, 30);
		const near = canvas.height * CAMERA_SNAP_FRACTION - 1;
		const corners = [
			moveCameraTile(wide, 30, near, near).rect,
			moveCameraTile(wide, 30, canvas.width - tile.width - near, near).rect,
			moveCameraTile(wide, 30, near, canvas.height - tile.height - near).rect,
			moveCameraTile(wide, 30, canvas.width - tile.width - near, canvas.height - tile.height - near)
				.rect,
		];
		expect(corners.map((r) => [r.x, r.y])).toEqual([
			[margin, margin],
			[canvas.width - margin - tile.width, margin],
			[margin, canvas.height - margin - tile.height],
			[canvas.width - margin - tile.width, canvas.height - margin - tile.height],
		]);
	});

	it("does not snap away from an edge it is not near", () => {
		const placed = moveCameraTile(wide, 30, 400, 300).rect;
		expect([placed.x, placed.y]).toEqual([400, 300]);
	});

	it("keeps the whole tile inside the screen box when dragged past any edge", () => {
		for (const [x, y] of [
			[-500, -500],
			[5000, -20],
			[-20, 5000],
			[5000, 5000],
		]) {
			const placed = moveCameraTile(square, 60, x, y);
			expect(inside(square, placed.rect)).toBe(true);
		}
	});

	it("stays inside a padded screen box, not only inside the canvas", () => {
		const padded = { ...wide, bounds: { x: 160, y: 90, width: 1280, height: 720 } };
		const placed = moveCameraTile(padded, 30, 5000, 5000);
		expect(inside(padded, placed.rect)).toBe(true);
		expect(placed.rect.x + placed.rect.width).toBe(1440 - margin);
	});

	it("saves the tile centre as a canvas fraction that computeCompositeLayout places back", () => {
		const placed = moveCameraTile(wide, 30, 300, 200);
		expect(placed.webcamPosition.cx).toBeCloseTo((300 + placed.rect.width / 2) / 1600, 10);
		const layout = computeCompositeLayout({
			canvasSize: canvas,
			screenSize: canvas,
			webcamSize: wide.camera,
			webcamSizePreset: placed.webcamSizePreset,
			webcamPosition: placed.webcamPosition,
			webcamMaskShape: "rectangle",
			webcamAspectRatio: "source",
			webcamCornerRadius: 0,
		});
		expect(layout?.webcamRect).toMatchObject(placed.rect);
	});
});

describe("resizeCameraTile", () => {
	const start = moveCameraTile(wide, 30, 5000, 5000).rect; // bottom-right corner

	it("puts the handle on the corner facing the middle", () => {
		expect(cameraResizeCorner(wide, start)).toEqual({ left: true, top: true });
		const topLeft = moveCameraTile(wide, 30, 0, 0).rect;
		expect(cameraResizeCorner(wide, topLeft)).toEqual({ left: false, top: false });
	});

	it("keeps the aspect and the opposite corner while growing", () => {
		const grown = resizeCameraTile(
			wide,
			start,
			{ left: true, top: true },
			{
				x: start.x - 200,
				y: start.y - 200,
			},
		);
		expect(grown.webcamSizePreset).toBeGreaterThan(30);
		expect(grown.rect.width / grown.rect.height).toBeCloseTo(1920 / 1080, 1);
		expect(grown.rect.x + grown.rect.width).toBeCloseTo(start.x + start.width, 0);
		expect(grown.rect.y + grown.rect.height).toBeCloseTo(start.y + start.height, 0);
	});

	it("stops at 10% when shrunk past it", () => {
		const shrunk = resizeCameraTile(
			wide,
			start,
			{ left: true, top: true },
			{
				x: start.x + start.width,
				y: start.y + start.height,
			},
		);
		expect(shrunk.webcamSizePreset).toBe(10);
		expect(shrunk.rect.width).toBe(90);
	});

	it("stops at 80% and never outgrows the screen box", () => {
		const huge = resizeCameraTile(wide, start, { left: true, top: true }, { x: -5000, y: -5000 });
		expect(huge.webcamSizePreset).toBe(80);
		expect(inside(wide, huge.rect)).toBe(true);
		const tight = { ...square, bounds: { x: 0, y: 0, width: 1600, height: 900 } };
		const squareStart = moveCameraTile(tight, 30, 5000, 5000).rect;
		const capped = resizeCameraTile(
			tight,
			squareStart,
			{ left: true, top: true },
			{ x: -5000, y: -5000 },
		);
		expect(capped.webcamSizePreset).toBeLessThan(100 * ((900 - 2 * margin) / 900) + 0.01);
		expect(inside(tight, capped.rect)).toBe(true);
	});
});
