import { describe, expect, it } from "vitest";
import { readEntitlementConfig } from "./config";

const LIVE = {
	storeId: 11,
	productId: 22,
	variantIds: [33, 34],
	checkoutUrl: "https://klippt.lemonsqueezy.com/checkout/buy/live",
	managementUrl: "https://klippt.lemonsqueezy.com/billing",
};
const TEST = {
	storeId: 11,
	productId: 77,
	variantIds: [88],
	checkoutUrl: "https://klippt.lemonsqueezy.com/checkout/buy/test",
};
const EMPTY = { storeId: null, productId: null, variantIds: [], checkoutUrl: null };
const STORE_OVERRIDE = {
	KLIPPT_LEMON_STORE_ID: "99",
	KLIPPT_LEMON_PRODUCT_ID: "98",
	KLIPPT_LEMON_VARIANT_IDS: "97",
	KLIPPT_CHECKOUT_URL: "https://attacker.example/checkout",
};

describe("readEntitlementConfig", () => {
	it("fails open while public commerce identifiers are incomplete", () => {
		expect(
			readEntitlementConfig({
				isPackaged: true,
				env: {},
				commercial: { live: EMPTY, test: EMPTY },
			}),
		).toMatchObject({
			commerceConfigured: false,
			testMode: false,
			trialDays: 14,
			offlineGraceDays: 7,
		});
	});

	it("enables commerce only with a complete HTTPS configuration", () => {
		const config = readEntitlementConfig({ isPackaged: true, env: {}, commercial: { live: LIVE } });
		expect(config.commerceConfigured).toBe(true);
		expect(config.variantIds).toEqual(new Set([33, 34]));

		const insecure = { ...LIVE, checkoutUrl: "http://klippt.lemonsqueezy.com/checkout" };
		expect(
			readEntitlementConfig({ isPackaged: true, env: {}, commercial: { live: insecure } })
				.commerceConfigured,
		).toBe(false);
	});

	it("ignores store overrides from the environment in shipped builds", () => {
		const packaged = readEntitlementConfig({
			isPackaged: true,
			env: STORE_OVERRIDE,
			commercial: { live: LIVE },
		});
		expect(packaged).toMatchObject({ storeId: 11, productId: 22 });
		expect(packaged.checkoutUrl).toBe(LIVE.checkoutUrl);

		const development = readEntitlementConfig({
			isPackaged: false,
			env: STORE_OVERRIDE,
			commercial: { live: LIVE },
		});
		expect(development).toMatchObject({ storeId: 99, productId: 98 });
		expect(development.variantIds).toEqual(new Set([97]));
	});

	it("uses the test store only on request and never beside a live store in a shipped build", () => {
		const env = { KLIPPT_COMMERCE_MODE: "test" };
		const prelaunch = readEntitlementConfig({
			isPackaged: true,
			env,
			commercial: { live: EMPTY, test: TEST },
		});
		expect(prelaunch).toMatchObject({ testMode: true, productId: 77, commerceConfigured: true });

		const launched = readEntitlementConfig({
			isPackaged: true,
			env,
			commercial: { live: LIVE, test: TEST },
		});
		expect(launched).toMatchObject({ testMode: false, productId: 22 });

		const development = readEntitlementConfig({
			isPackaged: false,
			env,
			commercial: { live: LIVE, test: TEST },
		});
		expect(development).toMatchObject({ testMode: true, productId: 77 });

		expect(
			readEntitlementConfig({ isPackaged: true, env: {}, commercial: { live: EMPTY, test: TEST } })
				.testMode,
		).toBe(false);
	});

	it("never allows the visual preview override in packaged builds", () => {
		const env = { KLIPPT_ENTITLEMENT_PREVIEW: "expired" };
		const commercial = { live: EMPTY };
		expect(
			readEntitlementConfig({ isPackaged: true, env, commercial }).forceStatus,
		).toBeUndefined();
		expect(readEntitlementConfig({ isPackaged: false, env, commercial }).forceStatus).toBe(
			"expired",
		);
	});
});
