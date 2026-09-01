import type { App, WebContents } from "electron";

export interface TrustedRendererConfig {
	devServerUrl?: string;
}

export function isTrustedRendererUrl(rawUrl: string, config: TrustedRendererConfig): boolean {
	try {
		const url = new URL(rawUrl);
		if (config.devServerUrl && url.origin === new URL(config.devServerUrl).origin) return true;
		if (url.protocol === "klippt:" && url.host === "app" && url.pathname === "/index.html") {
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export function isTrustedWebContents(
	webContents: Pick<WebContents, "getURL"> | null,
	config: TrustedRendererConfig,
): boolean {
	return webContents !== null && isTrustedRendererUrl(webContents.getURL(), config);
}

/** Applies Electron's deny-by-default navigation and child-window guidance. */
export function installWebContentsSecurityGuards(
	app: Pick<App, "on">,
	config: TrustedRendererConfig,
): void {
	app.on("web-contents-created", (_event, contents) => {
		contents.on("will-navigate", (event, navigationUrl) => {
			if (!isTrustedRendererUrl(navigationUrl, config)) event.preventDefault();
		});
		contents.on("will-attach-webview", (event) => event.preventDefault());
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
	});
}
