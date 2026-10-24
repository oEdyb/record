import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LOCAL_FONT_BYTES } from "../../src/lib/localFont";
import { readLocalFontDataUrl } from "./localFontFile";

const directories: string[] = [];

async function fontFile(name: string, data: Buffer): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "klippt-local-font-"));
	directories.push(directory);
	const filePath = path.join(directory, name);
	await writeFile(filePath, data);
	return filePath;
}

function validFont(header: number[], size = 12): Buffer {
	const data = Buffer.alloc(size);
	data.set(header);
	return data;
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("readLocalFontDataUrl", () => {
	it("returns the selected font bytes with the correct MIME type and no path", async () => {
		const data = validFont([0x4f, 0x54, 0x54, 0x4f]);
		const filePath = await fontFile("Exact Light.otf", data);

		const result = await readLocalFontDataUrl(filePath);

		expect(result.startsWith("data:font/otf;base64,")).toBe(true);
		expect(result).not.toContain(filePath);
		expect(Buffer.from(result.slice(result.indexOf(",") + 1), "base64")).toEqual(data);
	});

	it("rejects an oversize file before returning any data", async () => {
		const filePath = await fontFile("large.ttf", validFont([0, 1, 0, 0], MAX_LOCAL_FONT_BYTES + 1));
		await expect(readLocalFontDataUrl(filePath)).rejects.toMatchObject({ code: "font-too-large" });
	});

	it("rejects a file whose signature does not match its extension", async () => {
		const filePath = await fontFile("not-a-font.woff2", validFont([0, 1, 0, 0]));
		await expect(readLocalFontDataUrl(filePath)).rejects.toMatchObject({ code: "invalid-font" });
	});
});
