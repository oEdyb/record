import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { MAC_UPDATE_CONFIG, buildFuseConfig, resolvePackagedAppPath, writeMacUpdateConfig } =
	require("./after-pack.cjs").__testing;

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

	it("resolves the packaged executable on each supported platform", () => {
		const context = {
			appOutDir: "/tmp/out",
			packager: {
				appInfo: { productFilename: "Klippt" },
				executableName: "klippt",
			},
		};

		expect(resolvePackagedAppPath({ ...context, electronPlatformName: "darwin" })).toBe(
			"/tmp/out/Klippt.app",
		);
		expect(resolvePackagedAppPath({ ...context, electronPlatformName: "win32" })).toBe(
			"/tmp/out/Klippt.exe",
		);
		expect(resolvePackagedAppPath({ ...context, electronPlatformName: "linux" })).toBe(
			"/tmp/out/klippt",
		);
	});

	it("sets every Electron 44 fuse explicitly", async () => {
		expect(await buildFuseConfig()).toEqual({
			version: FuseVersion.V1,
			strictlyRequireAllFuses: true,
			[FuseV1Options.RunAsNode]: false,
			[FuseV1Options.EnableCookieEncryption]: true,
			[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
			[FuseV1Options.EnableNodeCliInspectArguments]: false,
			[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
			[FuseV1Options.OnlyLoadAppFromAsar]: true,
			[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
			[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
			[FuseV1Options.WasmTrapHandlers]: true,
		});
	});
});
