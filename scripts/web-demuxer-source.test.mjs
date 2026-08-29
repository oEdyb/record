import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWebDemuxerSourceOffer, verifyWebDemuxerSourcePolicy } from "./web-demuxer-source.mjs";

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "klippt-web-demuxer-"));
	const wrapper = Buffer.from("wrapper-source");
	const ffmpeg = Buffer.from("ffmpeg-source");
	const nativeSources = [
		Buffer.from("macos-ffmpeg-source"),
		Buffer.from("btbn-ffmpeg-source"),
		Buffer.from("btbn-build-source"),
	];
	const wasm = Buffer.from("\0asmfixture");
	const policy = {
		schemaVersion: 1,
		package: {
			name: "web-demuxer",
			version: "4.0.0",
			npmTarball: "https://registry.example/web-demuxer.tgz",
			npmIntegrity: "sha512-fixture",
			repository: "https://github.com/bilibili/web-demuxer",
			tag: "4.0.0",
			commit: "1".repeat(40),
			license: "MIT",
		},
		ffmpeg: {
			repository: "https://github.com/FFmpeg/FFmpeg",
			commit: "2".repeat(40),
			license: "LGPL-2.1-or-later",
		},
		toolchain: { emscriptenVersion: "3.1.60", linuxAmd64Image: "image@sha256:test" },
		binary: {
			path: "public/wasm/web-demuxer.wasm",
			npmPath: "node_modules/web-demuxer/dist/wasm-files/web-demuxer.wasm",
			size: wasm.length,
			sha256: sha256(wasm),
		},
		build: { configureFlags: ["--disable-all"], linkFlags: ["-O3"] },
		sourceArchives: [
			{
				fileName: "web-demuxer-4.0.0-source.tar.gz",
				url: "https://source.example/wrapper.tar.gz",
				size: wrapper.length,
				sha256: sha256(wrapper),
			},
			{
				fileName: "ffmpeg-commit-source.tar.gz",
				url: "https://source.example/ffmpeg.tar.gz",
				size: ffmpeg.length,
				sha256: sha256(ffmpeg),
			},
		],
		nativeFfmpeg: {
			license: "LGPL-2.1-or-later",
			macos: { version: "8.1.2", buildCommand: "./configure && make" },
			btbn: {
				releaseTag: "autobuild-test",
				buildCommit: "3".repeat(40),
				ffmpegCommit: "4".repeat(40),
				buildCommands: Object.fromEntries(
					["win32-x64", "win32-arm64", "linux-x64", "linux-arm64"].map((target) => [
						target,
						"./build.sh target lgpl-shared 8.1",
					]),
				),
			},
			sourceArchives: nativeSources.map((bytes, index) => ({
				fileName: `native-source-${index}.tar.gz`,
				url: `https://source.example/native-${index}.tar.gz`,
				size: bytes.length,
				sha256: sha256(bytes),
				targets: [index === 0 ? "darwin-arm64" : "linux-x64"],
			})),
		},
	};
	await mkdir(path.join(root, "supply-chain"), { recursive: true });
	await mkdir(path.join(root, "public", "wasm"), { recursive: true });
	await mkdir(path.join(root, "node_modules", "web-demuxer", "dist", "wasm-files"), {
		recursive: true,
	});
	await writeFile(
		path.join(root, "package-lock.json"),
		JSON.stringify({
			packages: {
				"node_modules/web-demuxer": {
					version: policy.package.version,
					resolved: policy.package.npmTarball,
					integrity: policy.package.npmIntegrity,
				},
			},
		}),
	);
	await writeFile(path.join(root, "supply-chain", "web-demuxer.json"), JSON.stringify(policy));
	await writeFile(path.join(root, policy.binary.path), wasm);
	await writeFile(path.join(root, policy.binary.npmPath), wasm);
	return { root, policy, wrapper, ffmpeg, nativeSources };
}

describe("web-demuxer source policy", () => {
	it("binds the shipped binary to the locked npm package", async () => {
		const { root, policy } = await fixture();
		await expect(verifyWebDemuxerSourcePolicy({ root })).resolves.toMatchObject({
			binary: { sha256: policy.binary.sha256 },
		});
		await writeFile(path.join(root, policy.binary.path), "tampered");
		await expect(verifyWebDemuxerSourcePolicy({ root })).rejects.toThrow(
			/Shipped web-demuxer\.wasm/,
		);
	});

	it("publishes only hash-verified corresponding source", async () => {
		const { root, policy, wrapper, ffmpeg, nativeSources } = await fixture();
		const outputDir = path.join(root, "offer");
		const responses = new Map([
			[policy.sourceArchives[0].url, wrapper],
			[policy.sourceArchives[1].url, ffmpeg],
			...policy.nativeFfmpeg.sourceArchives.map((archive, index) => [
				archive.url,
				nativeSources[index],
			]),
		]);
		await buildWebDemuxerSourceOffer({
			root,
			outputDir,
			fetchImpl: async (url) =>
				new Response(responses.get(url), {
					headers: { "content-length": responses.get(url).length },
				}),
		});
		expect(await readFile(path.join(outputDir, policy.sourceArchives[0].fileName))).toEqual(
			wrapper,
		);
		expect(await readFile(path.join(outputDir, "native-source-2.tar.gz"))).toEqual(
			nativeSources[2],
		);
		expect(
			await readFile(path.join(outputDir, "web-demuxer-4.0.0-relinking.txt"), "utf8"),
		).toContain("standalone resources/web-demuxer.wasm");
	});

	it("fails closed when an upstream archive changes", async () => {
		const { root, wrapper } = await fixture();
		await expect(
			buildWebDemuxerSourceOffer({
				root,
				outputDir: path.join(root, "offer"),
				fetchImpl: async () => new Response(wrapper),
			}),
		).rejects.toThrow(/Source (size|hash) mismatch/);
	});
});
