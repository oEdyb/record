import os from "node:os";
import { powerMonitor } from "electron";
import { APP_DISPLAY_NAME } from "../../src/lib/brand";
import { readEntitlementConfig } from "./config";
import { LemonSqueezyLicenseProvider } from "./lemonSqueezyProvider";
import { startEntitlementRevalidation } from "./revalidation";
import { createElectronSecretCodec } from "./secretCodec";
import { EntitlementService } from "./service";
import { createEntitlementStateStore } from "./stateStore";

export function createEntitlementService(options: { userDataPath: string; isPackaged: boolean }) {
	const config = readEntitlementConfig({ isPackaged: options.isPackaged });
	if (config.testMode) console.info("Klippt commerce is in Lemon Squeezy test mode.");
	const provider =
		config.storeId && config.productId && config.variantIds.size > 0
			? new LemonSqueezyLicenseProvider({
					storeId: config.storeId,
					productId: config.productId,
					variantIds: config.variantIds,
				})
			: undefined;
	const service = new EntitlementService({
		config,
		provider,
		codec: createElectronSecretCodec(),
		store: createEntitlementStateStore(options.userDataPath),
		instanceName: `${APP_DISPLAY_NAME} on ${os.hostname()}`,
	});
	if (provider && config.commerceConfigured && !config.forceStatus) {
		startEntitlementRevalidation({
			refresh: () => service.refresh(),
			intervalMs: config.revalidateEveryHours * 60 * 60 * 1_000,
			onResume: (listener) => {
				powerMonitor.on("resume", listener);
				return () => powerMonitor.removeListener("resume", listener);
			},
		});
	}
	return { config, service };
}
