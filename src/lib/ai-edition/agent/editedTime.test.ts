import { describe, expect, it } from "vitest";
import { editedTimecode, parseEditedTime } from "./editedTime";

describe("edited time parser", () => {
	it.each([
		[103, 103],
		["103.5", 103.5],
		["1:43", 103],
		["12:03.5", 723.5],
		["0:00", 0],
	])("parses %s", (input, expected) => expect(parseEditedTime(input)).toBe(expected));
	it.each([
		"",
		"-1",
		"1:60",
		"1:2:3",
		" 1 ",
		"NaN",
		"1e3",
		Infinity,
		NaN,
		-1,
	])("rejects %s", (input) => expect(() => parseEditedTime(input)).toThrow());
	it("formats rollover without sixty seconds", () =>
		expect(editedTimecode(59.9999)).toBe("1:00.000"));
});
