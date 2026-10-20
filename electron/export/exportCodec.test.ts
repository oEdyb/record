import { describe, expect, it } from "vitest";
import { exceedsH264FrameLimit, renderedExportCodec } from "./exportCodec";

describe("rendered export codec", () => {
	it("keeps H.264 up to 4096 pixels a side and switches larger frames to HEVC", () => {
		expect(exceedsH264FrameLimit(4096, 4096)).toBe(false);
		expect(exceedsH264FrameLimit(3420, 2214)).toBe(false);
		expect(exceedsH264FrameLimit(3840, 2560)).toBe(false);
		expect(exceedsH264FrameLimit(4098, 1080)).toBe(true);
		expect(exceedsH264FrameLimit(1080, 4098)).toBe(true);
		expect(exceedsH264FrameLimit(5120, 2880)).toBe(true);
		expect(renderedExportCodec({ width: 1920, height: 1080, codec: "h264" })).toBe("h264");
		expect(renderedExportCodec({ width: 6016, height: 3384, codec: "h264" })).toBe("h265");
		expect(renderedExportCodec({ width: 6016, height: 3384 })).toBe("h265");
		expect(renderedExportCodec({ width: 1920, height: 1080, codec: "h265" })).toBe("h265");
		expect(renderedExportCodec(undefined)).toBe("h264");
	});
});
