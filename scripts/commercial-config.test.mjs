import { describe, expect, it } from "vitest";
import { commercialReleaseProblem } from "./commercial-config.mjs";

const live = {
	storeId: 1,
	productId: 2,
	variantIds: [3, 4],
	checkoutUrl: "https://klippt.lemonsqueezy.com/checkout/buy/x",
	managementUrl: "https://klippt.lemonsqueezy.com/billing",
};

describe("commercialReleaseProblem", () => {
	it("accepts a complete live store", () => {
		expect(commercialReleaseProblem({ live })).toBeNull();
	});

	it("names each missing live identifier", () => {
		expect(
			commercialReleaseProblem({ live: { ...live, variantIds: [], checkoutUrl: "http://x" } }),
		).toMatch(/missing variantIds, checkoutUrl/);
		expect(commercialReleaseProblem({})).toMatch(/storeId, productId/);
	});
});
