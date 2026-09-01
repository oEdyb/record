import { BrowserWindow, shell } from "electron";
import type { EntitlementSnapshot } from "../../src/lib/entitlements/contracts";
import type { RendererIpcMain } from "../ipc/trustedRendererIpc";
import type { EntitlementConfig } from "./config";
import type { EntitlementService } from "./service";

const ENTITLEMENT_CHANGED_CHANNEL = "entitlement:changed";

function broadcast(snapshot: EntitlementSnapshot) {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(ENTITLEMENT_CHANGED_CHANNEL, snapshot);
	}
}

export function registerEntitlementIpc(
	service: EntitlementService,
	config: EntitlementConfig,
	ipcMain: RendererIpcMain,
): void {
	for (const channel of [
		"entitlement:get",
		"entitlement:activate",
		"entitlement:refresh",
		"entitlement:deactivate",
		"entitlement:checkout",
		"entitlement:manage",
	]) {
		ipcMain.removeHandler(channel);
	}

	service.on("changed", broadcast);
	ipcMain.handle("entitlement:get", () => {
		return service.getSnapshot();
	});
	ipcMain.handle("entitlement:activate", (_event, licenseKey: unknown) => {
		if (typeof licenseKey !== "string") throw new TypeError("License key must be a string.");
		return service.activate(licenseKey);
	});
	ipcMain.handle("entitlement:refresh", () => {
		return service.refresh();
	});
	ipcMain.handle("entitlement:deactivate", () => {
		return service.deactivate();
	});
	ipcMain.handle("entitlement:checkout", async () => {
		if (!config.checkoutUrl) throw new Error("Klippt checkout is not configured yet.");
		await shell.openExternal(config.checkoutUrl);
		return { opened: true };
	});
	ipcMain.handle("entitlement:manage", async () => {
		if (!config.managementUrl) throw new Error("Subscription management is not configured yet.");
		await shell.openExternal(config.managementUrl);
		return { opened: true };
	});
}
