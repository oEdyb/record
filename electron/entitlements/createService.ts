import os from "node:os";
import { APP_DISPLAY_NAME } from "../../src/lib/brand";
import { readEntitlementConfig } from "./config";
import { LemonSqueezyLicenseProvider } from "./lemonSqueezyProvider";
import { createElectronSecretCodec } from "./secretCodec";
import { EntitlementService } from "./service";
import { createEntitlementStateStore } from "./stateStore";

export function createEntitlementService(options: { userDataPath: string; isPackaged: boolean }) {
	const config = readEntitlementConfig({ isPackaged: options.isPackaged });
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
	return { config, service };
}
