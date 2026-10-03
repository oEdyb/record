import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPausePolicy } from "./pausePreferences";

describe("pause preferences", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("turns non-speech sound handling on when older settings have no explicit choice", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => JSON.stringify({ mode: "speech" }),
		});

		expect(loadPausePolicy().includeNonSpeechEvents).toBe(true);
	});
});
