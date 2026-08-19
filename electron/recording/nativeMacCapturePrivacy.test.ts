import { describe, expect, it } from "vitest";
import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";
import { addNativeMacDisplayPrivacyExclusions } from "./nativeMacCapturePrivacy";

const displaySource: NativeMacRecordingRequest["source"] = {
	type: "display",
	sourceId: "screen:1:0",
	displayId: 1,
};

describe("native macOS capture privacy", () => {
	it("excludes the recorder process so windows opened during capture stay private", () => {
		expect(
			addNativeMacDisplayPrivacyExclusions(displaySource, {
				windowIds: [42, 12, 42],
				processId: 9001,
			}),
		).toMatchObject({
			excludedWindowIds: [12, 42],
			excludedProcessIds: [9001],
		});
	});

	it("does not alter a single-window capture", () => {
		const source: NativeMacRecordingRequest["source"] = {
			type: "window",
			sourceId: "window:5:0",
			windowId: 5,
		};
		expect(addNativeMacDisplayPrivacyExclusions(source, { windowIds: [12], processId: 9001 })).toBe(
			source,
		);
	});
});
