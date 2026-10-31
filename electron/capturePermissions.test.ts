import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ systemPreferences: { getMediaAccessStatus: vi.fn() } }));

import { privacySettingsPane, readCapturePermissions } from "./capturePermissions";

describe("readCapturePermissions", () => {
	it("reports each macOS status without prompting", () => {
		const statuses: Record<string, string> = {
			screen: "not-determined",
			microphone: "granted",
			camera: "restricted",
		};
		expect(readCapturePermissions("darwin", (kind) => statuses[kind])).toEqual({
			screen: "not-determined",
			microphone: "granted",
			camera: "restricted",
		});
	});

	it("treats denied and unknown alike: both need System Settings", () => {
		const permissions = readCapturePermissions("darwin", (kind) =>
			kind === "screen" ? "unknown" : "denied",
		);
		expect(permissions).toEqual({ screen: "denied", microphone: "denied", camera: "denied" });
	});

	it("never gates capture outside macOS", () => {
		const getStatus = vi.fn(() => "denied");
		expect(readCapturePermissions("win32", getStatus)).toEqual({
			screen: "granted",
			microphone: "granted",
			camera: "granted",
		});
		expect(getStatus).not.toHaveBeenCalled();
	});
});

describe("privacySettingsPane", () => {
	it("maps each capture kind to its Privacy & Security pane", () => {
		expect(privacySettingsPane("screen")).toBe("Privacy_ScreenCapture");
		expect(privacySettingsPane("accessibility")).toBe("Privacy_Accessibility");
		expect(privacySettingsPane("microphone")).toBe("Privacy_Microphone");
		expect(privacySettingsPane("camera")).toBe("Privacy_Camera");
	});

	it("refuses anything else", () => {
		expect(privacySettingsPane("files")).toBeNull();
		expect(privacySettingsPane(42)).toBeNull();
		expect(privacySettingsPane("toString")).toBeNull();
	});
});
