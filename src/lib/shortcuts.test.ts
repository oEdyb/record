import { describe, expect, it } from "vitest";
import {
	DEFAULT_SHORTCUTS,
	findConflict,
	mergeWithDefaults,
	SHORTCUT_ACTIONS,
	SHORTCUT_LABELS,
	type ShortcutsConfig,
} from "./shortcuts";

describe("shortcut registry", () => {
	// Every action in the list is offered by ShortcutsConfigDialog and matched by
	// findConflict. An action that has no default binding, or a default binding
	// nothing dispatches, becomes a phantom the user can collide with — which is
	// exactly what "addBlur" was before it was removed.
	it("gives every action a default binding and a label", () => {
		for (const action of SHORTCUT_ACTIONS) {
			expect(DEFAULT_SHORTCUTS[action], `${action} has no default binding`).toBeDefined();
			expect(SHORTCUT_LABELS[action], `${action} has no label`).toBeTruthy();
		}
		expect(Object.keys(DEFAULT_SHORTCUTS).sort()).toEqual([...SHORTCUT_ACTIONS].sort());
	});

	it("leaves a plain 'b' free to bind", () => {
		// The blur *region* was never implemented — blur ships as an annotation
		// type. While `addBlur: {key: "b"}` was still in the registry, binding B to
		// any real action reported "Already used by Add Blur" and offered a Swap
		// that handed the old binding to a hidden, undispatched action.
		expect(findConflict({ key: "b" }, "playPause", DEFAULT_SHORTCUTS)).toBeNull();
	});

	it("still reports a real collision", () => {
		expect(findConflict({ key: " " }, "openApp", DEFAULT_SHORTCUTS)).toEqual({
			type: "configurable",
			action: "playPause",
		});
	});

	it("reserves the review keys, including the menu's command keys", () => {
		expect(findConflict({ key: "s", ctrl: true }, "playPause", DEFAULT_SHORTCUTS)).toMatchObject({
			type: "fixed",
			i18nKey: "saveVideo",
		});
		expect(findConflict({ key: "j" }, "playPause", DEFAULT_SHORTCUTS)).toMatchObject({
			type: "fixed",
			i18nKey: "skipSecond",
		});
	});

	it("ignores stored bindings for actions that no longer exist", () => {
		// mergeWithDefaults iterates SHORTCUT_ACTIONS, so a config saved before an
		// action was dropped loads without a migration.
		const stored = { playPause: { key: "q" }, addZoom: { key: "z" }, addBlur: { key: "b" } };
		const merged = mergeWithDefaults(stored as Partial<ShortcutsConfig>);
		expect(merged.playPause).toEqual({ key: "q" });
		expect(merged).not.toHaveProperty("addZoom");
		expect(merged).not.toHaveProperty("addBlur");
	});
});
