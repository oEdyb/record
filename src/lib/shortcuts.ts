export const SHORTCUT_ACTIONS = ["openApp", "toggleRecordingPause", "playPause"] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export interface ShortcutBinding {
	key: string;
	/** Maps to Cmd on macOS, Ctrl on Windows/Linux */
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
}

export type ShortcutsConfig = Record<ShortcutAction, ShortcutBinding>;

export interface FixedShortcut {
	i18nKey: string;
	label: string;
	bindings: ShortcutBinding[];
}

/** Keys the recorder and review handle that cannot be rebound (`useRecordingReviewShortcuts`). */
export const FIXED_SHORTCUTS: FixedShortcut[] = [
	{ i18nKey: "saveVideo", label: "Save Video", bindings: [{ key: "s", ctrl: true }] },
	{ i18nKey: "newRecording", label: "New Recording", bindings: [{ key: "n", ctrl: true }] },
	{ i18nKey: "openRecordings", label: "Recordings", bindings: [{ key: "o", ctrl: true }] },
	{ i18nKey: "playPauseAlt", label: "Play / Pause", bindings: [{ key: "k" }] },
	{ i18nKey: "mute", label: "Mute / Unmute", bindings: [{ key: "m" }] },
	{
		i18nKey: "skipSecond",
		label: "Back / Forward 1 Second",
		bindings: [{ key: "j" }, { key: "l" }],
	},
	{
		i18nKey: "stepFrame",
		label: "Previous / Next Frame",
		bindings: [{ key: "arrowleft" }, { key: "arrowright" }],
	},
	{
		i18nKey: "stepClip",
		label: "Previous / Next Clip",
		bindings: [{ key: "arrowup" }, { key: "arrowdown" }],
	},
	{
		i18nKey: "jumpToEdge",
		label: "Start / End",
		bindings: [{ key: "home" }, { key: "end" }],
	},
];

export type ShortcutConflict =
	| { type: "configurable"; action: ShortcutAction }
	| { type: "fixed"; label: string; i18nKey: string };

function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		!!a.ctrl === !!b.ctrl &&
		!!a.shift === !!b.shift &&
		!!a.alt === !!b.alt
	);
}

export function findConflict(
	binding: ShortcutBinding,
	forAction: ShortcutAction,
	config: ShortcutsConfig,
): ShortcutConflict | null {
	for (const fixed of FIXED_SHORTCUTS) {
		if (fixed.bindings.some((b) => bindingsEqual(b, binding))) {
			return { type: "fixed", label: fixed.label, i18nKey: fixed.i18nKey };
		}
	}
	for (const action of SHORTCUT_ACTIONS) {
		if (action !== forAction && bindingsEqual(config[action], binding)) {
			return { type: "configurable", action };
		}
	}
	return null;
}

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
	openApp: { key: "o", ctrl: true, shift: true },
	toggleRecordingPause: { key: " ", ctrl: true, shift: true },
	playPause: { key: " " },
};

export function defaultShortcuts(platform: string): ShortcutsConfig {
	if (platform !== "linux") return DEFAULT_SHORTCUTS;
	return {
		openApp: { key: "o", ctrl: true, alt: true },
		toggleRecordingPause: { key: "r", ctrl: true, alt: true },
		playPause: { key: " " },
	};
}

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
	openApp: "Open App",
	toggleRecordingPause: "Pause / Continue Recording",
	playPause: "Play / Pause",
};

export function matchesShortcut(
	e: KeyboardEvent,
	binding: ShortcutBinding | undefined,
	isMacPlatform: boolean,
): boolean {
	if (!binding) return false;
	if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;

	const primaryMod = isMacPlatform ? e.metaKey : e.ctrlKey;
	if (primaryMod !== !!binding.ctrl) return false;
	if (e.shiftKey !== !!binding.shift) return false;
	if (e.altKey !== !!binding.alt) return false;

	return true;
}

const KEY_LABELS: Record<string, string> = {
	" ": "Space",
	delete: "Del",
	backspace: "⌫",
	escape: "Esc",
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
	home: "Home",
	end: "End",
};

export function formatBinding(binding: ShortcutBinding, isMac: boolean): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
	if (binding.shift) parts.push(isMac ? "⇧" : "Shift");
	if (binding.alt) parts.push(isMac ? "⌥" : "Alt");
	parts.push(KEY_LABELS[binding.key] ?? binding.key.toUpperCase());
	return parts.join(" + ");
}

export function mergeWithDefaults(
	partial: Partial<ShortcutsConfig>,
	platform = "darwin",
): ShortcutsConfig {
	const merged = { ...defaultShortcuts(platform) };
	for (const action of SHORTCUT_ACTIONS) {
		if (partial[action]) {
			const binding = partial[action];
			merged[action] =
				platform === "linux" && bindingsEqual(binding, DEFAULT_SHORTCUTS[action])
					? defaultShortcuts(platform)[action]
					: binding;
		}
	}
	return merged;
}
