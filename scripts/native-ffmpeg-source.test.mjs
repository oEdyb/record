import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildNativeFfmpegSourceEvidence,
	isNativeFfmpegEvidenceFileName,
} from "./native-ffmpeg-source.mjs";

const configuration =
	"--prefix=/build --enable-shared --disable-static --disable-gpl --disable-nonfree --enable-avcodec";

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function fixture(configurations = [configuration]) {
	const root = await mkdtemp(path.join(os.tmpdir(), "klippt-native-ffmpeg-"));
	const packageDir = path.join(root, "Klippt.app");
	const nativeDir = path.join(
		packageDir,
		"Contents",
		"Resources",
		"electron",
		"native",
		"bin",
		"darwin-arm64",
	);
	await mkdir(nativeDir, { recursive: true });
	for (const [index, value] of configurations.entries()) {
		await writeFile(
			path.join(nativeDir, index === 0 ? "ffmpeg" : `libavutil.${index}.dylib`),
			Buffer.concat([Buffer.from(`binary-${index}\0`), Buffer.from(value), Buffer.from("\0tail")]),
		);
	}
	const source = Buffer.from("source");
	const policy = {
		schemaVersion: 1,
		package: { name: "web-demuxer", version: "4.0.0", commit: "1".repeat(40) },
		ffmpeg: { commit: "2".repeat(40) },
		binary: { size: 1, sha256: "3".repeat(64) },
		sourceArchives: [
			{
				fileName: "wrapper.tar.gz",
				url: "https://example.test/wrapper",
				size: 1,
				sha256: "4".repeat(64),
			},
			{
				fileName: "wasm-ffmpeg.tar.gz",
				url: "https://example.test/ffmpeg",
				size: 1,
				sha256: "5".repeat(64),
			},
		],
		nativeFfmpeg: {
			license: "LGPL-2.1-or-later",
			macos: {
				version: "8.1.2",
				buildCommand:
					"./configure <the exact target configuration in the target manifest> && make && make install",
			},
			btbn: {
				buildCommit: "6".repeat(40),
				ffmpegCommit: "7".repeat(40),
				buildCommands: Object.fromEntries(
					["win32-x64", "win32-arm64", "linux-x64", "linux-arm64"].map((target) => [
						target,
						"./build.sh target lgpl-shared 8.1",
					]),
				),
			},
			sourceArchives: [
				{
					fileName: "mac-source.tar.xz",
					url: "https://example.test/mac",
					size: source.length,
					sha256: sha256(source),
					targets: ["darwin-arm64", "darwin-x64"],
				},
				{
					fileName: "btbn-ffmpeg.tar.gz",
					url: "https://example.test/btbn-ffmpeg",
					size: 1,
					sha256: "8".repeat(64),
					targets: ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64"],
				},
				{
					fileName: "btbn-build.tar.gz",
					url: "https://example.test/btbn-build",
					size: 1,
					sha256: "9".repeat(64),
					targets: ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64"],
				},
			],
		},
	};
	await mkdir(path.join(root, "supply-chain"), { recursive: true });
	await writeFile(path.join(root, "supply-chain", "web-demuxer.json"), JSON.stringify(policy));
	return { root, packageDir, nativeDir };
}

describe("native FFmpeg source evidence", () => {
	it("binds the exact packaged files, configuration, source, and relinking recipe", async () => {
		const { root, packageDir, nativeDir } = await fixture();
		const outputDir = path.join(root, "out");
		const result = await buildNativeFfmpegSourceEvidence({
			root,
			packageDir,
			target: "darwin-arm64",
			outputDir,
		});
		expect(result.files.every(isNativeFfmpegEvidenceFileName)).toBe(true);
		expect(result.manifest).toMatchObject({
			license: "LGPL-2.1-or-later",
			target: "darwin-arm64",
			sourceArchives: [{ fileName: "mac-source.tar.xz" }],
		});
		expect(result.manifest.packagedFiles[0]).toMatchObject({
			path: "Contents/Resources/electron/native/bin/darwin-arm64/ffmpeg",
			sha256: sha256(await readFile(path.join(nativeDir, "ffmpeg"))),
		});
		expect(
			await readFile(path.join(outputDir, "native-ffmpeg-darwin-arm64-configuration.txt"), "utf8"),
		).toContain(configuration);
		expect(
			await readFile(path.join(outputDir, "native-ffmpeg-darwin-arm64-relinking.txt"), "utf8"),
		).toContain("Replace the matching files");
	});

	it("rejects a GPL or nonfree packaged build", async () => {
		for (const forbidden of ["--enable-gpl", "--enable-nonfree"]) {
			const { root, packageDir } = await fixture([
				configuration.replace(forbidden.replace("enable", "disable"), forbidden),
			]);
			await expect(
				buildNativeFfmpegSourceEvidence({
					root,
					packageDir,
					target: "darwin-arm64",
					outputDir: path.join(root, "out"),
				}),
			).rejects.toThrow(/enables (GPL|nonfree) code/);
		}
	});

	it("rejects packaged libraries that report different configurations", async () => {
		const { root, packageDir } = await fixture([
			configuration,
			configuration.replace("--enable-avcodec", "--enable-avformat"),
		]);
		await expect(
			buildNativeFfmpegSourceEvidence({
				root,
				packageDir,
				target: "darwin-arm64",
				outputDir: path.join(root, "out"),
			}),
		).rejects.toThrow(/Expected one packaged FFmpeg configuration/);
	});
});
