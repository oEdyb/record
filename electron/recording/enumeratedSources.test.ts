import type { DesktopCapturerSource } from "electron";
import { describe, expect, it } from "vitest";
import { mergeEnumeratedSources } from "./enumeratedSources";

const source = (id: string) => ({ id, name: id }) as unknown as DesktopCapturerSource;

describe("mergeEnumeratedSources", () => {
	it("keeps window entries when only screens were read", () => {
		const previous = new Map([
			["screen:1:0", source("screen:1:0")],
			["window:42:0", source("window:42:0")],
		]);
		const next = mergeEnumeratedSources(previous, [source("screen:2:0")], ["screen"]);
		expect([...next.keys()]).toEqual(["window:42:0", "screen:2:0"]);
	});

	it("drops windows that a full read no longer lists", () => {
		const previous = new Map([
			["screen:1:0", source("screen:1:0")],
			["window:42:0", source("window:42:0")],
		]);
		const next = mergeEnumeratedSources(
			previous,
			[source("screen:1:0"), source("window:7:0")],
			["screen", "window"],
		);
		expect([...next.keys()]).toEqual(["screen:1:0", "window:7:0"]);
	});
});
