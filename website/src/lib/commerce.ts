import commercialConfig from "../../../electron/entitlements/commercial-config.json";

/** The same live checkout the app opens, from the one config file both read. */
export const CHECKOUT_URL: string | null =
	typeof commercialConfig.live.checkoutUrl === "string" &&
	commercialConfig.live.checkoutUrl.startsWith("https://")
		? commercialConfig.live.checkoutUrl
		: null;

export const SUPPORT_EMAIL = "support@klippt.app";
