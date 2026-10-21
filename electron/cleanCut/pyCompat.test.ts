import { describe, expect, it } from "vitest";
import { fixed, roundHalfEven } from "./pyCompat";
import { similarity } from "./similar";

describe("python compatible numbers", () => {
	it("rounds ties to the even integer", () => {
		expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(roundHalfEven)).toEqual([
			0, 2, 2, -0, -2, 2, 3,
		]);
	});

	it("formats ties to the even digit and everything else like toFixed", () => {
		expect(fixed(23.25, 1)).toBe("23.2");
		expect(fixed(23.75, 1)).toBe("23.8");
		expect(fixed(0.125, 2)).toBe("0.12");
		expect(fixed(0.35, 1)).toBe("0.3");
		expect(fixed(1.04, 1)).toBe("1.0");
	});

	it("scores string similarity like difflib", () => {
		expect(similarity("bigram", "biogram")).toBeCloseTo(0.9230769230769231, 12);
		expect(similarity("trigrams", "bigrams")).toBeCloseTo(0.8, 12);
		expect(similarity("tutorial", "tutorails")).toBeCloseTo(0.8235294117647058, 12);
	});
});
