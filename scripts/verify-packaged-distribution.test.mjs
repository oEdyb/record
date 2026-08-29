import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import {
	normalizeAsarEntryPath,
	verifyPackagedDistribution as verifyDistribution,
} from "./verify-packaged-distribution.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];
const buildOutputsByPackage = new Map();

function verifyPackagedDistribution(options) {
	return verifyDistribution({
		...options,
		buildOutputRoots: buildOutputsByPackage.get(options.packageDir),
	});
}

async function temporaryDirectory(prefix) {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function packageFixture(asarFiles = {}, { stagingFiles = {}, omitAsarFiles = [] } = {}) {
	const packageRoot = await temporaryDirectory("klippt-package-policy-");
	const resources = path.join(packageRoot, "Contents", "Resources");
	const appSource = await temporaryDirectory("klippt-package-policy-asar-");
	const reviewedDist = await temporaryDirectory("klippt-package-policy-dist-");
	const reviewedElectron = await temporaryDirectory("klippt-package-policy-electron-");
	await mkdir(resources, { recursive: true });
	await writeFile(path.join(appSource, "main.js"), "export {};\n");
	await mkdir(path.join(appSource, "dist", "assets"), { recursive: true });
	await writeFile(
		path.join(appSource, "dist", "index.html"),
		"<!doctype html><title>Klippt</title>\n",
	);
	await writeFile(
		path.join(appSource, "dist", "assets", "index-fixture1.js"),
		"export const fixture = true;\n",
	);
	await mkdir(path.join(appSource, "dist-electron"), { recursive: true });
	await writeFile(path.join(appSource, "dist-electron", "bootstrap.js"), "export {};\n");
	await writeFile(path.join(appSource, "dist-electron", "preload.mjs"), "export {};\n");
	for (const fileName of [
		"klippt-tray.png",
		"klippt-trayTemplate.png",
		"klippt-trayTemplate@2x.png",
		"rec-button.png",
	]) {
		await copyFile(
			path.join(REPO_ROOT, "public", fileName),
			path.join(appSource, "dist", fileName),
		);
	}
	await copyFile(
		path.join(REPO_ROOT, "src", "assets", "fonts", "Geist-Variable.woff2"),
		path.join(appSource, "dist", "assets", "Geist-Variable-fixture1.woff2"),
	);
	await copyFile(
		path.join(REPO_ROOT, "src", "assets", "fonts", "GeistMono-Variable.woff2"),
		path.join(appSource, "dist", "assets", "GeistMono-Variable-fixture1.woff2"),
	);
	await cp(
		path.join(REPO_ROOT, "public", "wallpapers"),
		path.join(appSource, "dist", "wallpapers"),
		{
			recursive: true,
		},
	);
	await cp(path.join(REPO_ROOT, "public", "wallpapers"), path.join(resources, "wallpapers"), {
		recursive: true,
	});
	await cp(
		path.join(REPO_ROOT, "public", "cursors", "default"),
		path.join(resources, "cursors", "default"),
		{ recursive: true },
	);
	await copyFile(
		path.join(REPO_ROOT, "icons", "icons", "mac", "icon.icns"),
		path.join(resources, "icon.icns"),
	);
	for (const [relativePath, contents] of Object.entries({
		"dist/wasm/web-demuxer.wasm": "excluded staging copy",
		"dist/cursors/legacy/pointer.png": "excluded cursor",
		"dist/demo.gif": "excluded demo",
		"dist/openscreen.png": "excluded brand",
		"dist/preview3.png": "excluded preview",
		"dist/vite.svg": "excluded template asset",
		...stagingFiles,
	})) {
		const destination = path.join(appSource, relativePath);
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, contents);
	}
	await cp(path.join(appSource, "dist"), reviewedDist, { recursive: true });
	await cp(path.join(appSource, "dist-electron"), reviewedElectron, { recursive: true });
	buildOutputsByPackage.set(
		packageRoot,
		new Map([
			["dist", reviewedDist],
			["dist-electron", reviewedElectron],
		]),
	);
	for (const relativePath of [
		"dist/wasm/web-demuxer.wasm",
		"dist/cursors",
		"dist/demo.gif",
		"dist/openscreen.png",
		"dist/preview3.png",
		"dist/vite.svg",
		...omitAsarFiles,
	]) {
		await rm(path.join(appSource, relativePath), { recursive: true, force: true });
	}
	for (const [relativePath, contents] of Object.entries(asarFiles)) {
		const destination = path.join(appSource, relativePath);
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, contents);
	}
	await createPackage(appSource, path.join(resources, "app.asar"));
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
	return packageRoot;
}

afterEach(async () => {
	buildOutputsByPackage.clear();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("packaged distribution policy", { timeout: 30_000 }, () => {
	it("keeps the host lookup path and normalizes Windows ASAR paths for policy", () => {
		expect(normalizeAsarEntryPath("\\dist\\assets\\image.data")).toEqual({
			lookupPath: "dist\\assets\\image.data",
			policyPath: "dist/assets/image.data",
		});
	});

	it("accepts one reviewed standalone WebAssembly file and the exact Electron notice", async () => {
		const packageDir = await packageFixture();
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).resolves.toMatchObject({ webAssemblyFiles: 1, modelFiles: 0 });
	});

	it("rejects dependency WebAssembly that the source policy did not approve", async () => {
		const packageDir = await packageFixture({
			"node_modules/web-demuxer/dist/wasm-files/web-demuxer-mini.wasm": Buffer.from(
				"0061736d01000000",
				"hex",
			),
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unapproved packaged WebAssembly/);
	});

	it("rejects an unapproved model and every Clean Voice release artifact", async () => {
		const packageDir = await packageFixture({
			"models/unapproved.onnx": "model",
			"native/klippt-clean-voice": "helper",
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Clean Voice|unapproved packaged model/i);
	});

	it("rejects a missing or changed Chromium third-party notice", async () => {
		const packageDir = await packageFixture();
		await writeFile(
			path.join(packageDir, "Contents", "Resources", "LICENSES.chromium.html"),
			"incomplete\n",
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Electron Chromium notice/);
	});

	it("rejects an unknown native helper even when it looks executable", async () => {
		const packageDir = await packageFixture();
		const nativeDirectory = path.join(
			packageDir,
			"Contents",
			"Resources",
			"electron",
			"native",
			"bin",
			"darwin-arm64",
		);
		await mkdir(nativeDirectory, { recursive: true });
		await writeFile(path.join(nativeDirectory, "surprise-helper"), "binary", { mode: 0o755 });
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged native file/);
	});

	it("rejects a helper-like library that only matches a broad family name", async () => {
		const packageDir = await packageFixture();
		const nativeDirectory = path.join(
			packageDir,
			"Contents",
			"Resources",
			"electron",
			"native",
			"bin",
			"darwin-arm64",
		);
		await mkdir(nativeDirectory, { recursive: true });
		await writeFile(path.join(nativeDirectory, "libggml-malware.dylib"), "binary");
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged native file/);
	});

	it("rejects an unlisted paid-package visual asset", async () => {
		const packageDir = await packageFixture();
		await writeFile(
			path.join(packageDir, "Contents", "Resources", "unapproved-paid-asset.png"),
			"asset",
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged visual or font asset/);
	});

	it("rejects an executable outside the reviewed native directory", async () => {
		const packageDir = await packageFixture();
		await copyFile(
			"/bin/echo",
			path.join(packageDir, "Contents", "Resources", "unreviewed-native-helper"),
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged executable|Unmapped packaged resource/);
	});

	it("rejects an alternate image format outside the reviewed asset policy", async () => {
		const packageDir = await packageFixture();
		await writeFile(
			path.join(packageDir, "Contents", "Resources", "unreviewed-wallpaper.tiff"),
			Buffer.from("49492a000800000000000000", "hex"),
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged visual or font asset|Unmapped packaged resource/);
	});

	it("rejects a disguised visual asset inside app.asar", async () => {
		const packageDir = await packageFixture({
			"dist/review-bypass/image.data": Buffer.from("49492a000800000000000000", "hex"),
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged visual or font asset/);
	});

	it("rejects an SVG with leading comments at an unreviewed dist path", async () => {
		const packageDir = await packageFixture({
			"dist/review-bypass/vector.data":
				"<!-- comment -->\n<svg xmlns='http://www.w3.org/2000/svg'/>\n",
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged application resource/);
	});

	it("rejects an unreviewed dist path that contains the ASAR display delimiter", async () => {
		const packageDir = await packageFixture({
			"dist/review!/vector.data": "<!-- comment -->\n<svg xmlns='http://www.w3.org/2000/svg'/>\n",
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged application resource/);
	});

	it("rejects an unreviewed file even when staging and ASAR bytes match", async () => {
		const packageDir = await packageFixture(
			{},
			{
				stagingFiles: {
					"dist/review-bypass/vector.data":
						"<!-- comment -->\n<svg xmlns='http://www.w3.org/2000/svg'/>\n",
				},
			},
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unapproved application build output/);
	});

	it("rejects non-JavaScript hidden behind a generated chunk name", async () => {
		const packageDir = await packageFixture(
			{},
			{
				stagingFiles: {
					"dist/assets/vector-AAAAAAAA.js":
						"<!-- comment -->\n<svg xmlns='http://www.w3.org/2000/svg'/>\n",
				},
			},
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Compiled JavaScript is not syntactically valid/);
	});

	it("rejects an SVG at an unreviewed dist-electron path", async () => {
		const packageDir = await packageFixture({
			"dist-electron/review-bypass/vector.data":
				"<!-- comment -->\n<svg xmlns='http://www.w3.org/2000/svg'/>\n",
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged application resource/);
	});

	it("rejects changed bytes at a compiled-looking application path", async () => {
		const packageDir = await packageFixture({
			"dist/assets/index-fixture1.js":
				"<!-- comment -->\n<svg xmlns='http://www.w3.org/2000/svg'/>\n",
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Packaged application output differs from its build/);
	});

	it.each([
		"dist/index.html",
		"dist-electron/bootstrap.js",
		"dist-electron/preload.mjs",
	])("rejects a package missing required build output %s", async (missingOutput) => {
		const packageDir = await packageFixture({}, { omitAsarFiles: [missingOutput] });
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Built application output is missing from ASAR/);
	});

	it("rejects a NUL-free PPM at an unreviewed dist path", async () => {
		const packageDir = await packageFixture({
			"dist/review-bypass/bitmap.data": "P6\n1 1\n255\nABC",
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged application resource/);
	});

	it("rejects a disguised BMP inside app.asar", async () => {
		const packageDir = await packageFixture({
			"dist/review-bypass/bitmap.data": Buffer.concat([Buffer.from("BM"), Buffer.alloc(62)]),
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged visual or font asset/);
	});

	it("rejects a disguised executable inside app.asar", async () => {
		const packageDir = await packageFixture({
			"dist/review-bypass/helper.data": await readFile("/bin/echo"),
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged executable/);
	});

	it("rejects a disguised 64-bit universal Mach-O inside app.asar", async () => {
		const packageDir = await packageFixture({
			"dist/review-bypass/fat64.data": Buffer.concat([
				Buffer.from("cafebabf", "hex"),
				Buffer.alloc(60),
			]),
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged executable/);
	});

	it("rejects changed bytes at a reviewed ASAR script path", async () => {
		const packageDir = await packageFixture({
			"node_modules/js-yaml/bin/js-yaml.js": "#!/usr/bin/env node\nmalicious();\n",
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Packaged executable script differs from policy/);
	});

	it("rejects disguised WebAssembly inside app.asar", async () => {
		const packageDir = await packageFixture({
			"dist/review-bypass/module.data": Buffer.from("0061736d01000000", "hex"),
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unapproved packaged WebAssembly/);
	});

	it("rejects unknown binary data inside app.asar without relying on a known magic", async () => {
		const packageDir = await packageFixture({
			"dist/review-bypass/unknown.data": Buffer.from([0x42, 0x49, 0x4e, 0, 1, 2]),
		});
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Unmapped packaged binary resource/);
	});

	it("requires provenance beside every Whisper helper", async () => {
		const packageDir = await packageFixture();
		const nativeDirectory = path.join(
			packageDir,
			"Contents",
			"Resources",
			"electron",
			"native",
			"bin",
			"darwin-arm64",
		);
		await mkdir(nativeDirectory, { recursive: true });
		await writeFile(path.join(nativeDirectory, "whisper-stt-server"), "helper", { mode: 0o755 });
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/no provenance manifest/);
	});

	it("rejects an excluded cursor pack and a changed reviewed notice", async () => {
		const packageDir = await packageFixture({
			"dist/cursors/legacy/arrow.png": "cursor",
		});
		await writeFile(
			path.join(packageDir, "Contents", "Resources", "THIRD-PARTY-NOTICES.md"),
			"changed",
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Excluded or unreviewed packaged asset|reviewed source/);
	});
});
