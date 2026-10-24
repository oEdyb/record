// Offline loading and migration helpers for legacy stored Google Fonts

import { toast } from "sonner";
import { requireEntitlement } from "@/lib/entitlements/store";
import { getInitialLocale, translate } from "../i18n/loader";
import { type LocalFontFace, type LocalFontVariation, validateLocalFontDataUrl } from "./localFont";

export interface CustomFont {
	id: string;
	name: string;
	fontFamily: string;
	importUrl: string; // Legacy Google Fonts CSS2 request, used for local resolution only
	localFaces?: LocalFontFace[];
}

const STORAGE_KEY = "openscreen_custom_fonts";
const loadedFonts = new Set<string>();

export function getCustomFonts(): CustomFont[] {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored ? JSON.parse(stored) : [];
	} catch (error) {
		console.error("Failed to load custom fonts from storage:", error);
		return [];
	}
}

export function saveCustomFonts(fonts: CustomFont[]): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(fonts));
}

// Throws if the font fails to load
export async function addCustomFont(font: CustomFont): Promise<CustomFont[]> {
	const fonts = getCustomFonts();
	const exists = fonts.some((f) => f.id === font.id || f.fontFamily === font.fontFamily);

	if (exists) {
		return fonts;
	}

	// Load first so a failure throws before we persist it
	await loadFont(font);

	fonts.push(font);
	saveCustomFonts(fonts);

	return fonts;
}

function removeLocalFontStyles(fontId: string): void {
	document.getElementById(`custom-font-${fontId}`)?.remove();
	document.head.querySelectorAll("style[data-custom-font-id]").forEach((style) => {
		if (style.getAttribute("data-custom-font-id") === fontId) style.remove();
	});
}

export function removeCustomFont(fontId: string): CustomFont[] {
	const fonts = getCustomFonts();
	const filtered = fonts.filter((f) => f.id !== fontId);
	saveCustomFonts(filtered);
	removeLocalFontStyles(fontId);
	loadedFonts.delete(fontId);
	return filtered;
}

type FontVariation = LocalFontVariation;

const REGULAR_AND_BOLD: readonly number[] = [400, 700];
const REGULAR_ONLY: readonly number[] = [400];
const NO_WEIGHTS: readonly number[] = [];
const BUNDLED_FONT_WEIGHTS = new Map<
	string,
	{ normal: readonly number[]; italic: readonly number[] }
>([
	["bebas neue", { normal: REGULAR_ONLY, italic: NO_WEIGHTS }],
	["caveat", { normal: REGULAR_AND_BOLD, italic: NO_WEIGHTS }],
	["dm sans", { normal: REGULAR_AND_BOLD, italic: REGULAR_AND_BOLD }],
	["fira code", { normal: REGULAR_AND_BOLD, italic: NO_WEIGHTS }],
	["ibm plex mono", { normal: REGULAR_AND_BOLD, italic: REGULAR_AND_BOLD }],
	["ibm plex sans", { normal: REGULAR_AND_BOLD, italic: REGULAR_AND_BOLD }],
	["inter", { normal: REGULAR_AND_BOLD, italic: REGULAR_AND_BOLD }],
	["lora", { normal: REGULAR_AND_BOLD, italic: REGULAR_AND_BOLD }],
	["manrope", { normal: REGULAR_AND_BOLD, italic: NO_WEIGHTS }],
	["merriweather", { normal: REGULAR_AND_BOLD, italic: REGULAR_AND_BOLD }],
	["oswald", { normal: REGULAR_AND_BOLD, italic: NO_WEIGHTS }],
	["permanent marker", { normal: REGULAR_ONLY, italic: NO_WEIGHTS }],
	["playfair display", { normal: REGULAR_AND_BOLD, italic: REGULAR_AND_BOLD }],
	["plus jakarta sans", { normal: REGULAR_AND_BOLD, italic: REGULAR_AND_BOLD }],
	["space grotesk", { normal: REGULAR_AND_BOLD, italic: NO_WEIGHTS }],
	["sora", { normal: REGULAR_AND_BOLD, italic: NO_WEIGHTS }],
]);

function cleanFontFamily(value: string): string {
	const collapsed = value.trim().replace(/\s+/g, " ");
	if (collapsed.length < 2) return collapsed;
	const first = collapsed[0];
	const last = collapsed[collapsed.length - 1];
	return (first === '"' && last === '"') || (first === "'" && last === "'")
		? collapsed.slice(1, -1)
		: collapsed;
}

function normalizeFontFamily(value: string): string {
	return cleanFontFamily(value).toLowerCase();
}

function quoteCssString(value: string): string {
	const escaped = Array.from(value, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint === 0) return "�";
		if (character === "\\" || character === '"') return `\\${character}`;
		if (codePoint < 0x20 || codePoint === 0x7f) return `\\${codePoint.toString(16)} `;
		return character;
	}).join("");
	return `"${escaped}"`;
}

function fontShorthand(fontFamily: string, variation: FontVariation): string {
	return `${variation.style} ${variation.weight} 16px ${quoteCssString(fontFamily)}`;
}

function parseRequestedVariations(importUrl: string, fontFamily: string): FontVariation[] {
	if (!isValidGoogleFontsUrl(importUrl))
		throw new Error("the stored URL is not a Google Fonts URL");
	const url = new URL(importUrl);
	const familySpecs = url.searchParams.getAll("family");
	if (familySpecs.length !== 1) throw new Error("only one stored family can be verified");
	const [familySpec] = familySpecs;
	const separator = familySpec.indexOf(":");
	const requestedFamily = (separator === -1 ? familySpec : familySpec.slice(0, separator)).replace(
		/\+/g,
		" ",
	);
	if (normalizeFontFamily(requestedFamily) !== normalizeFontFamily(fontFamily)) {
		throw new Error("the stored family and URL family do not match");
	}
	if (separator === -1) return [{ style: "normal", weight: 400 }];

	const [axisList, tupleList, extra] = familySpec.slice(separator + 1).split("@");
	if (!axisList || !tupleList || extra !== undefined) {
		throw new Error("the Google Fonts axis request is unsupported");
	}
	const axes = axisList.split(",");
	if (
		axes.some((axis) => axis !== "ital" && axis !== "wght") ||
		new Set(axes).size !== axes.length
	) {
		throw new Error("only italic and weight axes can be verified locally");
	}
	const variations = tupleList.split(";").map((tuple): FontVariation => {
		const values = tuple.split(",");
		if (values.length !== axes.length) throw new Error("the font axis tuple is malformed");
		const variation: FontVariation = { style: "normal", weight: 400 };
		axes.forEach((axis, index) => {
			const value = values[index];
			if (axis === "ital") {
				if (value !== "0" && value !== "1") throw new Error("the italic axis is malformed");
				variation.style = value === "1" ? "italic" : "normal";
				return;
			}
			if (!/^\d{1,4}(?:\.\d+)?$/.test(value)) throw new Error("the weight axis is malformed");
			variation.weight = Number(value);
			if (variation.weight < 1 || variation.weight > 1000) {
				throw new Error("the requested weight is outside the CSS font-weight range");
			}
		});
		return variation;
	});
	return [
		...new Map(
			variations.map((variation) => [`${variation.style}-${variation.weight}`, variation]),
		).values(),
	];
}

function weightIncludes(weight: string, requestedWeight: number): boolean {
	const normalized = weight.trim().toLowerCase();
	if (normalized === "normal") return requestedWeight === 400;
	if (normalized === "bold") return requestedWeight === 700;
	const parts = normalized.split(/\s+/).map(Number);
	if (parts.some((part) => !Number.isFinite(part))) return false;
	if (parts.length === 1) return parts[0] === requestedWeight;
	return parts.length === 2 && requestedWeight >= parts[0] && requestedWeight <= parts[1];
}

function isAlreadyLoadedLocally(fontFamily: string, variation: FontVariation): boolean {
	if (!("fonts" in document)) return false;
	const normalizedFamily = normalizeFontFamily(fontFamily);
	const matchingFace = [...document.fonts].some(
		(face) =>
			face.status === "loaded" &&
			normalizeFontFamily(face.family) === normalizedFamily &&
			face.style === variation.style &&
			weightIncludes(face.weight, variation.weight),
	);
	return matchingFace && document.fonts.check(fontShorthand(fontFamily, variation));
}

function unavailableFont(font: CustomFont, reason: string): Error {
	return new Error(
		`Custom font "${font.name}" (${font.fontFamily}) is unavailable offline: ${reason}. Remote font stylesheets are disabled.`,
	);
}

async function withTimeout<T>(operation: Promise<T>, timeout = 5000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Local font load timed out")), timeout);
	});
	try {
		return await Promise.race([operation, timeoutPromise]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function waitForBundledFont(fontFamily: string, variation: FontVariation): Promise<void> {
	if (!("fonts" in document)) throw new Error("the Font Loading API is unavailable");
	const shorthand = fontShorthand(fontFamily, variation);
	const faces = await withTimeout(document.fonts.load(shorthand));
	if (faces.length === 0 || !document.fonts.check(shorthand)) {
		throw new Error("no matching bundled font face loaded");
	}
}

interface ResolvedLocalFace {
	variation: FontVariation;
	dataUrl: string;
	format: ReturnType<typeof validateLocalFontDataUrl>["format"];
}

function resolveLocalFontFaces(font: CustomFont, variations: FontVariation[]): ResolvedLocalFace[] {
	if (!Array.isArray(font.localFaces)) throw new Error("local face data is malformed");
	const usedIndexes = new Set<number>();
	const resolved = variations.map((variation): ResolvedLocalFace => {
		const index = font.localFaces?.findIndex((candidate) => {
			if (!candidate || typeof candidate !== "object") return false;
			return candidate.style === variation.style && candidate.weight === variation.weight;
		});
		if (index === undefined || index < 0 || usedIndexes.has(index)) {
			throw new Error(`${variation.style} ${variation.weight} is missing local face data`);
		}
		usedIndexes.add(index);
		const candidate = font.localFaces?.[index];
		if (!candidate || typeof candidate.dataUrl !== "string") {
			throw new Error(`${variation.style} ${variation.weight} has invalid local face data`);
		}
		const { format } = validateLocalFontDataUrl(candidate.dataUrl);
		return { variation, dataUrl: candidate.dataUrl, format };
	});
	if (resolved.length !== font.localFaces.length) {
		throw new Error("local face data contains duplicate or unrequested variations");
	}
	return resolved;
}

async function loadLocalFontFaces(
	font: CustomFont,
	fontFamily: string,
	variations: FontVariation[],
): Promise<void> {
	const resolved = resolveLocalFontFaces(font, variations);
	if (!("fonts" in document)) throw new Error("the Font Loading API is unavailable");
	removeLocalFontStyles(font.id);
	const addedStyles: HTMLStyleElement[] = [];
	try {
		for (const [index, localFace] of resolved.entries()) {
			const { variation, dataUrl, format } = localFace;
			const shorthand = fontShorthand(fontFamily, variation);
			const existingFaces = new Set([...document.fonts]);
			const style = document.createElement("style");
			style.id = `custom-font-${font.id}-${index}`;
			style.setAttribute("data-custom-font-id", font.id);
			style.textContent = `@font-face { font-family: ${quoteCssString(fontFamily)}; src: url("${dataUrl}") format("${format}"); font-style: ${variation.style}; font-weight: ${variation.weight}; }`;
			document.head.appendChild(style);
			addedStyles.push(style);
			const faces = await withTimeout(document.fonts.load(shorthand));
			const loadedLocalFace = faces.some(
				(face) =>
					!existingFaces.has(face) &&
					face.status === "loaded" &&
					normalizeFontFamily(face.family) === normalizeFontFamily(fontFamily) &&
					face.style === variation.style &&
					weightIncludes(face.weight, variation.weight),
			);
			if (!loadedLocalFace || !document.fonts.check(shorthand)) {
				throw new Error(`no exact local face loaded for ${variation.style} ${variation.weight}`);
			}
		}
	} catch (error) {
		addedStyles.forEach((style) => style.remove());
		throw error;
	}
}

export async function loadFont(font: CustomFont): Promise<void> {
	if (loadedFonts.has(font.id)) return;
	const fontFamily = cleanFontFamily(font.fontFamily);
	if (!fontFamily) throw unavailableFont(font, "the family name is empty");
	let variations: FontVariation[];
	try {
		variations = parseRequestedVariations(font.importUrl, fontFamily);
	} catch (error) {
		throw unavailableFont(font, error instanceof Error ? error.message : "the request is invalid");
	}
	const bundledWeights = BUNDLED_FONT_WEIGHTS.get(normalizeFontFamily(fontFamily));
	try {
		if (font.localFaces !== undefined) {
			await loadLocalFontFaces(font, fontFamily, variations);
		} else {
			for (const variation of variations) {
				if (bundledWeights) {
					if (!bundledWeights[variation.style].includes(variation.weight)) {
						throw new Error(`${variation.style} ${variation.weight} is not bundled`);
					}
					await waitForBundledFont(fontFamily, variation);
				} else if (!isAlreadyLoadedLocally(fontFamily, variation)) {
					throw new Error(`${variation.style} ${variation.weight} is not already loaded locally`);
				}
			}
		}
	} catch (error) {
		throw unavailableFont(font, error instanceof Error ? error.message : "local loading failed");
	}
	loadedFonts.add(font.id);
}

function reportCustomFontFailure(font: CustomFont, error: unknown): void {
	const args: unknown[] = ["Failed to load custom font:", font.name, error];
	const rendererConsole = (
		window as {
			electronAPI?: {
				rendererConsole?: (channel: "error", args: unknown[]) => void;
			};
		}
	).electronAPI?.rendererConsole;
	if (rendererConsole) {
		try {
			rendererConsole("error", args);
			return;
		} catch {
			// Fall back to the local console if the bridge itself fails.
		}
	}
	console.error(...args);
}

function editorT(key: string, vars?: Record<string, string | number>): string {
	return translate(getInitialLocale(), "editor", `customFonts.${key}`, vars);
}

function exactFontVariations(font: CustomFont): FontVariation[] | null {
	const fontFamily = cleanFontFamily(font.fontFamily);
	if (!fontFamily) return null;
	try {
		return parseRequestedVariations(font.importUrl, fontFamily);
	} catch {
		return null;
	}
}

function showUnsupportedFontToast(font: CustomFont): void {
	toast.error(editorT("unsupportedFormat", { family: font.name }), {
		id: `custom-font-recovery-${font.id}`,
		duration: Number.POSITIVE_INFINITY,
		closeButton: true,
	});
}

type RecoveryResult =
	| { status: "recovered" }
	| { status: "cancelled" }
	| { status: "entitlement-required" }
	| { status: "unsupported-format" }
	| { status: "import-failed"; variation: FontVariation }
	| { status: "load-failed" }
	| { status: "save-failed" };

async function recoverCustomFontLocally(font: CustomFont): Promise<RecoveryResult> {
	const variations = exactFontVariations(font);
	if (!variations) return { status: "unsupported-format" };
	if (!requireEntitlement("import")) return { status: "entitlement-required" };
	const localFaces: LocalFontFace[] = [];
	for (const variation of variations) {
		try {
			const chooseLocalFont = window.electronAPI?.chooseLocalFont;
			if (!chooseLocalFont) return { status: "import-failed", variation };
			const result = await chooseLocalFont({
				family: cleanFontFamily(font.fontFamily),
				style: variation.style,
				weight: variation.weight,
				styleLabel: editorT(variation.style),
			});
			if (result.canceled) return { status: "cancelled" };
			if (!result.success) return { status: "import-failed", variation };
			localFaces.push({ ...variation, dataUrl: result.dataUrl });
		} catch {
			return { status: "import-failed", variation };
		}
	}
	const recovered = { ...font, localFaces };
	try {
		await loadFont(recovered);
	} catch {
		return { status: "load-failed" };
	}
	const fonts = getCustomFonts();
	const index = fonts.findIndex((candidate) => candidate.id === font.id);
	if (index < 0) return { status: "load-failed" };
	const updated = [...fonts];
	updated[index] = recovered;
	try {
		saveCustomFonts(updated);
	} catch {
		return { status: "save-failed" };
	}
	return { status: "recovered" };
}

const recoveringFonts = new Set<string>();

function showRecoveryToast(font: CustomFont, failure?: RecoveryResult): void {
	const id = `custom-font-recovery-${font.id}`;
	let message = editorT("recoveryNeeded", { family: font.name });
	if (failure?.status === "import-failed") {
		message = editorT("importFailed", {
			family: font.name,
			style: editorT(failure.variation.style),
			weight: failure.variation.weight,
		});
	} else if (failure?.status === "load-failed") {
		message = editorT("loadFailed", { family: font.name });
	}
	const show = failure ? toast.error : toast.warning;
	show(message, {
		id,
		duration: Number.POSITIVE_INFINITY,
		closeButton: true,
		action: {
			label: editorT("chooseLocal"),
			onClick: (event) => {
				event.preventDefault();
				return recoverAndReport(font);
			},
		},
	});
}

async function recoverAndReport(font: CustomFont): Promise<void> {
	if (recoveringFonts.has(font.id)) return;
	recoveringFonts.add(font.id);
	try {
		const result = await recoverCustomFontLocally(font);
		if (result.status === "unsupported-format") {
			showUnsupportedFontToast(font);
			return;
		}
		if (result.status === "entitlement-required") return;
		if (result.status === "cancelled") {
			showRecoveryToast(font);
			return;
		}
		if (result.status === "import-failed" || result.status === "load-failed") {
			showRecoveryToast(font, result);
			return;
		}
		const id = `custom-font-recovery-${font.id}`;
		toast.dismiss(id);
		if (result.status === "save-failed") {
			toast.error(editorT("saveFailed", { family: font.name }), {
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
			});
			return;
		}
		toast.success(editorT("recovered", { family: font.name }));
	} finally {
		recoveringFonts.delete(font.id);
	}
}

// Load all stored custom fonts on app init
export function loadAllCustomFonts(): Promise<void[]> {
	const fonts = getCustomFonts();
	return Promise.all(
		fonts.map((font) =>
			loadFont(font).catch((err) => {
				reportCustomFontFailure(font, err);
				if (exactFontVariations(font)) showRecoveryToast(font);
				else showUnsupportedFontToast(font);
			}),
		),
	);
}

export function generateFontId(name: string): string {
	return `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
}

// Extract the font family from a legacy Google Fonts CSS request
export function parseFontFamilyFromImport(importUrl: string): string | null {
	try {
		const url = new URL(importUrl);
		const familyParam = url.searchParams.get("family");

		if (familyParam) {
			// "Roboto:wght@400;700" -> "Roboto"
			const fontName = familyParam.split(":")[0];
			// "Open+Sans" -> "Open Sans"
			return fontName.replace(/\+/g, " ");
		}

		return null;
	} catch (error) {
		console.error("Failed to parse font family from import URL:", error);
		return null;
	}
}

// Does this look like a Google Fonts import URL?
export function isValidGoogleFontsUrl(url: string): boolean {
	try {
		const urlObj = new URL(url);
		return urlObj.hostname === "fonts.googleapis.com" && urlObj.searchParams.has("family");
	} catch {
		return false;
	}
}
