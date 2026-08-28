import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { webDemuxerWasmUrl } from "./webDemuxerAsset";

describe("webDemuxerWasmUrl", () => {
	it("resolves the Vite public asset from the development origin", () => {
		expect(webDemuxerWasmUrl("http://localhost:5173/editor/project-1")).toBe(
			"http://localhost:5173/wasm/web-demuxer.wasm",
		);
	});

	it("resolves beside the packaged Electron index", () => {
		expect(
			webDemuxerWasmUrl(
				"file:///Applications/Klippt.app/Contents/Resources/app.asar/dist/index.html",
			),
		).toBe(
			"file:///Applications/Klippt.app/Contents/Resources/app.asar/dist/wasm/web-demuxer.wasm",
		);
	});

	it("ships a real WebAssembly binary in the public asset directory", () => {
		const bytes = readFileSync(path.resolve("public/wasm/web-demuxer.wasm"));
		expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
	});
});
