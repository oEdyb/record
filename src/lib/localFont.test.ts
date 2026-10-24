import { describe, expect, it } from "vitest";
import {
	LocalFontValidationError,
	MAX_LOCAL_FONT_BYTES,
	validateLocalFontBytes,
	validateLocalFontDataUrl,
} from "./localFont";

function bytes(header: number[], size = 12): Uint8Array {
	const result = new Uint8Array(size);
	result.set(header);
	return result;
}

function validationCode(run: () => unknown): string {
	try {
		run();
		return "accepted";
	} catch (error) {
		return error instanceof LocalFontValidationError ? error.code : "unexpected-error";
	}
}

describe("local font validation", () => {
	it.each([
		["font.ttf", bytes([0, 1, 0, 0]), "font/ttf", "truetype"],
		["legacy.ttf", bytes([0x74, 0x72, 0x75, 0x65]), "font/ttf", "truetype"],
		["font.otf", bytes([0x4f, 0x54, 0x54, 0x4f]), "font/otf", "opentype"],
		["font.woff", bytes([0x77, 0x4f, 0x46, 0x46]), "font/woff", "woff"],
		["font.woff2", bytes([0x77, 0x4f, 0x46, 0x32]), "font/woff2", "woff2"],
	] as const)("accepts %s with its matching signature", (fileName, data, mimeType, format) => {
		expect(validateLocalFontBytes(fileName, data)).toEqual({ mimeType, format });
	});

	it("rejects an unsupported signature and an extension mismatch", () => {
		expect(
			validationCode(() => validateLocalFontBytes("font.ttf", bytes([0x4f, 0x54, 0x54, 0x4f]))),
		).toBe("invalid-font");
		expect(validationCode(() => validateLocalFontBytes("font.woff", bytes([0, 1, 0, 0])))).toBe(
			"invalid-font",
		);
	});

	it("rejects files over 2 MiB", () => {
		expect(
			validationCode(() =>
				validateLocalFontBytes("font.ttf", bytes([0, 1, 0, 0], MAX_LOCAL_FONT_BYTES + 1)),
			),
		).toBe("font-too-large");
	});

	it("validates persisted data URLs as font bytes rather than CSS text", () => {
		const data = bytes([0x77, 0x4f, 0x46, 0x32]);
		const dataUrl = `data:font/woff2;base64,${Buffer.from(data).toString("base64")}`;

		expect(validateLocalFontDataUrl(dataUrl)).toEqual({
			mimeType: "font/woff2",
			format: "woff2",
		});
		expect(validationCode(() => validateLocalFontDataUrl("https://example.com/font.woff2"))).toBe(
			"invalid-font",
		);
		expect(
			validationCode(() =>
				validateLocalFontDataUrl(
					`data:font/woff2;base64,${Buffer.from(bytes([0, 1, 0, 0])).toString("base64")}`,
				),
			),
		).toBe("invalid-font");
	});
});
