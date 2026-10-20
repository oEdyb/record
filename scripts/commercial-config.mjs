// Release-time view of electron/entitlements/commercial-config.json. The app's own reading
// lives in electron/entitlements/config.ts; this only answers "may this build be sold?".

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../electron/entitlements/commercial-config.json",
);

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const https = (value) => {
	try {
		return typeof value === "string" && new URL(value).protocol === "https:";
	} catch {
		return false;
	}
};

/** null when the live store is fully configured, else a sentence naming what is missing. */
export function commercialReleaseProblem(config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))) {
	const live = config?.live ?? {};
	const missing = [
		!positive(live.storeId) && "storeId",
		!positive(live.productId) && "productId",
		!(
			Array.isArray(live.variantIds) &&
			live.variantIds.length > 0 &&
			live.variantIds.every(positive)
		) && "variantIds",
		!https(live.checkoutUrl) && "checkoutUrl",
		!https(live.managementUrl) && "managementUrl",
	].filter(Boolean);
	return missing.length === 0
		? null
		: `The live Lemon Squeezy store is not configured (missing ${missing.join(", ")} in electron/entitlements/commercial-config.json); this build would give everyone full access for free.`;
}
