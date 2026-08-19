import { describe, expect, it } from "vitest";
import { clampCameraPreviewPosition, defaultCameraPreviewPosition } from "./cameraPreviewGeometry";

const size = { width: 312, height: 186 };
const workArea = { x: 0, y: 24, width: 1_710, height: 1_082 };

describe("camera preview geometry", () => {
	it("places the default preview at the top right inside the work area", () => {
		expect(defaultCameraPreviewPosition(workArea, size)).toEqual({ x: 1_374, y: 48 });
	});

	it("keeps saved positions fully reachable", () => {
		expect(clampCameraPreviewPosition({ x: -80, y: 2_000 }, size, workArea)).toEqual({
			x: 0,
			y: 920,
		});
	});

	it("supports displays with negative global coordinates", () => {
		const leftDisplay = { x: -1_920, y: 0, width: 1_920, height: 1_080 };
		expect(clampCameraPreviewPosition({ x: -2_500, y: -20 }, size, leftDisplay)).toEqual({
			x: -1_920,
			y: 0,
		});
	});
});
