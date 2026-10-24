// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../config";

const fetchMock = vi.fn(async (input: string | URL) => {
	const url = new URL(input, "http://localhost");
	if (!url.pathname.startsWith("/src/i18n/locales/")) {
		return new Response("Not found", { status: 404 });
	}
	const file = path.join(process.cwd(), url.pathname);
	return new Response(await readFile(file, "utf8"), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
});

beforeEach(() => {
	localStorage.clear();
	fetchMock.mockClear();
	vi.stubGlobal("fetch", fetchMock);
});

describe("locale loading", () => {
	it("keeps locale names available and loads a selected language on demand", async () => {
		const loader = await import("../loader");
		expect(loader.getAvailableLocales().length).toBeGreaterThan(1);
		expect(loader.getLocaleName("ar")).toBe("عربي");
		expect(loader.translate("en", "launch", "language")).toBe("Language");

		await loader.loadLocale("ar");
		expect(loader.translate("ar", "launch", "language")).toBe("اللغة");
		expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/ar/"), { cache: "no-store" });
	});

	it("has a saved non-English language ready before its first translation", async () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
		vi.resetModules();
		const loader = await import("../loader");
		expect(loader.getInitialLocale()).toBe("ar");
		expect(loader.translate("ar", "launch", "language")).toBe("اللغة");
	});

	it("falls back to English and allows retry after the initial locale fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const loader = await import("../loader");
		await expect(
			loader.loadInitialLocale("ar", async () => {
				throw new Error("missing local chunk");
			}),
		).resolves.toBeUndefined();
		expect(loader.getInitialLocaleLoadFailure()).toBe("ar");
		expect(loader.translate("en", "launch", "language")).toBe("Language");

		await loader.loadLocale("ar");
		expect(loader.getInitialLocaleLoadFailure()).toBeNull();
		expect(loader.translate("ar", "launch", "language")).toBe("اللغة");
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
