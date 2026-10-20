import { describe, expect, it } from "vitest";
import { publicationPlan, rcloneUploadArgs } from "./publish-mac-release.mjs";
import {
	assertNotaryAccepted,
	findDeveloperIdIdentity,
	notaryProfileSetupCommand,
	parseArguments,
	releaseFileNames,
} from "./release-mac.mjs";

describe("local macOS release", () => {
	it("names artifacts the way the feed and download manifest expect", () => {
		expect(releaseFileNames("2.1.0")).toEqual({
			dmg: "Klippt-macOS-Apple-Silicon-2.1.0.dmg",
			zip: "Klippt-Mac-arm64-2.1.0.zip",
			sidecar: "update-info-arm64.json",
		});
	});

	it("accepts only the Dyberg Developer ID signer", () => {
		const output = [
			'  1) ABC "Apple Development: Someone (XYZ)"',
			'  2) DEF "Developer ID Application: Dyberg & Co AB (LF8KF3G42Q)"',
		].join("\n");
		expect(findDeveloperIdIdentity(output)).toBe("Dyberg & Co AB (LF8KF3G42Q)");
		expect(
			findDeveloperIdIdentity('  1) ABC "Apple Development: Dyberg & Co AB (LF8KF3G42Q)"'),
		).toBe(null);
	});

	it("tells the owner how to create the notary profile without taking a password", () => {
		const command = notaryProfileSetupCommand("klippt-notary");
		expect(command).toContain("notarytool store-credentials klippt-notary");
		expect(command).toContain("--team-id LF8KF3G42Q");
		expect(command).not.toContain("--password");
	});

	it("staples only an Accepted submission", () => {
		expect(() => assertNotaryAccepted({ id: "a", status: "Accepted" })).not.toThrow();
		expect(() => assertNotaryAccepted({ id: "a", status: "Invalid" })).toThrow(/Invalid/);
		expect(() => assertNotaryAccepted({ status: "Accepted" })).toThrow(/no submission ID/);
	});

	it("refuses unknown options", () => {
		expect(parseArguments(["--skip-native"])).toMatchObject({ skipNative: true });
		expect(() => parseArguments(["--notarize=false"])).toThrow(/Unknown option/);
	});
});

describe("publishing a staged release", () => {
	it("uploads every immutable file before the manifests", () => {
		expect(
			publicationPlan([
				"latest.json",
				"Klippt-Mac-arm64-2.1.0.zip",
				"latest-mac.yml",
				"Klippt-macOS-Apple-Silicon-2.1.0.dmg",
			]),
		).toEqual({
			immutable: ["Klippt-Mac-arm64-2.1.0.zip", "Klippt-macOS-Apple-Silicon-2.1.0.dmg"],
			manifests: ["latest-mac.yml", "latest.json"],
		});
	});

	it("never overwrites an artifact and never caches a manifest", () => {
		const artifact = rcloneUploadArgs({
			file: "/x/a.dmg",
			bucket: "klippt-updates",
			accountId: "acct",
			name: "a.dmg",
			manifest: false,
		});
		expect(artifact).toContain("--immutable");
		expect(artifact).toContain(":s3:klippt-updates/klippt/a.dmg");
		expect(artifact.join(" ")).toContain("max-age=31536000, immutable");

		const manifest = rcloneUploadArgs({
			file: "/x/latest.json",
			bucket: "klippt-updates",
			accountId: "acct",
			name: "latest.json",
			manifest: true,
		});
		expect(manifest).not.toContain("--immutable");
		expect(manifest.join(" ")).toContain("no-store");
		expect(manifest.join(" ")).toContain("Content-Type: application/json");
		expect(manifest.join(" ")).not.toMatch(/secret|key-id/i);
	});
});
