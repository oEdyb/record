import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { nativeFfmpegEvidenceFileNames } from "./native-ffmpeg-source.mjs";
import { buildReleaseManifest, stageUpdateRelease } from "./stage-update-release.mjs";
import { loadWebDemuxerPolicy, sourceOfferFileNames } from "./web-demuxer-source.mjs";

const version = "2.0.0";
const files = [
	`Klippt-macOS-Apple-Silicon-${version}.dmg`,
	`Klippt-macOS-Intel-${version}.dmg`,
	`Klippt.Setup.${version}.exe`,
	`Klippt-Linux-${version}.AppImage`,
	`Klippt-Mac-arm64-${version}.zip`,
	`Klippt-Mac-x64-${version}.zip`,
];
const sourcePolicy = loadWebDemuxerPolicy();
const sourceOfferFiles = [
	...sourceOfferFileNames(sourcePolicy),
	...["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].flatMap(
		nativeFfmpegEvidenceFileNames,
	),
];

function descriptor(fileName) {
	return {
		url: fileName,
		size: Buffer.byteLength(fileName),
		sha512: createHash("sha512").update(fileName).digest("base64"),
	};
}

function writeFeeds(source) {
	writeFileSync(
		path.join(source, "latest.yml"),
		stringify({
			files: [descriptor(files[2])],
			path: files[2],
			sha512: descriptor(files[2]).sha512,
		}),
	);
	writeFileSync(
		path.join(source, "latest-mac.yml"),
		stringify({ files: [descriptor(files[4]), descriptor(files[5])] }),
	);
	writeFileSync(
		path.join(source, "latest-linux.yml"),
		stringify({ files: [descriptor(files[3])] }),
	);
}

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
		for (const fileName of sourceOfferFiles) {
			writeFileSync(path.join(source, fileName), fileName);
		}
		writeFeeds(source);

		stageUpdateRelease(source, version, output, "0123456789abcdef0123456789abcdef01234567");
		const manifest = JSON.parse(readFileSync(path.join(output, "latest.json"), "utf8"));
		expect(manifest.version).toBe(version);
		expect(manifest.source.commit).toBe("0123456789abcdef0123456789abcdef01234567");
		expect(manifest.artifacts[files[0]]).toMatchObject({ size: files[0].length });
		expect(Buffer.from(manifest.artifacts[files[0]].sha512, "base64")).toHaveLength(64);
		expect(readFileSync(path.join(output, files[0]), "utf8")).toBe(files[0]);
		expect(Object.keys(manifest.artifacts)).toEqual(expect.arrayContaining(sourceOfferFiles));
		expect(readFileSync(path.join(output, sourceOfferFiles[0]), "utf8")).toBe(sourceOfferFiles[0]);
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

	it("refuses a release that omits corresponding-source or target evidence", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "klippt-release-test-"));
		for (const fileName of files) writeFileSync(path.join(root, fileName), fileName);
		writeFeeds(root);
		expect(() => stageUpdateRelease(root, version, path.join(root, "out"))).toThrow(
			/missing LGPL release evidence/,
		);
	});
});
