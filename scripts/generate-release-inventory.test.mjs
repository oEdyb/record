import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { FFMPEG_MAC_SOURCE } from "./ffmpeg-pins.mjs";
import {
	buildCycloneDx,
	buildReleaseInventory,
	readNpmComponents,
	validateCycloneDx,
} from "./generate-release-inventory.mjs";
import { createHelperManifest } from "./helper-provenance.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const temporaryDirectories = [];

async function temporaryDirectory(prefix) {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function addRequiredPackageResources(packageRoot) {
	const resources = path.join(packageRoot, "Contents", "Resources");
	const appSource = await temporaryDirectory("klippt-inventory-asar-");
	const reviewedDist = await temporaryDirectory("klippt-inventory-dist-");
	const reviewedElectron = await temporaryDirectory("klippt-inventory-electron-");
	await mkdir(resources, { recursive: true });
	await copyFile(
		path.join(REPO_ROOT, "public", "wasm", "web-demuxer.wasm"),
		path.join(resources, "web-demuxer.wasm"),
	);
	await copyFile(
		path.join(REPO_ROOT, "node_modules", "electron", "dist", "LICENSES.chromium.html"),
		path.join(resources, "LICENSES.chromium.html"),
	);
	for (const fileName of ["LICENSE", "THIRD-PARTY-INVENTORY.json", "THIRD-PARTY-NOTICES.md"]) {
		await copyFile(path.join(REPO_ROOT, fileName), path.join(resources, fileName));
	}
	await cp(
		path.join(REPO_ROOT, "third-party-licenses"),
		path.join(resources, "third-party-licenses"),
		{
			recursive: true,
		},
	);
	await writeFile(path.join(appSource, "main.js"), "export {};\n");
	await mkdir(path.join(appSource, "dist", "assets"), { recursive: true });
	await writeFile(
		path.join(appSource, "dist", "index.html"),
		"<!doctype html><title>Klippt</title>\n",
	);
	await copyFile(
		path.join(REPO_ROOT, "src", "assets", "fonts", "Geist-Variable.woff2"),
		path.join(appSource, "dist", "assets", "Geist-Variable-fixture1.woff2"),
	);
	await copyFile(
		path.join(REPO_ROOT, "src", "assets", "fonts", "GeistMono-Variable.woff2"),
		path.join(appSource, "dist", "assets", "GeistMono-Variable-fixture1.woff2"),
	);
	await mkdir(path.join(appSource, "dist-electron"), { recursive: true });
	await writeFile(path.join(appSource, "dist-electron", "bootstrap.js"), "export {};\n");
	await writeFile(path.join(appSource, "dist-electron", "preload.mjs"), "export {};\n");
	await cp(path.join(appSource, "dist"), reviewedDist, { recursive: true });
	await cp(path.join(appSource, "dist-electron"), reviewedElectron, { recursive: true });
	await createPackage(appSource, path.join(resources, "app.asar"));
	return {
		resources,
		buildOutputRoots: new Map([
			["dist", reviewedDist],
			["dist-electron", reviewedElectron],
		]),
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("release inventory", { timeout: 30_000 }, () => {
	it("rejects a source label that is not an exact commit", async () => {
		await expect(buildReleaseInventory({ root: REPO_ROOT, sourceSha: "main" })).rejects.toThrow(
			/source commit must be 40 hex digits/,
		);
	});

	it("derives npm dependencies from the lockfile and ignores stale node_modules", async () => {
		const root = await temporaryDirectory("klippt-inventory-npm-");
		await mkdir(path.join(root, "node_modules", "stale-local-package"), { recursive: true });
		await writeFile(
			path.join(root, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": { name: "fixture", version: "1.0.0" },
					"node_modules/runtime": {
						version: "2.0.0",
						integrity: `sha512-${Buffer.from("runtime").toString("base64")}`,
					},
					"node_modules/development-only": { version: "3.0.0", dev: true },
				},
			}),
		);
		await writeFile(path.join(root, "node_modules", "stale-local-package", "package.json"), "{}\n");

		const components = readNpmComponents(root);
		expect(components.map((component) => component.name)).toEqual(["runtime"]);
		expect(components[0]?.hash?.value).toBe(Buffer.from("runtime").toString("hex"));
	});

	it("creates a deterministic, valid CycloneDX 1.7 SBOM with every source family", async () => {
		const nativeRoot = await temporaryDirectory("klippt-inventory-native-");
		const targetRoot = path.join(nativeRoot, "darwin-arm64");
		await mkdir(path.join(targetRoot, "framework"), { recursive: true });
		await writeFile(path.join(targetRoot, "openscreen-screencapturekit-helper"), "capture-helper");
		await writeFile(path.join(targetRoot, "framework", "libavcodec.dylib"), "ffmpeg-library");
		await writeFile(path.join(targetRoot, "klippt-clean-voice"), "development-only");
		if (process.platform !== "win32") {
			await symlink("openscreen-screencapturekit-helper", path.join(targetRoot, "capture-link"));
		}

		const options = {
			root: REPO_ROOT,
			nativeDir: nativeRoot,
			platform: "darwin",
			arch: "arm64",
			sourceSha: FIXED_SOURCE_SHA,
		};
		const first = await buildReleaseInventory(options);
		const second = await buildReleaseInventory(options);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(new Set(first.components.map((component) => component.ecosystem))).toEqual(
			new Set(["npm", "cargo", "swift", "ffmpeg", "model", "webassembly", "native"]),
		);
		expect(
			first.components.some((component) => component.name === "openscreen-screencapturekit-helper"),
		).toBe(true);
		expect(
			first.components.some((component) => component.name === "framework/libavcodec.dylib"),
		).toBe(true);
		if (process.platform !== "win32") {
			expect(
				first.components.some(
					(component) =>
						component.name === "capture-link" &&
						component.symlinkTarget === "openscreen-screencapturekit-helper",
				),
			).toBe(true);
		}
		expect(
			first.components.some(
				(component) => component.ecosystem === "native" && component.name === "klippt-clean-voice",
			),
		).toBe(false);
		expect(
			first.components.some((component) => component.name === "@cyclonedx/cyclonedx-library"),
		).toBe(false);
		expect(
			first.components.some(
				(component) => component.name === "electron" && component.role === "packaged-runtime",
			),
		).toBe(true);

		const wasm = first.components.find((component) => component.id.startsWith("wasm:web-demuxer@"));
		const expectedWasmHash = createHash("sha256")
			.update(await readFile(path.join(REPO_ROOT, wasm.path)))
			.digest("hex");
		expect(wasm.hash.value).toBe(expectedWasmHash);
		expect(wasm).toMatchObject({
			license: "MIT AND LGPL-2.1-or-later",
			source:
				"https://github.com/bilibili/web-demuxer/commit/91721712b063bd65ac5963aa4e03e7eda4b17eff",
		});
		expect(wasm.configureFlags).toContain("--disable-asm");
		expect(wasm.correspondingSource).toHaveLength(2);

		const externalCargo = first.components.filter(
			(component) => component.ecosystem === "cargo" && component.source !== "workspace",
		);
		expect(externalCargo.length).toBeGreaterThan(0);
		expect(externalCargo.every((component) => Boolean(component.license))).toBe(true);
		expect(
			first.components.find(
				(component) => component.ecosystem === "swift" && component.name === "fluidaudio",
			)?.license,
		).toBe("Apache-2.0");
		expect(
			first.components.find((component) => component.name === "DeepFilterNet3 ONNX embedded model"),
		).toMatchObject({
			license: "LicenseRef-Distribution-Unconfirmed",
			distributionStatus: "excluded-from-release",
		});

		const macSource = first.components.find((component) =>
			component.id.startsWith("ffmpeg:source:"),
		);
		expect(macSource.configureFlags).toEqual(FFMPEG_MAC_SOURCE.configureFlags);
		expect(macSource.configureFlags).toContain("--enable-audiotoolbox");
		expect(macSource.configureFlags).toContain("--disable-x86asm");

		const sbom = buildCycloneDx(first);
		await expect(validateCycloneDx(sbom)).resolves.toBeUndefined();
		expect(sbom.specVersion).toBe("1.7");
		expect(sbom.components).toHaveLength(first.components.length);
	});

	it("rejects a native staging symlink that escapes the packaged tree", async () => {
		if (process.platform === "win32") return;
		const nativeRoot = await temporaryDirectory("klippt-inventory-escape-");
		const targetRoot = path.join(nativeRoot, "darwin-arm64");
		const outside = await temporaryDirectory("klippt-inventory-outside-");
		await mkdir(targetRoot, { recursive: true });
		await writeFile(path.join(outside, "helper"), "outside");
		await symlink(path.join(outside, "helper"), path.join(targetRoot, "escaped-helper"));

		await expect(
			buildReleaseInventory({
				root: REPO_ROOT,
				nativeDir: nativeRoot,
				platform: "darwin",
				arch: "arm64",
				sourceSha: FIXED_SOURCE_SHA,
			}),
		).rejects.toThrow(/symlink escapes its target directory/);
	});

	it("hashes the complete packaged payload and final distribution artifacts", async () => {
		const packageRoot = await temporaryDirectory("klippt-inventory-package-");
		const { resources, buildOutputRoots } = await addRequiredPackageResources(packageRoot);
		const executable = path.join(packageRoot, "Contents", "MacOS", "Klippt");
		const artifact = path.join(packageRoot, "Klippt.dmg");
		await mkdir(path.dirname(executable), { recursive: true });
		await writeFile(executable, Buffer.from("cffaedfe", "hex"), { mode: 0o755 });
		await writeFile(artifact, "distribution");

		const inventory = await buildReleaseInventory({
			root: REPO_ROOT,
			packageDir: packageRoot,
			artifacts: [artifact],
			platform: "darwin",
			arch: "arm64",
			sourceSha: FIXED_SOURCE_SHA,
			buildOutputRoots,
		});
		const packaged = inventory.components.filter((component) => component.ecosystem === "package");
		expect(packaged.length).toBeGreaterThan(5);
		expect(packaged.find((component) => component.name === "Contents/MacOS/Klippt")?.role).toBe(
			"packaged-executable",
		);
		expect(
			packaged.find((component) => component.name === "Contents/Resources/web-demuxer.wasm")?.role,
		).toBe("packaged-webassembly");
		expect(
			inventory.components.find((component) => component.ecosystem === "distribution"),
		).toMatchObject({
			name: "Klippt.dmg",
			role: "release-artifact",
			hash: { algorithm: "SHA-256" },
		});

		await mkdir(path.join(resources, "models"), { recursive: true });
		await writeFile(path.join(resources, "models", "unapproved.onnx"), "model");
		await expect(
			buildReleaseInventory({
				root: REPO_ROOT,
				packageDir: packageRoot,
				platform: "darwin",
				arch: "arm64",
				sourceSha: FIXED_SOURCE_SHA,
				buildOutputRoots,
			}),
		).rejects.toThrow(/Unapproved packaged model/);
	});

	it("verifies and inventories the source-bound native helper manifest", async () => {
		const packageRoot = await temporaryDirectory("klippt-inventory-helper-");
		const { buildOutputRoots } = await addRequiredPackageResources(packageRoot);
		const helperRoot = path.join(
			packageRoot,
			"Contents",
			"Resources",
			"electron",
			"native",
			"bin",
			"darwin-arm64",
		);
		await mkdir(helperRoot, { recursive: true });
		await writeFile(path.join(helperRoot, "whisper-stt-server"), "helper", { mode: 0o755 });
		await createHelperManifest({
			directory: helperRoot,
			helper: "whisper-stt",
			sourceSha: FIXED_SOURCE_SHA,
			workflowRunId: "7788",
			target: "darwin-arm64",
			upstream: [
				{
					name: "whisper.cpp",
					repository: "https://github.com/ggml-org/whisper.cpp.git",
					revision: "f049fff95a089aa9969deb009cdd4892b3e74916",
				},
			],
			toolchains: { cmake: "4.1.1" },
		});

		const inventory = await buildReleaseInventory({
			root: REPO_ROOT,
			packageDir: packageRoot,
			platform: "darwin",
			arch: "arm64",
			sourceSha: FIXED_SOURCE_SHA,
			buildOutputRoots,
		});
		expect(
			inventory.components.find((component) => component.role === "native-helper-manifest"),
		).toMatchObject({
			sourceCommit: FIXED_SOURCE_SHA,
			workflowRunId: "7788",
			target: "darwin-arm64",
		});

		await writeFile(path.join(helperRoot, "whisper-stt-server"), "tampered");
		await expect(
			buildReleaseInventory({
				root: REPO_ROOT,
				packageDir: packageRoot,
				platform: "darwin",
				arch: "arm64",
				sourceSha: FIXED_SOURCE_SHA,
				buildOutputRoots,
			}),
		).rejects.toThrow(/Helper file size mismatch/);
	});
});
