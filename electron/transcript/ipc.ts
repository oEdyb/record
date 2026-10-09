import type { BrowserWindow } from "electron";
import type { RendererIpcMain } from "../ipc/trustedRendererIpc";
import type { LiveTranscriptService, TranscriptSnapshot } from "./liveTranscript";

export interface TranscriptIpcDeps {
	service: LiveTranscriptService;
	openWindow: () => BrowserWindow;
	getWindow: () => BrowserWindow | null;
}

/** Window-side contract: open, read, refresh, close. Snapshots are pushed as they change. */
export function registerTranscriptIpc(ipcMain: RendererIpcMain, deps: TranscriptIpcDeps) {
	ipcMain.handle("transcript-open", async () => {
		const existing = deps.getWindow();
		if (existing && !existing.isDestroyed()) {
			existing.focus();
			return { opened: true };
		}
		deps.openWindow();
		return { opened: true };
	});
	ipcMain.handle("transcript-snapshot", async () => deps.service.snapshot());
	ipcMain.handle("transcript-refresh", async () => deps.service.refresh());
	ipcMain.on("transcript-window-close", () => {
		const win = deps.getWindow();
		if (win && !win.isDestroyed()) win.close();
	});
}

export function sendTranscriptSnapshot(win: BrowserWindow | null, snapshot: TranscriptSnapshot) {
	if (win && !win.isDestroyed()) win.webContents.send("transcript-updated", snapshot);
}
