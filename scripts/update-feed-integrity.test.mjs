import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { validateElectronUpdateFeeds } from "./update-feed-integrity.mjs";

const artifact = (text) => ({
	size: Buffer.byteLength(text),
	sha512: Buffer.from("a".repeat(64)).toString("base64"),
});
const artifacts = {
	"Klippt.Setup.2.0.0.exe": artifact("windows"),
	"Klippt-Linux-2.0.0.AppImage": artifact("linux"),
	"Klippt-Mac-arm64-2.0.0.zip": artifact("arm"),
	"Klippt-Mac-x64-2.0.0.zip": artifact("intel"),
};
const descriptor = (fileName) => ({ url: fileName, ...artifacts[fileName] });

function feeds() {
	return {
		"latest.yml": stringify({ files: [descriptor("Klippt.Setup.2.0.0.exe")] }),
		"latest-linux.yml": stringify({ files: [descriptor("Klippt-Linux-2.0.0.AppImage")] }),
		"latest-mac.yml": stringify({
			files: [descriptor("Klippt-Mac-arm64-2.0.0.zip"), descriptor("Klippt-Mac-x64-2.0.0.zip")],
		}),
	};
}

describe("Electron update-feed integrity", () => {
	it("accepts feeds whose files, sizes, and hashes match both Mac architectures", () => {
		expect(() => validateElectronUpdateFeeds(feeds(), artifacts)).not.toThrow();
	});

	it("rejects a missing artifact and an integrity mismatch", () => {
		const missing = feeds();
		missing["latest.yml"] = stringify({
			files: [{ ...descriptor("Klippt.Setup.2.0.0.exe"), url: "missing.exe" }],
		});
		expect(() => validateElectronUpdateFeeds(missing, artifacts)).toThrow(/missing artifact/);

		const wrongSize = feeds();
		wrongSize["latest.yml"] = stringify({
			files: [{ ...descriptor("Klippt.Setup.2.0.0.exe"), size: 99 }],
		});
		expect(() => validateElectronUpdateFeeds(wrongSize, artifacts)).toThrow(/integrity mismatch/);

		const wrongHash = feeds();
		wrongHash["latest.yml"] = stringify({
			files: [
				{
					...descriptor("Klippt.Setup.2.0.0.exe"),
					sha512: Buffer.from("b".repeat(64)).toString("base64"),
				},
			],
		});
		expect(() => validateElectronUpdateFeeds(wrongHash, artifacts)).toThrow(/integrity mismatch/);
	});

	it("rejects duplicate and escaping URLs", () => {
		const duplicate = feeds();
		duplicate["latest.yml"] = stringify({
			files: [descriptor("Klippt.Setup.2.0.0.exe"), descriptor("Klippt.Setup.2.0.0.exe")],
		});
		expect(() => validateElectronUpdateFeeds(duplicate, artifacts)).toThrow(/duplicate/);

		const escaping = feeds();
		escaping["latest.yml"] = stringify({
			files: [{ ...descriptor("Klippt.Setup.2.0.0.exe"), url: "../Klippt.Setup.2.0.0.exe" }],
		});
		expect(() => validateElectronUpdateFeeds(escaping, artifacts)).toThrow(/escapes/);
	});

	it("rejects a Mac feed that does not bind both architectures", () => {
		const incomplete = feeds();
		incomplete["latest-mac.yml"] = stringify({
			files: [descriptor("Klippt-Mac-arm64-2.0.0.zip")],
		});
		expect(() => validateElectronUpdateFeeds(incomplete, artifacts)).toThrow(/arm64 and one x64/);
	});
});
