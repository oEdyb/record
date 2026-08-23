import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest, stageUpdateRelease } from "./stage-update-release.mjs";

const version = "2.0.0";
const files = [
	`Klippt-macOS-Apple-Silicon-${version}.dmg`,
	`Klippt-macOS-Intel-${version}.dmg`,
	`Klippt.Setup.${version}.exe`,
	`Klippt-Linux-${version}.AppImage`,
];

describe("owned update release", () => {
	it("builds a platform-aware manifest on the owned host", () => {
		const manifest = buildReleaseManifest(files, version);
		expect(manifest).toEqual({
			version,
			downloads: {
				"darwin-arm64": `https://updates.dyberg.co/klippt/${files[0]}`,
				"darwin-x64": `https://updates.dyberg.co/klippt/${files[1]}`,
				"win32-x64": `https://updates.dyberg.co/klippt/${files[2]}`,
				"linux-x64": `https://updates.dyberg.co/klippt/${files[3]}`,
			},
		});
	});

	it("refuses an incomplete release", () => {
		expect(() => buildReleaseManifest(files.slice(1), version)).toThrow("Apple Silicon DMG");
	});

	it("flattens release artifacts and writes latest.json", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "klippt-release-test-"));
		const source = path.join(root, "artifacts");
		const output = path.join(root, "staged");
		for (const [index, fileName] of files.entries()) {
			const folder = path.join(source, String(index));
			mkdirSync(folder, { recursive: true });
			writeFileSync(path.join(folder, fileName), fileName);
		}
		for (const feed of ["latest.yml", "latest-mac.yml", "latest-linux.yml"]) {
			writeFileSync(path.join(source, feed), `${feed}\n`);
		}

		stageUpdateRelease(source, version, output);
		const manifest = JSON.parse(readFileSync(path.join(output, "latest.json"), "utf8"));
		expect(manifest.version).toBe(version);
		expect(readFileSync(path.join(output, files[0]), "utf8")).toBe(files[0]);
	});

	it("refuses duplicate basenames from different build artifacts", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "klippt-release-test-"));
		for (const folder of ["a", "b"]) {
			mkdirSync(path.join(root, folder), { recursive: true });
			writeFileSync(path.join(root, folder, files[0]), folder);
		}
		expect(() => stageUpdateRelease(root, version, path.join(root, "out"))).toThrow(
			"duplicate release filename",
		);
	});
});
