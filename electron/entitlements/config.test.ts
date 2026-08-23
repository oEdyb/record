import { afterEach, describe, expect, it, vi } from "vitest";
import { readEntitlementConfig } from "./config";

const ENV_KEYS = [
	"KLIPPT_LEMON_STORE_ID",
	"KLIPPT_LEMON_PRODUCT_ID",
	"KLIPPT_LEMON_VARIANT_IDS",
	"KLIPPT_CHECKOUT_URL",
	"KLIPPT_MANAGE_URL",
	"KLIPPT_ENTITLEMENT_PREVIEW",
] as const;

describe("readEntitlementConfig", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("fails open while public commerce identifiers are incomplete", () => {
		for (const key of ENV_KEYS) vi.stubEnv(key, "");

		expect(readEntitlementConfig({ isPackaged: true })).toMatchObject({
			commerceConfigured: false,
			trialDays: 14,
			offlineGraceDays: 7,
		});
	});

	it("enables commerce only with a complete HTTPS configuration", () => {
		vi.stubEnv("KLIPPT_LEMON_STORE_ID", "11");
		vi.stubEnv("KLIPPT_LEMON_PRODUCT_ID", "22");
		vi.stubEnv("KLIPPT_LEMON_VARIANT_IDS", "33,34");
		vi.stubEnv("KLIPPT_CHECKOUT_URL", "https://klippt.lemonsqueezy.com/checkout");

		const config = readEntitlementConfig({ isPackaged: true });
		expect(config.commerceConfigured).toBe(true);
		expect(config.variantIds).toEqual(new Set([33, 34]));
	});

	it("never allows the visual preview override in packaged builds", () => {
		for (const key of ENV_KEYS) vi.stubEnv(key, "");
		vi.stubEnv("KLIPPT_ENTITLEMENT_PREVIEW", "expired");

		expect(readEntitlementConfig({ isPackaged: true }).forceStatus).toBeUndefined();
		expect(readEntitlementConfig({ isPackaged: false }).forceStatus).toBe("expired");
	});
});
