import { describe, expect, it } from "vitest";
import { parsePillState, parseStudioCommand } from "./ipc";

describe("parseStudioCommand", () => {
	it("accepts known commands and drops anything else", () => {
		expect(parseStudioCommand("pause")).toBe("pause");
		expect(parseStudioCommand("toggle-mic")).toBe("toggle-mic");
		expect(parseStudioCommand("rm -rf")).toBeNull();
		expect(
			parseStudioCommand({ kind: "select-camera", deviceId: "cam", name: "FaceTime" }),
		).toEqual({
			kind: "select-camera",
			deviceId: "cam",
			name: "FaceTime",
		});
		expect(parseStudioCommand({ kind: "select-camera", deviceId: 4, name: "x" })).toBeNull();
		expect(parseStudioCommand({ kind: "set-cursor", value: "editable-overlay" })).toEqual({
			kind: "set-cursor",
			value: "editable-overlay",
		});
		expect(parseStudioCommand({ kind: "set-cursor", value: "hidden" })).toBeNull();
		expect(parseStudioCommand(null)).toBeNull();
	});
});

describe("parsePillState", () => {
	it("keeps only well-formed fields", () => {
		expect(parsePillState({ controlsLocked: true, undoClipIndex: 2.5, saving: "yes" })).toEqual({
			controlsLocked: true,
			canRemovePreviousClip: false,
			undoClipIndex: null,
			countingDown: false,
			transportBusy: false,
			canPause: false,
			saving: false,
		});
	});
});
