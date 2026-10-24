// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { I18nProvider, useI18n } from "./I18nContext";

const loader = vi.hoisted(() => ({
	loadLocale: vi.fn(),
	initialLocaleLoadFailure: null as string | null,
}));
vi.mock("@/i18n/loader", () => ({
	getAvailableLocales: () => ["en", "ar"],
	getInitialLocale: () => "en",
	getInitialLocaleLoadFailure: () => loader.initialLocaleLoadFailure,
	loadLocale: loader.loadLocale,
	translate: (locale: string, _namespace: string, key: string) => `${locale}:${key}`,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
	return <I18nProvider>{children}</I18nProvider>;
}

beforeEach(() => {
	localStorage.clear();
	loader.loadLocale.mockReset();
	loader.loadLocale.mockResolvedValue(undefined);
	loader.initialLocaleLoadFailure = null;
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.dismiss).mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("I18nProvider locale changes", () => {
	it("waits for the bundle before applying and persisting a language", async () => {
		let resolve!: () => void;
		loader.loadLocale.mockImplementation(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		);
		const { result } = renderHook(() => useI18n(), { wrapper });
		let change!: ReturnType<typeof result.current.setLocale>;
		act(() => {
			change = result.current.setLocale("ar");
		});
		expect(result.current.locale).toBe("en");
		expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();

		await act(async () => {
			resolve();
			expect(await change).toBe("applied");
		});
		expect(result.current.locale).toBe("ar");
		expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ar");
		expect(document.documentElement.lang).toBe("ar");
	});

	it("does not let a slower older request replace the latest choice", async () => {
		const pending = new Map<string, () => void>();
		loader.loadLocale.mockImplementation(
			(locale: string) => new Promise<void>((resolve) => pending.set(locale, () => resolve())),
		);
		const { result } = renderHook(() => useI18n(), { wrapper });
		let arabic!: ReturnType<typeof result.current.setLocale>;
		let english!: ReturnType<typeof result.current.setLocale>;
		act(() => {
			arabic = result.current.setLocale("ar");
			english = result.current.setLocale("en");
		});
		await act(async () => {
			pending.get("ar")?.();
			expect(await arabic).toBe("superseded");
		});
		expect(result.current.locale).toBe("en");
		expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();

		await act(async () => {
			pending.get("en")?.();
			expect(await english).toBe("applied");
		});
		expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
	});

	it("classifies an older failed load as superseded after a newer choice", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let rejectArabic!: (error: Error) => void;
		loader.loadLocale.mockImplementation((locale: string) =>
			locale === "ar"
				? new Promise<void>((_, reject) => {
						rejectArabic = reject;
					})
				: Promise.resolve(),
		);
		const { result } = renderHook(() => useI18n(), { wrapper });
		let older!: ReturnType<typeof result.current.setLocale>;
		let newer!: ReturnType<typeof result.current.setLocale>;
		act(() => {
			older = result.current.setLocale("ar");
			newer = result.current.setLocale("en");
		});
		await act(async () => {
			expect(await newer).toBe("applied");
			rejectArabic(new Error("older failure"));
			expect(await older).toBe("superseded");
		});
		expect(result.current.locale).toBe("en");
		expect(warning).not.toHaveBeenCalled();
	});

	it("keeps the current language when a bundle cannot load", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		loader.loadLocale.mockRejectedValue(new Error("missing local chunk"));
		const { result } = renderHook(() => useI18n(), { wrapper });
		await act(async () => {
			expect(await result.current.setLocale("ar")).toBe("failed");
		});
		expect(result.current.locale).toBe("en");
		expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
		expect(warning).toHaveBeenCalledOnce();
	});

	it("falls back to English and retries a failed initial locale from the toast", async () => {
		loader.initialLocaleLoadFailure = "ar";
		localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.locale).toBe("en");
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		const options = vi.mocked(toast.error).mock.calls.at(-1)?.[1];
		const action = options?.action;
		if (!action || typeof action !== "object" || !("onClick" in action)) {
			throw new Error("Expected the initial-locale retry action");
		}
		render(createElement("button", { type: "button", onClick: action.onClick }));
		fireEvent.click(screen.getByRole("button"));

		await waitFor(() => expect(result.current.locale).toBe("ar"));
		expect(loader.loadLocale).toHaveBeenCalledWith("ar");
		expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ar");
		expect(toast.dismiss).toHaveBeenCalledWith("initial-locale-load-failed");
	});

	it("does not show a locale retry after the provider unmounts", async () => {
		loader.initialLocaleLoadFailure = "ar";
		const { unmount } = renderHook(() => useI18n(), { wrapper });
		unmount();
		await act(async () => {
			await import("sonner");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});
});
