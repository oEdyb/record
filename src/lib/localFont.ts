export const MAX_LOCAL_FONT_BYTES = 2 * 1024 * 1024;

export type LocalFontStyle = "normal" | "italic";
export type LocalFontMimeType = "font/ttf" | "font/otf" | "font/woff" | "font/woff2";
export type LocalFontFormat = "truetype" | "opentype" | "woff" | "woff2";
export type LocalFontFileErrorCode = "invalid-font" | "font-too-large" | "read-failed";

export interface LocalFontVariation {
	style: LocalFontStyle;
	weight: number;
}

export interface LocalFontFace extends LocalFontVariation {
	dataUrl: string;
}

export interface ChooseLocalFontRequest extends LocalFontVariation {
	family: string;
	styleLabel: string;
}

export type ChooseLocalFontResult =
	| { success: true; canceled: false; dataUrl: string }
	| { success: false; canceled: true }
	| {
			success: false;
			canceled: false;
			error: LocalFontFileErrorCode | "invalid-request" | "picker-failed";
	  };

interface LocalFontDefinition {
	mimeType: LocalFontMimeType;
	format: LocalFontFormat;
	extension: string;
	signatures: readonly (readonly number[])[];
}

const DEFINITIONS: readonly LocalFontDefinition[] = [
	{
		mimeType: "font/ttf",
		format: "truetype",
		extension: ".ttf",
		signatures: [
			[0x00, 0x01, 0x00, 0x00],
			[0x74, 0x72, 0x75, 0x65],
		],
	},
	{
		mimeType: "font/otf",
		format: "opentype",
		extension: ".otf",
		signatures: [[0x4f, 0x54, 0x54, 0x4f]],
	},
	{
		mimeType: "font/woff",
		format: "woff",
		extension: ".woff",
		signatures: [[0x77, 0x4f, 0x46, 0x46]],
	},
	{
		mimeType: "font/woff2",
		format: "woff2",
		extension: ".woff2",
		signatures: [[0x77, 0x4f, 0x46, 0x32]],
	},
];

export class LocalFontValidationError extends Error {
	constructor(
		readonly code: LocalFontFileErrorCode,
		message: string,
	) {
		super(message);
		this.name = "LocalFontValidationError";
	}
}

function matchesSignature(data: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((value, index) => data[index] === value);
}

export function validateLocalFontBytes(
	fileName: string,
	data: Uint8Array,
): { mimeType: LocalFontMimeType; format: LocalFontFormat } {
	if (data.byteLength > MAX_LOCAL_FONT_BYTES) {
		throw new LocalFontValidationError("font-too-large", "The font file is over 2 MiB");
	}
	const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
	const definition = DEFINITIONS.find((candidate) => candidate.extension === extension);
	if (
		!definition ||
		data.byteLength < 12 ||
		!definition.signatures.some((signature) => matchesSignature(data, signature))
	) {
		throw new LocalFontValidationError(
			"invalid-font",
			"The font file type or signature is invalid",
		);
	}
	return { mimeType: definition.mimeType, format: definition.format };
}

export function validateLocalFontDataUrl(dataUrl: string): {
	mimeType: LocalFontMimeType;
	format: LocalFontFormat;
} {
	if (dataUrl.length > 4 * Math.ceil(MAX_LOCAL_FONT_BYTES / 3) + 64) {
		throw new LocalFontValidationError("font-too-large", "The font data is over 2 MiB");
	}
	const match = /^data:(font\/(?:ttf|otf|woff|woff2));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
	if (!match) {
		throw new LocalFontValidationError("invalid-font", "The font data URL is invalid");
	}
	const [, mimeType, payload] = match;
	if (!payload || payload.length % 4 !== 0) {
		throw new LocalFontValidationError("invalid-font", "The font data encoding is invalid");
	}
	let binary: string;
	try {
		binary = atob(payload);
	} catch {
		throw new LocalFontValidationError("invalid-font", "The font data encoding is invalid");
	}
	if (btoa(binary) !== payload) {
		throw new LocalFontValidationError("invalid-font", "The font data encoding is invalid");
	}
	const data = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
	const definition = DEFINITIONS.find((candidate) => candidate.mimeType === mimeType);
	if (!definition) {
		throw new LocalFontValidationError("invalid-font", "The font MIME type is invalid");
	}
	return validateLocalFontBytes(`local-font${definition.extension}`, data);
}
