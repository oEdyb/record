import { describe, expect, it } from "vitest";
import { defaultReviewChromeHeight, fitCompactReviewBounds } from "./compactReviewGeometry";

const laptop = { x: 0, y: 25, width: 1710, height: 1080 };

describe("fitCompactReviewBounds", () => {
	it("fits a 16:9 recording edge to edge with no padding", () => {
		const bounds = fitCompactReviewBounds(laptop, 16 / 9, 117);
		expect(bounds.width).toBe(960);
		expect(bounds.height).toBe(540 + 117);
		expect(bounds.x).toBe(375);
		expect(bounds.y + bounds.height).toBe(25 + 1080 - 96);
	});

	it("follows the recording's own shape, height-limited for tall footage", () => {
		const ultrawide = fitCompactReviewBounds(laptop, 21 / 9, 117);
		expect(ultrawide.height - 117).toBe(Math.round(960 / (21 / 9)));
		const portrait = fitCompactReviewBounds(laptop, 9 / 16, 117);
		expect(portrait.height).toBe(1080 - 96 - 16);
		expect(portrait.width).toBe(Math.max(480, Math.round((1080 - 96 - 16 - 117) * (9 / 16))));
	});

	it("stays on a small secondary display", () => {
		const bounds = fitCompactReviewBounds({ x: -1280, y: 0, width: 600, height: 500 });
		expect(bounds.width).toBeGreaterThanOrEqual(480);
		expect(bounds.x).toBeGreaterThanOrEqual(-1280);
		expect(bounds.y).toBeGreaterThanOrEqual(0);
		expect(bounds.height).toBeGreaterThanOrEqual(defaultReviewChromeHeight(16 / 9));
	});

	it("centres over a dragged pill and stays on screen at the edges", () => {
		expect(fitCompactReviewBounds(laptop, 16 / 9, 117, 600).x).toBe(120);
		expect(fitCompactReviewBounds(laptop, 16 / 9, 117, 100).x).toBe(0);
		expect(fitCompactReviewBounds(laptop, 16 / 9, 117, 1700).x).toBe(1710 - 960);
	});

	it("opens at the size the renderer will ask for, so loading does not resize it", () => {
		const macbook = { x: 0, y: 25, width: 1440, height: 875 };
		const ratio = 1440 / 932;
		const opened = fitCompactReviewBounds(macbook, ratio);
		const fitted = fitCompactReviewBounds(macbook, ratio, 60 + 12 - 24 / ratio);
		expect(opened).toEqual(fitted);
	});
});
