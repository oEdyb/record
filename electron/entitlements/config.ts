import { KLIPPT_COMMERCIAL_CONFIG } from "./commercialConfig";

export interface EntitlementConfig {
	commerceConfigured: boolean;
	checkoutUrl?: string;
	managementUrl?: string;
	trialDays: number;
	offlineGraceDays: number;
	storeId?: number;
	productId?: number;
	variantIds: ReadonlySet<number>;
	forceStatus?: "trial-not-started" | "trial-active" | "licensed" | "expired";
}

function positiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveIntegerSet(value: string | undefined): ReadonlySet<number> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((item) => positiveInteger(item.trim()))
			.filter((item): item is number => item !== undefined),
	);
}

function secureUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

export function readEntitlementConfig(options: { isPackaged: boolean }): EntitlementConfig {
	const storeId =
		positiveInteger(process.env.KLIPPT_LEMON_STORE_ID) ?? KLIPPT_COMMERCIAL_CONFIG.storeId;
	const productId =
		positiveInteger(process.env.KLIPPT_LEMON_PRODUCT_ID) ?? KLIPPT_COMMERCIAL_CONFIG.productId;
	const environmentVariantIds = positiveIntegerSet(process.env.KLIPPT_LEMON_VARIANT_IDS);
	const variantIds =
		environmentVariantIds.size > 0
			? environmentVariantIds
			: new Set(KLIPPT_COMMERCIAL_CONFIG.variantIds);
	const checkoutUrl = secureUrl(
		process.env.KLIPPT_CHECKOUT_URL ?? KLIPPT_COMMERCIAL_CONFIG.checkoutUrl,
	);
	const managementUrl = secureUrl(
		process.env.KLIPPT_MANAGE_URL ?? KLIPPT_COMMERCIAL_CONFIG.managementUrl,
	);
	const commerceConfigured = Boolean(storeId && productId && variantIds.size > 0 && checkoutUrl);
	const requestedForceStatus = process.env.KLIPPT_ENTITLEMENT_PREVIEW;
	const forceStatus =
		!options.isPackaged &&
		(requestedForceStatus === "trial-not-started" ||
			requestedForceStatus === "trial-active" ||
			requestedForceStatus === "licensed" ||
			requestedForceStatus === "expired")
			? requestedForceStatus
			: undefined;

	return {
		commerceConfigured: commerceConfigured || forceStatus !== undefined,
		checkoutUrl,
		managementUrl,
		trialDays: 14,
		offlineGraceDays: 7,
		storeId,
		productId,
		variantIds,
		forceStatus,
	};
}
