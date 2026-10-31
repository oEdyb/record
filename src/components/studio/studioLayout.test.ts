// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { normalizeStudioLayout } from "@/lib/userPreferences";
import { dockFraction, sentenceTarget, splitLayout, studioKeyAllowed } from "./studioLayout";

describe("Studio layout", () => {
	it("keeps 260 pixels of video and 380 pixels of reading space", () => {
		for (const width of [900, 1440, 1920])
			for (const fraction of [0, 0.32, 1]) {
				const actual = dockFraction(fraction, width);
				expect(actual * width).toBeGreaterThanOrEqual(260);
				expect(Math.round((1 - actual) * width)).toBeGreaterThanOrEqual(380);
			}
	});
	it("shows only requested panes", () => {
		expect(splitLayout(normalizeStudioLayout({ view: "camera" }))).toEqual({
			replay: false,
			camera: true,
		});
		expect(splitLayout(normalizeStudioLayout({ view: "replay" }))).toEqual({
			replay: true,
			camera: false,
		});
		expect(splitLayout(normalizeStudioLayout({ view: "both" }))).toEqual({
			replay: true,
			camera: true,
		});
	});
	it("navigates sentences and handles silence", () => {
		expect(sentenceTarget([], 0, 1)).toBeNull();
		expect(sentenceTarget([2, 4, 8], 4, 1)).toBe(8);
		expect(sentenceTarget([2, 4, 8], 4, -1)).toBe(2);
		expect(sentenceTarget([2, 4, 8], 0, -1)).toBe(2);
	});
});
describe("Studio keyboard guards", () => {
	const event = {
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		isComposing: false,
		defaultPrevented: false,
		key: "Backspace",
	};
	it("runs only from the document", () => {
		const main = document.createElement("main");
		main.dataset.studioDocument = "";
		expect(studioKeyAllowed(event, main)).toBe(true);
		expect(studioKeyAllowed(event, document.body)).toBe(false);
		for (const tag of ["button", "select", "textarea", "input"]) {
			const node = document.createElement(tag);
			main.append(node);
			expect(studioKeyAllowed(event, node)).toBe(false);
		}
		expect(studioKeyAllowed({ ...event, isComposing: true }, main)).toBe(false);
		expect(studioKeyAllowed({ ...event, metaKey: true }, main)).toBe(false);
		const node = document.createElement("div");
		node.setAttribute("role", "separator");
		main.append(node);
		expect(studioKeyAllowed(event, node)).toBe(false);
	});
	it("lets letter shortcuts through a focused button, but not its own keys", () => {
		const main = document.createElement("main");
		main.dataset.studioDocument = "";
		const button = document.createElement("button");
		main.append(button);
		expect(studioKeyAllowed({ ...event, key: "m" }, button)).toBe(true);
		for (const key of [" ", "Enter", "ArrowLeft", "Backspace"])
			expect(studioKeyAllowed({ ...event, key }, button)).toBe(false);
		const input = document.createElement("input");
		main.append(input);
		expect(studioKeyAllowed({ ...event, key: "m" }, input)).toBe(false);
	});
});
