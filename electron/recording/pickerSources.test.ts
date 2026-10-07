import { describe, expect, it } from "vitest";
import {
	PICKER_THUMBNAIL_MAX_AGE_MS,
	pickerThumbnailsAreFresh,
	reusePickerThumbnails,
} from "./pickerSources";

const source = (id: string, thumbnail: string | null = null, appIcon: string | null = null) => ({
	id,
	name: id,
	display_id: "",
	thumbnail,
	appIcon,
});

describe("pickerThumbnailsAreFresh", () => {
	it("is fresh for a minute after a full read and never before one", () => {
		expect(pickerThumbnailsAreFresh(null, 5_000)).toBe(false);
		expect(pickerThumbnailsAreFresh(1_000, 1_000 + PICKER_THUMBNAIL_MAX_AGE_MS - 1)).toBe(true);
		expect(pickerThumbnailsAreFresh(1_000, 1_000 + PICKER_THUMBNAIL_MAX_AGE_MS)).toBe(false);
	});
});

describe("reusePickerThumbnails", () => {
	it("keeps the fresh order and membership, carrying pictures over by id", () => {
		const cached = [
			source("window:1:0", "thumb1", "icon1"),
			source("window:2:0", "thumb2", "icon2"),
		];
		const fresh = [source("window:2:0"), source("window:3:0"), source("screen:1:0")];
		expect(reusePickerThumbnails(fresh, cached)).toEqual([
			source("window:2:0", "thumb2", "icon2"),
			source("window:3:0"),
			source("screen:1:0"),
		]);
	});

	it("prefers a picture the fresh read already has", () => {
		const cached = [source("window:1:0", "old", "icon")];
		expect(reusePickerThumbnails([source("window:1:0", "new")], cached)).toEqual([
			source("window:1:0", "new", "icon"),
		]);
	});
});
