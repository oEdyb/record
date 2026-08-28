import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPausePolicy } from "./pausePreferences";

describe("pause preferences", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("keeps non-speech sound handling off when older settings have no explicit choice", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => JSON.stringify({ mode: "speech" }),
		});

		expect(loadPausePolicy().includeNonSpeechEvents).toBe(false);
	});
});
