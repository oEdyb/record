import type { RendererIpcMain } from "../ipc/trustedRendererIpc";
import type { StudioController } from "./studioController";
import type { StudioCommand } from "./types";

const COMMANDS = new Set<StudioCommand>([
	"record",
	"pause",
	"resume",
	"stop",
	"remove-last",
	"pill",
]);

/** Studio window contract: read the take, ask for a command. The pill opens the Studio. */
export function registerStudioIpc(ipcMain: RendererIpcMain, studio: StudioController) {
	ipcMain.handle("studio-open", () => {
		studio.open();
		return { opened: true };
	});
	ipcMain.handle("studio-snapshot", () => studio.snapshot());
	ipcMain.on("studio-command", (_event, command: unknown) => {
		if (typeof command === "string" && COMMANDS.has(command as StudioCommand))
			studio.command(command as StudioCommand);
	});
}
