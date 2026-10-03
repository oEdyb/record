// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PREVIEW_QUALITY_KEY,
	readPreviewQuality,
	usePreviewPreferences,
} from "./previewPreferences";

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	usePreviewPreferences.setState({ quality: "sharp" });
});

describe("preview preferences", () => {
	it("defaults to Sharp and rejects invalid stored choices", () => {
		localStorage.clear();
		expect(readPreviewQuality()).toBe("sharp");
		localStorage.setItem(PREVIEW_QUALITY_KEY, "source");
		expect(readPreviewQuality()).toBe("sharp");
	});
	it("remembers the viewing preference across reads", () => {
		usePreviewPreferences.getState().setQuality("performance");
		expect(readPreviewQuality()).toBe("performance");
		usePreviewPreferences.getState().setQuality("sharp");
		expect(readPreviewQuality()).toBe("sharp");
	});
	it("still changes quality when local storage is unavailable", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		usePreviewPreferences.getState().setQuality("performance");
		expect(usePreviewPreferences.getState().quality).toBe("performance");
	});
});
