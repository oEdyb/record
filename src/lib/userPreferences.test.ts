import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PREFS,
	getProjectFolder,
	loadUserPreferences,
	parentDirectoryOf,
	saveUserPreferences,
} from "./userPreferences";

describe("parentDirectoryOf", () => {
	it("returns the directory for a POSIX path", () => {
		expect(parentDirectoryOf("/Users/me/Movies/clip.mp4")).toBe("/Users/me/Movies");
	});

	it("returns the directory for a Windows path", () => {
		expect(parentDirectoryOf("C:\\Users\\me\\Movies\\clip.mp4")).toBe("C:\\Users\\me\\Movies");
	});

	it("preserves the POSIX root when the file is at /", () => {
		expect(parentDirectoryOf("/video.mp4")).toBe("/");
	});

	it("preserves the Windows drive root with its trailing separator", () => {
		expect(parentDirectoryOf("C:\\video.mp4")).toBe("C:\\");
		expect(parentDirectoryOf("D:/video.mp4")).toBe("D:/");
	});

	it("returns null when no separator is present", () => {
		expect(parentDirectoryOf("video.mp4")).toBeNull();
		expect(parentDirectoryOf("")).toBeNull();
	});
});

describe("projectFolder preference", () => {
	// jsdom's localStorage isn't exposed as a global in this vitest setup, so
	// stub it with an in-memory shim before each test. Mirrors what the real
	// browser localStorage exposes, scoped to the keys we touch.
	beforeEach(() => {
		const store = new Map<string, string>();
		const stub = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, String(value));
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
			clear: () => store.clear(),
			key: (i: number) => Array.from(store.keys())[i] ?? null,
			get length() {
				return store.size;
			},
		};
		Object.defineProperty(globalThis, "localStorage", {
			value: stub,
			configurable: true,
		});
	});

	it.each(["left", "right", "top"] as const)("remembers the %s dock across loads", (hudDock) => {
		saveUserPreferences({ hudDock });
		expect(loadUserPreferences().hudDock).toBe(hudDock);
	});

	it("defaults to null when nothing is persisted", () => {
		expect(loadUserPreferences().projectFolder).toBeNull();
		expect(getProjectFolder()).toBeUndefined();
	});

	it("round-trips a saved project folder", () => {
		saveUserPreferences({ projectFolder: "/Users/me/Projects/demos" });
		expect(loadUserPreferences().projectFolder).toBe("/Users/me/Projects/demos");
		expect(getProjectFolder()).toBe("/Users/me/Projects/demos");
	});

	it("ignores non-string persisted values and falls back to the default", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ projectFolder: 42 }));
		expect(loadUserPreferences().projectFolder).toBe(DEFAULT_PREFS.projectFolder);
	});

	it("ignores empty-string persisted values and falls back to the default", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ projectFolder: "" }));
		expect(loadUserPreferences().projectFolder).toBe(DEFAULT_PREFS.projectFolder);
	});

	it("is independent of exportFolder", () => {
		saveUserPreferences({ exportFolder: "/Users/me/Downloads" });
		saveUserPreferences({ projectFolder: "/Users/me/Projects/demos" });
		const prefs = loadUserPreferences();
		expect(prefs.exportFolder).toBe("/Users/me/Downloads");
		expect(prefs.projectFolder).toBe("/Users/me/Projects/demos");
	});
});

describe("user preferences", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("persists the tray layout preference", () => {
		saveUserPreferences({ trayLayout: "vertical" });

		expect(loadUserPreferences().trayLayout).toBe("vertical");
	});

	it("falls back to the default tray layout for invalid stored values", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ trayLayout: "diagonal" }));

		expect(loadUserPreferences().trayLayout).toBe("horizontal");
	});

	it("remembers whether the idle recording pill is minimized", () => {
		expect(loadUserPreferences().hudMinimized).toBe(false);
		saveUserPreferences({ hudMinimized: true });
		expect(loadUserPreferences().hudMinimized).toBe(true);
	});

	it("ignores a malformed minimized flag", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ hudMinimized: "yes" }));

		expect(loadUserPreferences().hudMinimized).toBe(false);
	});

	it("persists and normalizes the floating camera preview position", () => {
		saveUserPreferences({ cameraPreviewPosition: { x: -241.4, y: 81.7 } });

		expect(loadUserPreferences().cameraPreviewPosition).toEqual({ x: -241, y: 82 });
	});

	it("persists and normalizes the camera monitor size and hidden state", () => {
		saveUserPreferences({ cameraPreviewSize: { width: 503.6, height: 293.9 } });
		expect(loadUserPreferences().cameraPreviewSize).toEqual({ width: 504, height: 294 });
		expect(loadUserPreferences().cameraMonitorHidden).toBe(false);
		saveUserPreferences({ cameraMonitorHidden: true });
		expect(loadUserPreferences().cameraMonitorHidden).toBe(true);
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ cameraPreviewSize: { width: 0, height: 10 }, cameraMonitorHidden: "yes" }),
		);
		expect(loadUserPreferences().cameraPreviewSize).toBeNull();
		expect(loadUserPreferences().cameraMonitorHidden).toBe(false);
	});

	it("persists and normalizes the notes window frame", () => {
		saveUserPreferences({ notesWindowBounds: { x: 10.4, y: 20.6, width: 320.2, height: 419.8 } });
		expect(loadUserPreferences().notesWindowBounds).toEqual({
			x: 10,
			y: 21,
			width: 320,
			height: 420,
		});
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ notesWindowBounds: { x: 0, y: 0, width: 0, height: 100 } }),
		);
		expect(loadUserPreferences().notesWindowBounds).toBeNull();
	});

	it("ignores an invalid floating camera preview position", () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ cameraPreviewPosition: { x: "left", y: 80 } }),
		);

		expect(loadUserPreferences().cameraPreviewPosition).toBeNull();
	});

	it("starts with the AI editor sidebar collapsed and remembers the last state", () => {
		expect(loadUserPreferences().editorChatOpen).toBe(false);

		saveUserPreferences({ editorChatOpen: true });
		expect(loadUserPreferences().editorChatOpen).toBe(true);
	});

	it("ignores an invalid AI editor sidebar preference", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ editorChatOpen: "open" }));

		expect(loadUserPreferences().editorChatOpen).toBe(false);
	});

	it("persists the software encoder preference", () => {
		saveUserPreferences({ preferSoftwareEncoder: true });

		expect(loadUserPreferences().preferSoftwareEncoder).toBe(true);
	});

	it("falls back to the default software encoder preference for invalid stored values", () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ preferSoftwareEncoder: "yes" }),
		);

		expect(loadUserPreferences().preferSoftwareEncoder).toBe(false);
	});

	it("persists the software encoder fallback notice suppression", () => {
		saveUserPreferences({ hideSoftwareEncoderFallbackNotice: true });

		expect(loadUserPreferences().hideSoftwareEncoderFallbackNotice).toBe(true);
	});

	it("falls back to showing the software encoder fallback notice for invalid stored values", () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ hideSoftwareEncoderFallbackNotice: "yes" }),
		);

		expect(loadUserPreferences().hideSoftwareEncoderFallbackNotice).toBe(false);
	});
});

describe("studio layout preference", () => {
	it("normalizes corrupt values without losing valid fields", async () => {
		const { normalizeStudioLayout } = await import("./userPreferences");
		expect(
			normalizeStudioLayout({
				view: "camera",
				split: 0,
				order: "wrong",
				dockFrac: Infinity,
				guides: true,
			}),
		).toMatchObject({ view: "camera", split: 0.45, order: "replay", dockFrac: 0.32, guides: true });
		expect(normalizeStudioLayout(null)).toEqual(DEFAULT_PREFS.studioLayout);
	});
	it("persists the layout alongside existing preferences", () => {
		saveUserPreferences({
			studioLayout: { ...DEFAULT_PREFS.studioLayout, dock: "left", liveMode: "notes" },
		});
		expect(loadUserPreferences().studioLayout).toMatchObject({ dock: "left", liveMode: "notes" });
	});
});
