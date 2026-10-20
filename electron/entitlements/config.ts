import commercialConfig from "./commercial-config.json";

export interface EntitlementConfig {
	commerceConfigured: boolean;
	testMode: boolean;
	checkoutUrl?: string;
	managementUrl?: string;
	trialDays: number;
	offlineGraceDays: number;
	revalidateEveryHours: number;
	storeId?: number;
	productId?: number;
	variantIds: ReadonlySet<number>;
	forceStatus?: "trial-not-started" | "trial-active" | "licensed" | "expired";
}

interface CommerceIdentifiers {
	storeId?: number;
	productId?: number;
	variantIds: ReadonlySet<number>;
	checkoutUrl?: string;
	managementUrl?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function positiveInteger(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveIntegerSet(values: readonly unknown[]): ReadonlySet<number> {
	return new Set(
		values
			.map((item) => positiveInteger(typeof item === "string" ? item.trim() : item))
			.filter((item): item is number => item !== undefined),
	);
}

function secureUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** Reads one `live` or `test` block of commercial-config.json without trusting its shape. */
export function readCommerceIdentifiers(block: unknown): CommerceIdentifiers {
	const value: Record<string, unknown> =
		block && typeof block === "object" ? Object.fromEntries(Object.entries(block)) : {};
	return {
		storeId: positiveInteger(value.storeId),
		productId: positiveInteger(value.productId),
		variantIds: positiveIntegerSet(Array.isArray(value.variantIds) ? value.variantIds : []),
		checkoutUrl: secureUrl(value.checkoutUrl),
		managementUrl: secureUrl(value.managementUrl),
	};
}

export function isCommerceComplete(ids: CommerceIdentifiers): boolean {
	return Boolean(ids.storeId && ids.productId && ids.variantIds.size > 0 && ids.checkoutUrl);
}

/** Development builds may point at another store through the environment; shipped builds may not,
 *  or anyone could activate a key from their own store. */
function withEnvironmentOverrides(ids: CommerceIdentifiers, env: Environment): CommerceIdentifiers {
	const variantIds = positiveIntegerSet((env.KLIPPT_LEMON_VARIANT_IDS ?? "").split(","));
	return {
		storeId: positiveInteger(env.KLIPPT_LEMON_STORE_ID) ?? ids.storeId,
		productId: positiveInteger(env.KLIPPT_LEMON_PRODUCT_ID) ?? ids.productId,
		variantIds: variantIds.size > 0 ? variantIds : ids.variantIds,
		checkoutUrl: secureUrl(env.KLIPPT_CHECKOUT_URL) ?? ids.checkoutUrl,
		managementUrl: secureUrl(env.KLIPPT_MANAGE_URL) ?? ids.managementUrl,
	};
}

export function readEntitlementConfig(options: {
	isPackaged: boolean;
	env?: Environment;
	commercial?: { live?: unknown; test?: unknown };
}): EntitlementConfig {
	const env = options.env ?? process.env;
	const commercial = options.commercial ?? commercialConfig;
	const live = readCommerceIdentifiers(commercial.live);
	// Test mode exists to rehearse a purchase before launch. A shipped build with live store
	// identifiers never accepts test-mode keys.
	const testMode =
		env.KLIPPT_COMMERCE_MODE === "test" && (!options.isPackaged || !isCommerceComplete(live));
	const selected = testMode ? readCommerceIdentifiers(commercial.test) : live;
	const ids = options.isPackaged ? selected : withEnvironmentOverrides(selected, env);

	const requestedForceStatus = env.KLIPPT_ENTITLEMENT_PREVIEW;
	const forceStatus =
		!options.isPackaged &&
		(requestedForceStatus === "trial-not-started" ||
			requestedForceStatus === "trial-active" ||
			requestedForceStatus === "licensed" ||
			requestedForceStatus === "expired")
			? requestedForceStatus
			: undefined;

	return {
		commerceConfigured: isCommerceComplete(ids) || forceStatus !== undefined,
		testMode,
		checkoutUrl: ids.checkoutUrl,
		managementUrl: ids.managementUrl,
		trialDays: 14,
		offlineGraceDays: 7,
		revalidateEveryHours: 12,
		storeId: ids.storeId,
		productId: ids.productId,
		variantIds: ids.variantIds,
		forceStatus,
	};
}
