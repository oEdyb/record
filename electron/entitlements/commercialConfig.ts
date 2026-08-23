/**
 * Public Lemon Squeezy identifiers for signed production builds.
 *
 * These values are not secrets. Keep API keys and webhook secrets out of the
 * desktop app. Environment variables override these values for local testing.
 */
export const KLIPPT_COMMERCIAL_CONFIG: {
	storeId?: number;
	productId?: number;
	variantIds: readonly number[];
	checkoutUrl?: string;
	managementUrl?: string;
} = {
	variantIds: [],
};
