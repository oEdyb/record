import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseKeymap } from "./StudioKeymap";

const locales = path.join(__dirname, "../../i18n/locales");
const keymapOf = (locale: string) =>
	JSON.parse(readFileSync(path.join(locales, locale, "launch.json"), "utf8")).studio.keymap;

describe("parseKeymap", () => {
	it("splits lines and pairs into keys and actions", () => {
		expect(parseKeymap("Space: Play\n← / →: Seek · Shift: 10 s")).toEqual([
			{ keys: ["Space"], action: "Play" },
			{ keys: ["←", "→"], action: "Seek" },
			{ keys: ["Shift"], action: "10 s" },
		]);
	});

	it("reads every locale's list as the same shortcuts as English", () => {
		const english = parseKeymap(keymapOf("en"));
		for (const locale of readdirSync(locales)) {
			const entries = parseKeymap(keymapOf(locale));
			expect(
				entries.map((entry) => entry.keys.length),
				locale,
			).toEqual(english.map((entry) => entry.keys.length));
		}
	});
});
