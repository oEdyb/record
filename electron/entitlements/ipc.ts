import { BrowserWindow, type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import type { EntitlementSnapshot } from "../../src/lib/entitlements/contracts";
import type { EntitlementConfig } from "./config";
import type { EntitlementService } from "./service";

const ENTITLEMENT_CHANGED_CHANNEL = "entitlement:changed";

function broadcast(snapshot: EntitlementSnapshot) {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(ENTITLEMENT_CHANGED_CHANNEL, snapshot);
	}
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
	const frameUrl = event.senderFrame?.url;
	if (!frameUrl) throw new Error("Entitlement request has no sender frame.");
	const url = new URL(frameUrl);
	const configuredDevOrigin = process.env.VITE_DEV_SERVER_URL
		? new URL(process.env.VITE_DEV_SERVER_URL).origin
		: null;
	const localDevelopmentOrigin =
		(url.protocol === "http:" || url.protocol === "https:") &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
		(!configuredDevOrigin || url.origin === configuredDevOrigin);
	if (url.protocol !== "file:" && !localDevelopmentOrigin) {
		throw new Error("Entitlement request came from an untrusted frame.");
	}
}

export function registerEntitlementIpc(
	service: EntitlementService,
	config: EntitlementConfig,
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
	ipcMain.handle("entitlement:get", (event) => {
		assertTrustedSender(event);
		return service.getSnapshot();
	});
	ipcMain.handle("entitlement:activate", (event, licenseKey: unknown) => {
		assertTrustedSender(event);
		if (typeof licenseKey !== "string") throw new TypeError("License key must be a string.");
		return service.activate(licenseKey);
	});
	ipcMain.handle("entitlement:refresh", (event) => {
		assertTrustedSender(event);
		return service.refresh();
	});
	ipcMain.handle("entitlement:deactivate", (event) => {
		assertTrustedSender(event);
		return service.deactivate();
	});
	ipcMain.handle("entitlement:checkout", async (event) => {
		assertTrustedSender(event);
		if (!config.checkoutUrl) throw new Error("Klippt checkout is not configured yet.");
		await shell.openExternal(config.checkoutUrl);
		return { opened: true };
	});
	ipcMain.handle("entitlement:manage", async (event) => {
		assertTrustedSender(event);
		if (!config.managementUrl) throw new Error("Subscription management is not configured yet.");
		await shell.openExternal(config.managementUrl);
		return { opened: true };
	});
}
