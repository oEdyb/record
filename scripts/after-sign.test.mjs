import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
	__testing: { HELPERS, verifyMacIdentity, requirement, isUnsignedCiArtifact },
	default: afterSign,
} = require("./after-sign.cjs");
const directories = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(arches = ["darwin-arm64"], helpers = Object.keys(HELPERS)) {
	const app = mkdtempSync(path.join(os.tmpdir(), "klippt-signing-test-"));
	directories.push(app);
	for (const arch of arches) {
		const dir = path.join(app, "Contents/Resources/electron/native/bin", arch);
		mkdirSync(dir, { recursive: true });
		for (const name of helpers) writeFileSync(path.join(dir, name), "fixture");
	}
	return app;
}

describe("stable macOS permission identity", () => {
	it("allows only explicitly unsigned CI artifacts to skip the install identity check", () => {
		expect(
			isUnsignedCiArtifact({
				CI: "true",
				GITHUB_ACTIONS: "true",
				CSC_IDENTITY_AUTO_DISCOVERY: "false",
				CSC_NAME: "",
			}),
		).toBe(true);
		const unsigned = { CI: "true", GITHUB_ACTIONS: "true", CSC_IDENTITY_AUTO_DISCOVERY: "false" };
		expect(isUnsignedCiArtifact(unsigned, { identity: "Apple Development" })).toBe(false);
		expect(isUnsignedCiArtifact(unsigned, { sign: "custom-sign.cjs" })).toBe(false);
		expect(isUnsignedCiArtifact({ ...unsigned, CSC_NAME: "Apple Development" })).toBe(false);
		expect(isUnsignedCiArtifact({ ...unsigned, CSC_LINK: "certificate" })).toBe(false);
		for (const env of [
			{},
			{ CSC_IDENTITY_AUTO_DISCOVERY: "false" },
			{ CI: "true" },
			{ CI: "true", CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_NAME: "Apple Development" },
			{ CI: "true", CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_LINK: "signing-certificate" },
		]) {
			expect(isUnsignedCiArtifact(env)).toBe(false);
		}
	});
	it("validates the app and every helper on each architecture against Developer ID requirements", () => {
		const app = fixture(["darwin-arm64", "darwin-x64"]);
		const run = vi.fn();
		verifyMacIdentity(app, run);
		expect(run).toHaveBeenCalledTimes(5);
		expect(run.mock.calls[0][1]).toEqual([
			"--verify",
			"--deep",
			"--strict",
			"-R",
			`=${requirement("co.dyberg.klippt")}`,
			app,
		]);
		const required = run.mock.calls.slice(1).map((call) => call[1][3]);
		expect(required).toContain(`=${requirement("co.dyberg.klippt.cursor-helper")}`);
		expect(required).toContain(`=${requirement("co.dyberg.klippt.screencapturekit-helper")}`);
		for (const call of run.mock.calls) {
			expect(call[1]).toContainEqual(expect.stringContaining("1.2.840.113635.100.6.1.13"));
			expect(call[1]).toContainEqual(expect.stringContaining("LF8KF3G42Q"));
		}
	});
	it("rejects an app with the old development signature", () => {
		expect(() =>
			verifyMacIdentity(fixture(), () => {
				throw new Error("requirement failed");
			}),
		).toThrow("invalidate macOS permissions");
	});
	it("rejects a helper that does not share the stable signing identity", () => {
		const run = vi
			.fn()
			.mockImplementationOnce(() => undefined)
			.mockImplementationOnce(() => {
				throw new Error("helper requirement failed");
			});
		expect(() => verifyMacIdentity(fixture(), run)).toThrow("helper requirement failed");
	});
	it("rejects a missing helper even when the outer signature verifies", () => {
		expect(() => verifyMacIdentity(fixture([]), vi.fn())).toThrow(
			"klippt-cursor-helper is missing",
		);
		expect(() =>
			verifyMacIdentity(fixture(["darwin-arm64"], ["klippt-cursor-helper"]), vi.fn()),
		).toThrow("klippt-screencapturekit-helper is missing");
	});
	it("leaves other packaging platforms alone", async () => {
		await expect(afterSign({ electronPlatformName: "win32" })).resolves.toBeUndefined();
	});
});
