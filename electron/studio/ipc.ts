import { normalizeRecordingQuality } from "../../src/lib/recording/recordingQuality";
import type { RendererIpcMain } from "../ipc/trustedRendererIpc";
import type { StudioController } from "./studioController";
import type { StudioCommand, StudioPillState, StudioSimpleCommand } from "./types";

const SIMPLE_COMMANDS = new Set<StudioSimpleCommand>([
	"record",
	"pause",
	"resume",
	"stop",
	"remove-last",
	"undo-remove",
	"pill",
	"toggle-mic",
	"toggle-camera",
	"toggle-system-audio",
	"choose-source",
	"open-notes",
	"cancel-countdown",
	"record-more",
	"finish",
]);

const CURSOR_MODES = new Set(["system", "editable-overlay"]);

/** A command from the Studio page, checked field by field; anything else is dropped. */
export function parseStudioCommand(raw: unknown): StudioCommand | null {
	if (typeof raw === "string")
		return SIMPLE_COMMANDS.has(raw as StudioSimpleCommand) ? (raw as StudioSimpleCommand) : null;
	if (!raw || typeof raw !== "object") return null;
	const command = raw as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 512) : null);
	if (command.kind === "select-mic" || command.kind === "select-camera") {
		const deviceId = text(command.deviceId);
		const name = text(command.name);
		return deviceId && name !== null ? { kind: command.kind, deviceId, name } : null;
	}
	if (command.kind === "set-quality")
		return { kind: "set-quality", value: normalizeRecordingQuality(command.value) };
	if (command.kind === "set-cursor" && CURSOR_MODES.has(command.value as string))
		return { kind: "set-cursor", value: command.value as "system" | "editable-overlay" };
	return null;
}

export function parsePillState(raw: unknown): StudioPillState | null {
	if (!raw || typeof raw !== "object") return null;
	const state = raw as Record<string, unknown>;
	const flag = (value: unknown) => value === true;
	const index = state.undoClipIndex;
	return {
		controlsLocked: flag(state.controlsLocked),
		canRemovePreviousClip: flag(state.canRemovePreviousClip),
		undoClipIndex: typeof index === "number" && Number.isInteger(index) ? index : null,
		countingDown: flag(state.countingDown),
		saving: flag(state.saving),
		transportBusy: flag(state.transportBusy),
		canPause: flag(state.canPause),
	};
}

/** Studio window contract: read the take, ask for a command. The pill opens the Studio. */
export function registerStudioIpc(ipcMain: RendererIpcMain, studio: StudioController) {
	ipcMain.handle("studio-open", () => {
		studio.open();
		return { opened: true };
	});
	ipcMain.handle("studio-snapshot", () => studio.snapshot());
	ipcMain.on("studio-command", (_event, raw: unknown) => {
		const command = parseStudioCommand(raw);
		if (command) studio.command(command);
	});
	ipcMain.on("studio-pill-needs-user", () => studio.pillNeedsUser());
	ipcMain.on("studio-pill-state", (_event, raw: unknown) => {
		const state = parsePillState(raw);
		if (state) studio.setPillState(state);
	});
}
