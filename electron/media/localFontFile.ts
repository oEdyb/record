import fs from "node:fs/promises";
import {
	LocalFontValidationError,
	MAX_LOCAL_FONT_BYTES,
	validateLocalFontBytes,
} from "../../src/lib/localFont";

export async function readLocalFontDataUrl(filePath: string): Promise<string> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) {
			throw new LocalFontValidationError("read-failed", "The selected font is not a regular file");
		}
		if (stat.size > MAX_LOCAL_FONT_BYTES) {
			throw new LocalFontValidationError("font-too-large", "The font file is over 2 MiB");
		}
		const data = await fs.readFile(filePath);
		const { mimeType } = validateLocalFontBytes(filePath, data);
		return `data:${mimeType};base64,${data.toString("base64")}`;
	} catch (error) {
		if (error instanceof LocalFontValidationError) throw error;
		throw new LocalFontValidationError("read-failed", "The selected font could not be read");
	}
}
