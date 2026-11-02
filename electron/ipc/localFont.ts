import { BrowserWindow, dialog, type WebContents } from "electron";
import {
	type ChooseLocalFontRequest,
	type ChooseLocalFontResult,
	LocalFontValidationError,
} from "../../src/lib/localFont";
import { readLocalFontDataUrl } from "../media/localFontFile";
import type { RendererIpcMain } from "./trustedRendererIpc";

function isValidRequest(value: unknown): value is ChooseLocalFontRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	return (
		typeof request.family === "string" &&
		request.family.trim().length > 0 &&
		request.family.length <= 256 &&
		(request.style === "normal" || request.style === "italic") &&
		typeof request.weight === "number" &&
		Number.isFinite(request.weight) &&
		request.weight >= 1 &&
		request.weight <= 1000 &&
		typeof request.styleLabel === "string" &&
		request.styleLabel.trim().length > 0 &&
		request.styleLabel.length <= 80
	);
}

export async function chooseLocalFont(
	value: unknown,
	sender: WebContents,
): Promise<ChooseLocalFontResult> {
	if (!isValidRequest(value)) {
		return { success: false, canceled: false, error: "invalid-request" };
	}
	const family = value.family.trim();
	const styleLabel = value.styleLabel.trim();
	const options: Electron.OpenDialogOptions = {
		title: `${family} · ${styleLabel} ${value.weight}`,
		filters: [{ name: "TTF, OTF, WOFF, WOFF2", extensions: ["ttf", "otf", "woff", "woff2"] }],
		properties: ["openFile"],
	};
	let selected: Electron.OpenDialogReturnValue;
	try {
		const parent = BrowserWindow.fromWebContents(sender);
		selected = parent
			? await dialog.showOpenDialog(parent, options)
			: await dialog.showOpenDialog(options);
	} catch (error) {
		console.error("Could not open the local font picker:", error);
		return { success: false, canceled: false, error: "picker-failed" };
	}
	if (selected.canceled || selected.filePaths.length === 0) {
		return { success: false, canceled: true };
	}
	if (selected.filePaths.length !== 1) {
		return { success: false, canceled: false, error: "invalid-request" };
	}
	try {
		const dataUrl = await readLocalFontDataUrl(selected.filePaths[0]);
		return { success: true, canceled: false, dataUrl };
	} catch (error) {
		if (error instanceof LocalFontValidationError) {
			return { success: false, canceled: false, error: error.code };
		}
		console.error("Could not import the selected local font:", error);
		return { success: false, canceled: false, error: "read-failed" };
	}
}

export function registerLocalFontIpc(ipcMain: Pick<RendererIpcMain, "handle">): void {
	ipcMain.handle("choose-local-font", (event, request: unknown) =>
		chooseLocalFont(request, event.sender),
	);
}
