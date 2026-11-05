import { describe, expect, it } from "vitest";
import { nativeErrorMessage } from "./nativeErrorMessage";

describe("native media error messages", () => {
	it("explains invalid video frames without exposing a raw decoder error", () => {
		expect(nativeErrorMessage("avcodec_receive_frame: -1094995529")).toBe(
			"This video contains damaged or incomplete frames. Restore the original recording or choose another video.",
		);
	});
	it("preserves errors with a different cause", () => {
		expect(nativeErrorMessage("No space left on device")).toBe("No space left on device");
		expect(nativeErrorMessage("avcodec_receive_frame: -12")).toBe("avcodec_receive_frame: -12");
	});
});
