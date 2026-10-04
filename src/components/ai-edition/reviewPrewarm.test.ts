import { describe, expect, it } from "vitest";
import { isPrewarmedReview } from "./reviewPrewarm";

describe("isPrewarmedReview", () => {
	it("is true only for the review Electron loads ahead of Stop", () => {
		expect(isPrewarmedReview("?windowType=editor&prewarm=1")).toBe(true);
		expect(isPrewarmedReview("?windowType=editor")).toBe(false);
	});
});
