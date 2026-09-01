import type {
	DisplayMediaRequestHandlerHandlerRequest,
	IpcMain,
	IpcMainEvent,
	IpcMainInvokeEvent,
	PermissionCheckHandlerHandlerDetails,
	PermissionRequest,
	WebContents,
	WebFrameMain,
} from "electron";
import type { TrustedRendererConfig } from "../security";

export type RendererIpcMain = Pick<
	IpcMain,
	"handle" | "on" | "once" | "removeAllListeners" | "removeHandler"
>;

type RendererIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

const isTrustedRendererPageUrl = (rawUrl: string, config: TrustedRendererConfig): boolean => {
	try {
		const url = new URL(rawUrl);
		if (config.devServerUrl && url.origin === new URL(config.devServerUrl).origin) return true;
		return url.protocol === "klippt:" && url.host === "app" && url.pathname === "/index.html";
	} catch {
		return false;
	}
};

const isTrustedRendererOrigin = (rawOrigin: string, config: TrustedRendererConfig): boolean => {
	try {
		const origin = new URL(rawOrigin);
		if (config.devServerUrl && origin.origin === new URL(config.devServerUrl).origin) return true;
		return origin.protocol === "klippt:" && origin.host === "app";
	} catch {
		return false;
	}
};

export function isTrustedMainFrame(
	frame: Pick<WebFrameMain, "parent" | "url"> | null,
	config: TrustedRendererConfig,
): boolean {
	return frame !== null && frame.parent === null && isTrustedRendererPageUrl(frame.url, config);
}

export function isTrustedIpcSender(
	event: Pick<RendererIpcEvent, "sender" | "senderFrame">,
	config: TrustedRendererConfig,
): boolean {
	const frame = event.senderFrame;
	return isTrustedMainFrame(frame, config) && frame !== null && event.sender.mainFrame === frame;
}

export function isTrustedPermissionCheck(
	webContents: Pick<WebContents, "getURL"> | null,
	requestingOrigin: string,
	details: Pick<PermissionCheckHandlerHandlerDetails, "isMainFrame" | "requestingUrl">,
	config: TrustedRendererConfig,
): boolean {
	return (
		webContents !== null &&
		details.isMainFrame &&
		isTrustedRendererOrigin(requestingOrigin, config) &&
		isTrustedRendererPageUrl(webContents.getURL(), config) &&
		isTrustedRendererPageUrl(details.requestingUrl ?? webContents.getURL(), config)
	);
}

export function isTrustedPermissionRequest(
	webContents: Pick<WebContents, "getURL">,
	details: Pick<PermissionRequest, "isMainFrame" | "requestingUrl">,
	config: TrustedRendererConfig,
): boolean {
	return (
		details.isMainFrame &&
		isTrustedRendererPageUrl(details.requestingUrl, config) &&
		isTrustedRendererPageUrl(webContents.getURL(), config)
	);
}

export function isTrustedDisplayMediaRequest(
	request: Pick<DisplayMediaRequestHandlerHandlerRequest, "frame" | "securityOrigin">,
	config: TrustedRendererConfig,
): boolean {
	return (
		isTrustedRendererOrigin(request.securityOrigin, config) &&
		isTrustedMainFrame(request.frame, config)
	);
}

/**
 * Validates every renderer message before it reaches an application handler.
 * A rejected one-shot message does not consume the trusted listener.
 */
export function createTrustedRendererIpcMain(
	target: IpcMain,
	config: TrustedRendererConfig,
): RendererIpcMain {
	const trusted: RendererIpcMain = {
		handle(channel, listener) {
			target.handle(channel, (event, ...args) => {
				if (!isTrustedIpcSender(event, config)) {
					throw new Error("Untrusted IPC sender.");
				}
				return listener(event, ...args);
			});
		},
		on(channel, listener) {
			target.on(channel, (event, ...args) => {
				if (isTrustedIpcSender(event, config)) listener(event, ...args);
			});
			return target;
		},
		once(channel, listener) {
			const guardedListener: Parameters<IpcMain["on"]>[1] = (event, ...args) => {
				if (!isTrustedIpcSender(event, config)) return;
				target.removeListener(channel, guardedListener);
				listener(event, ...args);
			};
			target.on(channel, guardedListener);
			return target;
		},
		removeAllListeners(channel) {
			return target.removeAllListeners(channel);
		},
		removeHandler(channel) {
			target.removeHandler(channel);
		},
	};
	return trusted;
}
