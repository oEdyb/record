// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireEntitlement } from "@/lib/entitlements/store";
import { type CustomFont, getCustomFonts, loadAllCustomFonts, loadFont } from "./customFonts";
import type { LocalFontFace } from "./localFont";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/lib/entitlements/store", () => ({ requireEntitlement: vi.fn() }));

const LOCAL_TTF_DATA_URL = `data:font/ttf;base64,${Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64")}`;

let nextId = 0;

function customFont(fontFamily: string, importUrl: string): CustomFont {
	nextId += 1;
	return { id: `custom-font-test-${nextId}`, name: fontFamily, fontFamily, importUrl };
}

function fontFace(
	family: string,
	{
		style = "normal",
		weight = "400",
		status = "loaded",
	}: { style?: string; weight?: string; status?: FontFaceLoadStatus } = {},
): FontFace {
	return { family, style, weight, status } as FontFace;
}

function installDocumentFonts(faces: FontFace[]) {
	const load = vi.fn(async (_font: string) => faces);
	const check = vi.fn((_font: string) => true);
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: {
			[Symbol.iterator]: () => faces[Symbol.iterator](),
			load,
			check,
		},
	});
	return { load, check };
}

function installLocalDocumentFonts(
	failFor?: (font: string) => boolean,
	initialFaces: FontFace[] = [],
) {
	const faces = [...initialFaces];
	const handledStyles = new Set<HTMLStyleElement>();
	const load = vi.fn(async (font: string) => {
		const style = [
			...document.head.querySelectorAll<HTMLStyleElement>("style[data-custom-font-id]"),
		].find((candidate) => !handledStyles.has(candidate));
		if (style) {
			handledStyles.add(style);
			if (failFor?.(font)) throw new Error("The font could not be parsed");
			const match = /^(normal|italic) (\d+(?:\.\d+)?) 16px "(.*)"$/.exec(font);
			if (!match) throw new Error(`Unexpected font shorthand: ${font}`);
			faces.push(fontFace(match[3], { style: match[1], weight: match[2] }));
		}
		return faces;
	});
	const check = vi.fn((_font: string) => true);
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: {
			[Symbol.iterator]: () => faces[Symbol.iterator](),
			load,
			check,
		},
	});
	return { load, check };
}

function localFace(style: "normal" | "italic", weight: number): LocalFontFace {
	return { style, weight, dataUrl: LOCAL_TTF_DATA_URL };
}

function installLocalFontPicker() {
	const chooseLocalFont = vi.fn();
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { chooseLocalFont },
	});
	return chooseLocalFont;
}

function expectNoRemoteStylesheet() {
	document.head.querySelectorAll("style").forEach((style) => {
		expect(style.textContent).not.toMatch(/@import|https?:\/\//);
	});
}

async function clickRecoveryAction() {
	const options = vi.mocked(toast.warning).mock.calls.at(-1)?.[1];
	const action = options?.action;
	if (!action || typeof action !== "object" || !("onClick" in action)) {
		throw new Error("Expected a recovery toast action");
	}
	const onClick = action.onClick;
	let defaultPrevented = false;
	const completion = new Promise<void>((resolve, reject) => {
		render(
			createElement("button", {
				type: "button",
				onClick: (event: Parameters<typeof onClick>[0]) => {
					const result = onClick(event);
					defaultPrevented = event.defaultPrevented;
					Promise.resolve(result).then(resolve, reject);
				},
			}),
		);
	});
	fireEvent.click(screen.getByRole("button"));
	await completion;
	expect(defaultPrevented).toBe(true);
}

function expectNoStylesheet(font: CustomFont) {
	expect(document.getElementById(`custom-font-${font.id}`)).toBeNull();
	expect(document.head.querySelector("style")).toBeNull();
}

beforeEach(() => {
	vi.mocked(requireEntitlement).mockReturnValue(true);
});

afterEach(() => {
	cleanup();
	localStorage.clear();
	document.head.querySelectorAll("style").forEach((style) => style.remove());
	Reflect.deleteProperty(window, "electronAPI");
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("offline custom font loading", () => {
	it("loads every requested bundled variation without inserting a stylesheet", async () => {
		const fonts = installDocumentFonts([fontFace("DM Sans", { status: "unloaded" })]);
		const font = customFont(
			"DM Sans",
			"https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,700;1,400;1,700&display=swap",
		);

		await loadFont(font);

		expect(fonts.load.mock.calls.map(([shorthand]) => shorthand)).toEqual([
			'normal 400 16px "DM Sans"',
			'normal 700 16px "DM Sans"',
			'italic 400 16px "DM Sans"',
			'italic 700 16px "DM Sans"',
		]);
		expect(fonts.check).toHaveBeenCalledTimes(4);
		expectNoStylesheet(font);
	});

	it("accepts exact already-loaded local faces without initiating a load", async () => {
		const faces = [
			fontFace("Legacy Local", { weight: "400" }),
			fontFace("Legacy Local", { weight: "700" }),
		];
		const fonts = installDocumentFonts(faces);
		const font = customFont(
			"Legacy Local",
			"https://fonts.googleapis.com/css2?family=Legacy+Local:wght@400;700&display=swap",
		);

		await loadFont(font);

		expect(fonts.load).not.toHaveBeenCalled();
		expect(fonts.check).toHaveBeenCalledTimes(2);
		expectNoStylesheet(font);
	});

	it("rejects a missing remote family even when FontFaceSet.check returns true", async () => {
		const fonts = installDocumentFonts([]);
		const font = customFont(
			"Roboto",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap",
		);

		await expect(loadFont(font)).rejects.toThrow(
			/Custom font "Roboto".*normal 400 is not already loaded locally.*Remote font stylesheets are disabled/,
		);
		expect(fonts.load).not.toHaveBeenCalled();
		expectNoStylesheet(font);
	});

	it("rejects an unbundled weight instead of substituting the nearest bundled weight", async () => {
		const fonts = installDocumentFonts([fontFace("Inter", { weight: "400" })]);
		const font = customFont(
			"Inter",
			"https://fonts.googleapis.com/css2?family=Inter:wght@300&display=swap",
		);

		await expect(loadFont(font)).rejects.toThrow(/normal 300 is not bundled/);
		expect(fonts.load).not.toHaveBeenCalled();
		expectNoStylesheet(font);
	});

	it("rejects a mismatched stored family and URL family", async () => {
		const fonts = installDocumentFonts([fontFace("Inter")]);
		const font = customFont(
			"Inter",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap",
		);

		await expect(loadFont(font)).rejects.toThrow(/stored family and URL family do not match/);
		expect(fonts.load).not.toHaveBeenCalled();
		expectNoStylesheet(font);
	});

	it("keeps startup loading non-fatal while reporting the unavailable remote font", async () => {
		const font = customFont(
			"Roboto",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		installDocumentFonts([]);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(loadAllCustomFonts()).resolves.toEqual([undefined]);

		expect(consoleError).toHaveBeenCalledWith(
			"Failed to load custom font:",
			"Roboto",
			expect.objectContaining({
				message: expect.stringMatching(/unavailable offline.*Remote font stylesheets are disabled/),
			}),
		);
		expect(getCustomFonts()).toEqual([font]);
		expectNoStylesheet(font);
	});

	it("forwards startup diagnostics through the production renderer bridge", async () => {
		const font = customFont(
			"Roboto",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		installDocumentFonts([]);
		const rendererConsole = vi.fn();
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { rendererConsole },
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		try {
			await expect(loadAllCustomFonts()).resolves.toEqual([undefined]);
			expect(rendererConsole).toHaveBeenCalledWith("error", [
				"Failed to load custom font:",
				"Roboto",
				expect.objectContaining({
					message: expect.stringMatching(
						/unavailable offline.*Remote font stylesheets are disabled/,
					),
				}),
			]);
			expect(consoleError).not.toHaveBeenCalled();
		} finally {
			Reflect.deleteProperty(window, "electronAPI");
		}
		expectNoStylesheet(font);
	});
});

describe("local legacy font migration", () => {
	it("loads and saves every requested Roboto variation exactly once", async () => {
		const font = customFont(
			"Roboto",
			"https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,400;0,700;1,400;1,700&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		const fonts = installLocalDocumentFonts();
		const chooseLocalFont = installLocalFontPicker();
		chooseLocalFont.mockResolvedValue({
			success: true,
			canceled: false,
			dataUrl: LOCAL_TTF_DATA_URL,
		});
		const save = vi.spyOn(Storage.prototype, "setItem");

		await loadAllCustomFonts();
		expect(chooseLocalFont).not.toHaveBeenCalled();
		await clickRecoveryAction();

		expect(requireEntitlement).toHaveBeenCalledWith("import");
		expect(chooseLocalFont.mock.calls.map(([request]) => request)).toEqual([
			{ family: "Roboto", style: "normal", weight: 400, styleLabel: "Normal" },
			{ family: "Roboto", style: "normal", weight: 700, styleLabel: "Normal" },
			{ family: "Roboto", style: "italic", weight: 400, styleLabel: "Italic" },
			{ family: "Roboto", style: "italic", weight: 700, styleLabel: "Italic" },
		]);
		expect(fonts.load.mock.calls.map(([shorthand]) => shorthand)).toEqual([
			'normal 400 16px "Roboto"',
			'normal 700 16px "Roboto"',
			'italic 400 16px "Roboto"',
			'italic 700 16px "Roboto"',
		]);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save.mock.invocationCallOrder[0]).toBeGreaterThan(
			fonts.load.mock.invocationCallOrder[3],
		);
		expect(getCustomFonts()).toEqual([
			{
				...font,
				localFaces: [
					localFace("normal", 400),
					localFace("normal", 700),
					localFace("italic", 400),
					localFace("italic", 700),
				],
			},
		]);
		expect(document.head.querySelectorAll("style[data-custom-font-id]")).toHaveLength(4);
		expectNoRemoteStylesheet();
		expect(toast.dismiss).toHaveBeenCalledWith(`custom-font-recovery-${font.id}`);
		expect(vi.mocked(toast.dismiss).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(toast.success).mock.invocationCallOrder[0],
		);
		expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Roboto"));
	});

	it("preserves Inter 300 instead of substituting bundled 400", async () => {
		const font = customFont(
			"Inter",
			"https://fonts.googleapis.com/css2?family=Inter:wght@300&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		const fonts = installLocalDocumentFonts();
		const chooseLocalFont = installLocalFontPicker();
		chooseLocalFont.mockResolvedValue({
			success: true,
			canceled: false,
			dataUrl: LOCAL_TTF_DATA_URL,
		});

		await loadAllCustomFonts();
		await clickRecoveryAction();

		expect(chooseLocalFont).toHaveBeenCalledWith({
			family: "Inter",
			style: "normal",
			weight: 300,
			styleLabel: "Normal",
		});
		expect(fonts.load).toHaveBeenCalledWith('normal 300 16px "Inter"');
		expect(fonts.load).not.toHaveBeenCalledWith('normal 400 16px "Inter"');
		expect(getCustomFonts()[0].localFaces).toEqual([localFace("normal", 300)]);
		expectNoRemoteStylesheet();
	});

	it("offers no actionable retry or picker for an unsupported range request", async () => {
		const font = customFont(
			"Inter",
			"https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		installLocalDocumentFonts();
		const chooseLocalFont = installLocalFontPicker();
		const save = vi.spyOn(Storage.prototype, "setItem");

		await loadAllCustomFonts();

		expect(chooseLocalFont).not.toHaveBeenCalled();
		expect(requireEntitlement).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(toast.warning).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(
			"Inter uses an unsupported font request format. Exact local recovery is unavailable.",
			expect.anything(),
		);
		const options = vi.mocked(toast.error).mock.calls.at(-1)?.[1];
		expect(options).not.toHaveProperty("action");
		expect(getCustomFonts()).toEqual([font]);
		expectNoRemoteStylesheet();
	});

	it("reloads saved local faces in read-only mode without import or writes", async () => {
		const font = {
			...customFont(
				"Roboto",
				"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap",
			),
			localFaces: [localFace("normal", 400), localFace("normal", 700)],
		};
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		const fonts = installLocalDocumentFonts();
		const chooseLocalFont = installLocalFontPicker();
		const save = vi.spyOn(Storage.prototype, "setItem");
		vi.mocked(requireEntitlement).mockReturnValue(false);

		await expect(loadAllCustomFonts()).resolves.toEqual([undefined]);

		expect(requireEntitlement).not.toHaveBeenCalled();
		expect(chooseLocalFont).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(fonts.load).toHaveBeenCalledTimes(2);
		expect(toast.warning).not.toHaveBeenCalled();
		expect(getCustomFonts()).toEqual([font]);
		expectNoRemoteStylesheet();
	});

	it("uses the normal read-only explanation without a picker, save, or font error", async () => {
		const font = customFont(
			"Roboto",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		installLocalDocumentFonts();
		const chooseLocalFont = installLocalFontPicker();
		const save = vi.spyOn(Storage.prototype, "setItem");
		vi.mocked(requireEntitlement).mockReturnValue(false);

		await loadAllCustomFonts();
		await clickRecoveryAction();

		expect(requireEntitlement).toHaveBeenCalledWith("import");
		expect(chooseLocalFont).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(getCustomFonts()).toEqual([font]);
		expect(document.head.querySelector("style")).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("rejects a partial local record instead of using an already loaded nearby face", async () => {
		const font = {
			...customFont(
				"Roboto",
				"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap",
			),
			localFaces: [localFace("normal", 400)],
		};
		const fonts = installLocalDocumentFonts(undefined, [fontFace("Roboto", { weight: "700" })]);

		await expect(loadFont(font)).rejects.toThrow(/normal 700.*missing local face/);

		expect(fonts.load).not.toHaveBeenCalled();
		expect(document.head.querySelector("style")).toBeNull();
	});

	it("rejects a non-data local face without injecting its URL", async () => {
		const font = {
			...customFont(
				"Roboto",
				"https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap",
			),
			localFaces: [
				{ ...localFace("normal", 400), dataUrl: "https://fonts.gstatic.com/roboto.ttf" },
			],
		};
		const fonts = installLocalDocumentFonts();

		await expect(loadFont(font)).rejects.toThrow(/data URL is invalid/);

		expect(fonts.load).not.toHaveBeenCalled();
		expect(document.head.querySelector("style")).toBeNull();
		expectNoRemoteStylesheet();
	});

	it("cancelling the second Roboto picker leaves the original record and CSS unchanged", async () => {
		const font = customFont(
			"Roboto",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		const fonts = installLocalDocumentFonts();
		const chooseLocalFont = installLocalFontPicker();
		chooseLocalFont
			.mockResolvedValueOnce({ success: true, canceled: false, dataUrl: LOCAL_TTF_DATA_URL })
			.mockResolvedValueOnce({ success: false, canceled: true });

		await loadAllCustomFonts();
		await clickRecoveryAction();

		expect(chooseLocalFont).toHaveBeenCalledTimes(2);
		expect(fonts.load).not.toHaveBeenCalled();
		expect(getCustomFonts()).toEqual([font]);
		expect(document.head.querySelector("style")).toBeNull();
		expect(toast.success).not.toHaveBeenCalled();
		expectNoRemoteStylesheet();
	});

	it("a missing picker bridge leaves the original record unchanged", async () => {
		const font = customFont(
			"Roboto",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		installLocalDocumentFonts();
		Object.defineProperty(window, "electronAPI", { configurable: true, value: {} });

		await loadAllCustomFonts();
		await clickRecoveryAction();

		expect(getCustomFonts()).toEqual([font]);
		expect(document.head.querySelector("style")).toBeNull();
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining("Could not import"),
			expect.anything(),
		);
	});

	it("does not save when any selected variation fails to load", async () => {
		const font = customFont(
			"Roboto",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		const fonts = installLocalDocumentFonts((shorthand) => shorthand.includes("normal 700"));
		const chooseLocalFont = installLocalFontPicker();
		chooseLocalFont.mockResolvedValue({
			success: true,
			canceled: false,
			dataUrl: LOCAL_TTF_DATA_URL,
		});

		await loadAllCustomFonts();
		await clickRecoveryAction();

		expect(fonts.load).toHaveBeenCalledTimes(2);
		expect(getCustomFonts()).toEqual([font]);
		expect(document.head.querySelector("style")).toBeNull();
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining("could not load every selected variation"),
			expect.anything(),
		);
	});

	it("reports quota failure without claiming the recovered font was saved", async () => {
		const font = customFont(
			"Inter",
			"https://fonts.googleapis.com/css2?family=Inter:wght@300&display=swap",
		);
		localStorage.setItem("openscreen_custom_fonts", JSON.stringify([font]));
		const fonts = installLocalDocumentFonts();
		const chooseLocalFont = installLocalFontPicker();
		chooseLocalFont.mockResolvedValue({
			success: true,
			canceled: false,
			dataUrl: LOCAL_TTF_DATA_URL,
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("Storage is full", "QuotaExceededError");
		});

		await loadAllCustomFonts();
		await clickRecoveryAction();

		expect(getCustomFonts()).toEqual([font]);
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.dismiss).toHaveBeenCalledWith(`custom-font-recovery-${font.id}`);
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringMatching(/loaded for this session.*next launch/),
			{ duration: Number.POSITIVE_INFINITY, closeButton: true },
		);
		expect(document.head.querySelectorAll("style[data-custom-font-id]")).toHaveLength(1);
		await expect(loadFont(font)).resolves.toBeUndefined();
		expect(fonts.load).toHaveBeenCalledTimes(1);
	});
});
