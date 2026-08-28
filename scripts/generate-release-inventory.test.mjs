import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("release inventory", () => {
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
		const resources = path.join(packageRoot, "Contents", "Resources");
		const executable = path.join(packageRoot, "Contents", "MacOS", "Klippt");
		const wasm = path.join(resources, "app.asar.unpacked", "web-demuxer.wasm");
		const model = path.join(resources, "models", "encoder.onnx");
		const artifact = path.join(packageRoot, "Klippt.dmg");
		await mkdir(path.dirname(executable), { recursive: true });
		await mkdir(path.dirname(wasm), { recursive: true });
		await mkdir(path.dirname(model), { recursive: true });
		await writeFile(executable, Buffer.from("cffaedfe", "hex"), { mode: 0o755 });
		await writeFile(wasm, Buffer.from("0061736d01000000", "hex"));
		await writeFile(model, "model");
		await writeFile(path.join(resources, "app.asar"), "archive");
		await writeFile(artifact, "distribution");

		const inventory = await buildReleaseInventory({
			root: REPO_ROOT,
			packageDir: packageRoot,
			artifacts: [artifact],
			platform: "darwin",
			arch: "arm64",
			sourceSha: FIXED_SOURCE_SHA,
		});
		const packaged = inventory.components.filter((component) => component.ecosystem === "package");
		expect(packaged).toHaveLength(5);
		expect(packaged.find((component) => component.name === "Contents/MacOS/Klippt")?.role).toBe(
			"packaged-executable",
		);
		expect(
			packaged.find(
				(component) => component.name === "Contents/Resources/app.asar.unpacked/web-demuxer.wasm",
			)?.role,
		).toBe("packaged-webassembly");
		expect(
			packaged.find((component) => component.name === "Contents/Resources/models/encoder.onnx")
				?.role,
		).toBe("packaged-model");
		expect(
			inventory.components.find((component) => component.ecosystem === "distribution"),
		).toMatchObject({
			name: "Klippt.dmg",
			role: "release-artifact",
			hash: { algorithm: "SHA-256" },
		});
	});

	it("verifies and inventories the source-bound native helper manifest", async () => {
		const packageRoot = await temporaryDirectory("klippt-inventory-helper-");
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
			}),
		).rejects.toThrow(/Helper file size mismatch/);
	});
});
