import fs from "node:fs/promises";
import { globalShortcut } from "electron";
import {
	DEFAULT_SHORTCUTS,
	mergeWithDefaults,
	type ShortcutBinding,
	type ShortcutsConfig,
} from "../src/lib/shortcuts";
import { SHORTCUTS_FILE } from "./ipc/handlers";

type GlobalShortcutAction = "openApp" | "toggleRecordingPause";
export type GlobalShortcutBindings = Pick<ShortcutsConfig, GlobalShortcutAction>;
export type GlobalShortcutHandlers = Record<GlobalShortcutAction, () => void>;

const GLOBAL_SHORTCUT_ACTIONS: readonly GlobalShortcutAction[] = [
	"openApp",
	"toggleRecordingPause",
];

// Maps KeyboardEvent.key values to Electron accelerator key names.
const KEY_TO_ACCELERATOR: Record<string, string> = {
	" ": "Space",
	"+": "Plus",
	"-": "numsub",
	"*": "nummult",
	"/": "numdiv",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	escape: "Escape",
	enter: "Return",
	backspace: "Backspace",
	delete: "Delete",
	tab: "Tab",
};

export function bindingToAccelerator(binding: ShortcutBinding): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push("CommandOrControl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");

	const keyLower = binding.key.toLowerCase();
	parts.push(KEY_TO_ACCELERATOR[keyLower] ?? binding.key.toUpperCase());
	return parts.join("+");
}

interface RegisteredShortcut {
	accelerator: string;
	handler: () => void;
}

let registeredShortcuts: Partial<Record<GlobalShortcutAction, RegisteredShortcut>> = {};

/**
 * Replaces the app-wide shortcuts as one set.
 *
 * Electron cannot register a new binding while our old binding still owns the
 * same accelerator, which matters when two actions are swapped. Unregister the
 * old set first, then restore it if any new registration fails. The user never
 * loses a working shortcut because another app claimed the requested binding.
 */
export function registerGlobalShortcuts(
	bindings: GlobalShortcutBindings,
	handlers: GlobalShortcutHandlers,
): boolean {
	const desired = Object.fromEntries(
		GLOBAL_SHORTCUT_ACTIONS.map((action) => [
			action,
			{ accelerator: bindingToAccelerator(bindings[action]), handler: handlers[action] },
		]),
	) as Record<GlobalShortcutAction, RegisteredShortcut>;

	const unchanged = GLOBAL_SHORTCUT_ACTIONS.every(
		(action) => registeredShortcuts[action]?.accelerator === desired[action].accelerator,
	);
	if (unchanged) return true;

	const previous = { ...registeredShortcuts };
	for (const shortcut of Object.values(registeredShortcuts)) {
		if (shortcut) globalShortcut.unregister(shortcut.accelerator);
	}
	registeredShortcuts = {};

	for (const action of GLOBAL_SHORTCUT_ACTIONS) {
		const shortcut = desired[action];
		if (!globalShortcut.register(shortcut.accelerator, shortcut.handler)) {
			for (const registered of Object.values(registeredShortcuts)) {
				if (registered) globalShortcut.unregister(registered.accelerator);
			}
			registeredShortcuts = {};
			for (const previousAction of GLOBAL_SHORTCUT_ACTIONS) {
				const previousShortcut = previous[previousAction];
				if (
					previousShortcut &&
					globalShortcut.register(previousShortcut.accelerator, previousShortcut.handler)
				) {
					registeredShortcuts[previousAction] = previousShortcut;
				}
			}
			console.warn(`Failed to register global shortcut: ${shortcut.accelerator}`);
			return false;
		}
		registeredShortcuts[action] = shortcut;
	}

	console.info(
		`Global shortcuts registered: ${GLOBAL_SHORTCUT_ACTIONS.map((action) => desired[action].accelerator).join(", ")}`,
	);
	return true;
}

export async function loadAndRegisterGlobalShortcuts(
	handlers: GlobalShortcutHandlers,
): Promise<boolean> {
	let shortcuts = DEFAULT_SHORTCUTS;
	try {
		const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
		shortcuts = mergeWithDefaults(JSON.parse(data) as Partial<ShortcutsConfig>);
	} catch {
		// The defaults are the safe first-run and invalid-file fallback.
	}

	const registered = registerGlobalShortcuts(shortcuts, handlers);
	if (registered) return true;

	// A conflicting Pause binding must not also disable the established Open App
	// shortcut on startup. The settings UI will report the conflict when the user
	// next saves, while the primary global entry point keeps working.
	const openAppAccelerator = bindingToAccelerator(shortcuts.openApp);
	if (globalShortcut.register(openAppAccelerator, handlers.openApp)) {
		registeredShortcuts.openApp = {
			accelerator: openAppAccelerator,
			handler: handlers.openApp,
		};
	}
	return false;
}

export function unregisterAllGlobalShortcuts(): void {
	globalShortcut.unregisterAll();
	registeredShortcuts = {};
}
