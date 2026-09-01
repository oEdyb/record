import { describe, expect, it } from "vitest";
import { fromKlipptMediaUrl, toKlipptMediaUrl } from "./localMediaUrl";

describe("local media URLs", () => {
	it.each([
		"/Users/olle/Movies/Screen capture åäö.mp4",
		"C:\\Users\\Olle\\Videos\\capture.mp4",
		"\\\\server\\share\\capture.webm",
	])("round-trips a local path without exposing it in the URL", (filePath) => {
		const mediaUrl = toKlipptMediaUrl(filePath);
		expect(mediaUrl).toMatch(/^klippt:\/\/app\/__media__\/[A-Za-z0-9_-]+$/);
		expect(mediaUrl).not.toContain("Olle");
		expect(fromKlipptMediaUrl(mediaUrl)).toBe(filePath);
	});

	it("rejects other origins and nested payload paths", () => {
		expect(fromKlipptMediaUrl("klippt://other/__media__/YWJj")).toBeNull();
		expect(fromKlipptMediaUrl("klippt://app/__media__/YWJj/extra")).toBeNull();
		expect(fromKlipptMediaUrl("file:///tmp/capture.mp4")).toBeNull();
	});
});
