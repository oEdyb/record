import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS } from "../src/lib/shortcuts";

const shortcutState = vi.hoisted(() => ({
	blocked: new Set<string>(),
	registered: new Map<string, () => void>(),
}));

vi.mock("electron", () => ({
	globalShortcut: {
		register: vi.fn((accelerator: string, handler: () => void) => {
			if (shortcutState.blocked.has(accelerator) || shortcutState.registered.has(accelerator)) {
				return false;
			}
			shortcutState.registered.set(accelerator, handler);
			return true;
		}),
		unregister: vi.fn((accelerator: string) => shortcutState.registered.delete(accelerator)),
		unregisterAll: vi.fn(() => shortcutState.registered.clear()),
	},
}));

vi.mock("./ipc/handlers", () => ({ SHORTCUTS_FILE: "/tmp/klippt-shortcuts-test.json" }));

import {
	bindingToAccelerator,
	registerGlobalShortcuts,
	unregisterAllGlobalShortcuts,
} from "./globalShortcut";

describe("global shortcuts", () => {
	beforeEach(() => {
		unregisterAllGlobalShortcuts();
		shortcutState.blocked.clear();
		vi.clearAllMocks();
	});

	it("maps the default global bindings to Electron accelerators", () => {
		expect(bindingToAccelerator(DEFAULT_SHORTCUTS.openApp)).toBe("CommandOrControl+Shift+O");
		expect(bindingToAccelerator(DEFAULT_SHORTCUTS.toggleRecordingPause)).toBe(
			"CommandOrControl+Shift+Space",
		);
	});

	it("registers independent open-app and recording transport handlers", () => {
		const openApp = vi.fn();
		const toggleRecordingPause = vi.fn();

		expect(registerGlobalShortcuts(DEFAULT_SHORTCUTS, { openApp, toggleRecordingPause })).toBe(
			true,
		);

		shortcutState.registered.get("CommandOrControl+Shift+O")?.();
		shortcutState.registered.get("CommandOrControl+Shift+Space")?.();
		expect(openApp).toHaveBeenCalledTimes(1);
		expect(toggleRecordingPause).toHaveBeenCalledTimes(1);
	});

	it("restores the working set when another app owns a requested binding", () => {
		const handlers = { openApp: vi.fn(), toggleRecordingPause: vi.fn() };
		expect(registerGlobalShortcuts(DEFAULT_SHORTCUTS, handlers)).toBe(true);

		shortcutState.blocked.add("CommandOrControl+Shift+P");
		expect(
			registerGlobalShortcuts(
				{ ...DEFAULT_SHORTCUTS, toggleRecordingPause: { key: "p", ctrl: true, shift: true } },
				handlers,
			),
		).toBe(false);

		expect(shortcutState.registered.has("CommandOrControl+Shift+O")).toBe(true);
		expect(shortcutState.registered.has("CommandOrControl+Shift+Space")).toBe(true);
		expect(shortcutState.registered.has("CommandOrControl+Shift+P")).toBe(false);
	});
});
