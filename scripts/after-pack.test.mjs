import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { MAC_UPDATE_CONFIG, writeMacUpdateConfig } = require("./after-pack.cjs").__testing;

describe("macOS after-pack hook", () => {
	it("writes the owned feed before code signing", () => {
		const out = mkdtempSync(path.join(os.tmpdir(), "klippt-after-pack-"));
		mkdirSync(path.join(out, "Klippt.app", "Contents", "Resources"), { recursive: true });
		const result = writeMacUpdateConfig(out, "Klippt");
		expect(readFileSync(result, "utf8")).toBe(MAC_UPDATE_CONFIG);
	});

	it("fails when the expected app bundle is absent", () => {
		const out = mkdtempSync(path.join(os.tmpdir(), "klippt-after-pack-"));
		expect(() => writeMacUpdateConfig(out, "Klippt")).toThrow("resources directory is missing");
	});
});
