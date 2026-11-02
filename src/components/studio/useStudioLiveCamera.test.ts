import { describe, expect, it } from "vitest";
import { studioCameraFrameSize } from "./useStudioLiveCamera";

describe("studioCameraFrameSize", () => {
	it("asks a tall pane for the whole 16:9 frame instead of a portrait crop", () => {
		expect(studioCameraFrameSize(400, 800, 2)).toEqual({ width: 800, height: 450 });
	});

	it("fits a wide pane by its height", () => {
		expect(studioCameraFrameSize(1600, 450, 1)).toEqual({ width: 800, height: 450 });
	});
});
