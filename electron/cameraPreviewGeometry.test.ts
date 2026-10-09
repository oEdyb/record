import { describe, expect, it } from "vitest";
import {
	clampCameraPreviewPosition,
	clampCameraPreviewSize,
	defaultCameraPreviewPosition,
	expandedCameraPreviewBounds,
	resizedCameraPreviewSize,
} from "./cameraPreviewGeometry";

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

	it("expands to the largest centred 16:9 surface that fits inside the work area", () => {
		const bounds = expandedCameraPreviewBounds(workArea);

		// Width-limited: 1710 - 2 * (48 + 12) = 1590 wide surface, 894 tall, plus gutters.
		expect(bounds).toEqual({ x: 48, y: 106, width: 1_614, height: 918 });
		expect(bounds.width - 24).toBeLessThanOrEqual(workArea.width - 96);
		expect(bounds.height - 24).toBeLessThanOrEqual(workArea.height - 96);
		expect((bounds.width - 24) / (bounds.height - 24)).toBeCloseTo(16 / 9, 2);
	});

	it("expands width-limited on a portrait work area", () => {
		const bounds = expandedCameraPreviewBounds({ x: 100, y: 0, width: 1_000, height: 1_600 });

		expect(bounds).toEqual({ x: 148, y: 541, width: 904, height: 519 });
	});

	it("keeps a chosen size 16:9 between the compact size and the work area", () => {
		expect(clampCameraPreviewSize(100, workArea)).toEqual(size);
		expect(clampCameraPreviewSize(504, workArea)).toEqual({ width: 504, height: 294 });
		// Height-limited: (1082 - 24) * 16 / 9 = 1880 wide surface would not fit 1710.
		expect(clampCameraPreviewSize(9_999, workArea)).toEqual({ width: 1_710, height: 972 });
	});

	it("grows along the larger of the two drag axes and never below compact", () => {
		expect(resizedCameraPreviewSize(size, { x: 192, y: 0 }, workArea)).toEqual({
			width: 504,
			height: 294,
		});
		expect(resizedCameraPreviewSize(size, { x: 0, y: 108 }, workArea)).toEqual({
			width: 504,
			height: 294,
		});
		expect(resizedCameraPreviewSize(size, { x: -400, y: -400 }, workArea)).toEqual(size);
	});
});
