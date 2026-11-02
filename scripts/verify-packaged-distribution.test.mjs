import { createHash } from "node:crypto";
import { constants, globSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	normalizeAsarEntryPath,
	verifyPackagedDistribution as verifyDistribution,
} from "./verify-packaged-distribution.mjs";

// The real pinned ffprobe is ~100 MB; stand in a tiny one with the same pin shape.
const { PINNED_PROBE } = vi.hoisted(() => ({ PINNED_PROBE: "pinned ffprobe" }));
vi.mock("./ffmpeg-pins.mjs", async (importOriginal) => {
	const pins = await importOriginal();
	const probe = {
		name: "ffprobe",
		size: Buffer.byteLength(PINNED_PROBE),
		sha256: createHash("sha256").update(PINNED_PROBE).digest("hex"),
	};
	return {
		...pins,
		FFMPEG_ARCHIVES: Object.fromEntries(
			Object.entries(pins.FFMPEG_ARCHIVES).map(([target, spec]) => [
				target,
				spec.probe ? { ...spec, probe } : spec,
			]),
		),
	};
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];
const buildOutputsByPackage = new Map();
const fixtureBases = new Map();
const baseDirectories = [];
const cloneOptions = { recursive: true, mode: constants.COPYFILE_FICLONE };

// Copy-on-write where supported, ordinary independent copies otherwise. Never use
// hard links: negative cases overwrite their files and must not change the base.
async function packageFixture(
	asarFiles = {},
	{ stagingFiles = {}, omitAsarFiles = [], omitBuildOutputs = [], realAssets = false } = {},
) {
	if (!fixtureBases.has(realAssets)) {
		const firstDirectory = temporaryDirectories.length;
		const base = await buildPackageFixture(realAssets);
		baseDirectories.push(...temporaryDirectories.splice(firstDirectory));
		await verifyPackagedDistribution({
			root: REPO_ROOT,
			packageDir: base.packageRoot,
			platform: "darwin",
			arch: "arm64",
		});
		fixtureBases.set(realAssets, base);
	}
	const base = fixtureBases.get(realAssets);
	const packageRoot = await temporaryDirectory("klippt-package-policy-");
	await cp(base.packageRoot, packageRoot, cloneOptions);
	const buildOutputs = new Map(base.buildOutputs);
	buildOutputsByPackage.set(packageRoot, buildOutputs);
	if (
		Object.keys(asarFiles).length ||
		Object.keys(stagingFiles).length ||
		omitAsarFiles.length ||
		omitBuildOutputs.length
	) {
		const appSource = await temporaryDirectory("klippt-package-policy-asar-");
		await cp(base.appSource, appSource, cloneOptions);
		if (Object.keys(stagingFiles).length || omitBuildOutputs.length) {
			for (const [namespace, directory] of base.buildOutputs) {
				const reviewed = await temporaryDirectory("klippt-package-policy-reviewed-");
				await cp(directory, reviewed, cloneOptions);
				buildOutputs.set(namespace, reviewed);
			}
			for (const [relativePath, contents] of Object.entries(stagingFiles)) {
				const [namespace, ...parts] = relativePath.split("/");
				const reviewed = path.join(buildOutputs.get(namespace), ...parts);
				await mkdir(path.dirname(reviewed), { recursive: true });
				await writeFile(reviewed, contents);
			}
			for (const relativePath of omitBuildOutputs) {
				const [namespace, ...parts] = relativePath.split("/");
				await rm(path.join(buildOutputs.get(namespace), ...parts), {
					recursive: true,
					force: true,
				});
			}
		}
		for (const [relativePath, contents] of Object.entries({ ...stagingFiles, ...asarFiles })) {
			const destination = path.join(appSource, relativePath);
			await mkdir(path.dirname(destination), { recursive: true });
			await writeFile(destination, contents);
		}
		for (const relativePath of [...omitAsarFiles, ...omitBuildOutputs]) {
			await rm(path.join(appSource, relativePath), { recursive: true, force: true });
		}
		await createPackage(appSource, path.join(packageRoot, "Contents", "Resources", "app.asar"));
	}
	return packageRoot;
}

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

async function buildPackageFixture(realAssets) {
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
	await writeFile(
		path.join(appSource, "dist", "assets", "locale-fixture1.json"),
		'{"locale":"en"}\n',
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
	const assetPolicy = JSON.parse(
		await readFile(path.join(REPO_ROOT, "supply-chain", "bundled-assets.json"), "utf8"),
	);
	for (const group of assetPolicy.included) {
		for (const sourcePattern of group.paths) {
			if (!sourcePattern.endsWith(".woff2")) continue;
			for (const source of globSync(sourcePattern, { cwd: REPO_ROOT })) {
				const basename = path.basename(source, ".woff2");
				await copyFile(
					path.join(REPO_ROOT, source),
					path.join(appSource, "dist", "assets", `${basename}-fixture1.woff2`),
				);
			}
		}
	}
	// One real reviewed thumbnail is sufficient for focused negative policy cases.
	// The real-assets integration case retains the complete wallpaper tree.
	for (const destination of [
		path.join(appSource, "dist", "wallpapers"),
		path.join(resources, "wallpapers"),
	]) {
		if (realAssets) {
			await cp(path.join(REPO_ROOT, "public", "wallpapers"), destination, cloneOptions);
		} else {
			await mkdir(path.join(destination, "thumbs"), { recursive: true });
			await copyFile(
				path.join(REPO_ROOT, "public", "wallpapers", "thumbs", "wallpaper1.jpg"),
				path.join(destination, "thumbs", "wallpaper1.jpg"),
			);
		}
	}
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
		"dist/wallpapers",
	]) {
		await rm(path.join(appSource, relativePath), { recursive: true, force: true });
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
	return { packageRoot, appSource, buildOutputs: buildOutputsByPackage.get(packageRoot) };
}

afterAll(async () => {
	await Promise.all(
		baseDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

afterEach(async () => {
	buildOutputsByPackage.clear();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("packaged distribution policy", { timeout: 30_000 }, () => {
	it("isolates changed resources from other variants and the validated base", async () => {
		const changed = await packageFixture();
		await writeFile(
			path.join(changed, "Contents", "Resources", "LICENSES.chromium.html"),
			"changed",
		);
		const untouched = await packageFixture();
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir: untouched,
				platform: "darwin",
				arch: "arm64",
			}),
		).resolves.toMatchObject({ webAssemblyFiles: 1 });
	});

	it("accepts the root resources layout used by Linux packages", async () => {
		const packageDir = await packageFixture();
		await rename(
			path.join(packageDir, "Contents", "Resources"),
			path.join(packageDir, "resources"),
		);
		await expect(
			verifyPackagedDistribution({ root: REPO_ROOT, packageDir, platform: "linux", arch: "x64" }),
		).resolves.toMatchObject({ webAssemblyFiles: 1, modelFiles: 0 });
	});

	it.each([
		"x64",
		"arm64",
	])("accepts the Linux %s filter library from the pinned SDK", async (arch) => {
		const packageDir = await packageFixture();
		const resources = path.join(packageDir, "resources");
		await rename(path.join(packageDir, "Contents", "Resources"), resources);
		const nativeDirectory = path.join(resources, "electron", "native", "bin", `linux-${arch}`);
		await mkdir(nativeDirectory, { recursive: true });
		await writeFile(path.join(nativeDirectory, "libavfilter.so.11"), "binary", { mode: 0o755 });
		await expect(
			verifyPackagedDistribution({ root: REPO_ROOT, packageDir, platform: "linux", arch }),
		).resolves.toMatchObject({ webAssemblyFiles: 1, modelFiles: 0 });
	});

	it.each([
		"x64",
		"arm64",
	])("accepts the Linux %s ffprobe pinned from the FFmpeg build", async (arch) => {
		const packageDir = await packageFixture();
		const resources = path.join(packageDir, "resources");
		await rename(path.join(packageDir, "Contents", "Resources"), resources);
		const nativeDirectory = path.join(resources, "electron", "native", "bin", `linux-${arch}`);
		await mkdir(nativeDirectory, { recursive: true });
		await writeFile(path.join(nativeDirectory, "ffprobe"), PINNED_PROBE, { mode: 0o755 });
		await expect(
			verifyPackagedDistribution({ root: REPO_ROOT, packageDir, platform: "linux", arch }),
		).resolves.toMatchObject({ webAssemblyFiles: 1, modelFiles: 0 });
	});

	it.each([
		"x64",
		"arm64",
	])("rejects a Linux %s ffprobe that is not the pinned build", async (arch) => {
		const packageDir = await packageFixture();
		const resources = path.join(packageDir, "resources");
		await rename(path.join(packageDir, "Contents", "Resources"), resources);
		const nativeDirectory = path.join(resources, "electron", "native", "bin", `linux-${arch}`);
		await mkdir(nativeDirectory, { recursive: true });
		await writeFile(path.join(nativeDirectory, "ffprobe"), "system ffprobe", { mode: 0o755 });
		await expect(
			verifyPackagedDistribution({ root: REPO_ROOT, packageDir, platform: "linux", arch }),
		).rejects.toThrow("Packaged ffprobe differs from the pinned FFmpeg build");
	});

	it.each([
		"package-type",
		"apparmor-profile",
	])("validates generated Linux %s content", async (fileName) => {
		const packageDir = await packageFixture();
		const resources = path.join(packageDir, "resources");
		await rename(path.join(packageDir, "Contents", "Resources"), resources);
		const template = await readFile(
			path.join(
				REPO_ROOT,
				"node_modules",
				"app-builder-lib",
				"templates",
				"linux",
				"apparmor-profile.tpl",
			),
			"utf8",
		);
		const profile = template
			.replaceAll("${executable}", "klippt")
			.replaceAll("${sanitizedProductName}", "Klippt");
		await writeFile(path.join(resources, "package-type"), "deb");
		await writeFile(path.join(resources, "apparmor-profile"), profile);
		const options = { root: REPO_ROOT, packageDir, platform: "linux", arch: "x64" };
		await expect(verifyPackagedDistribution(options)).resolves.toMatchObject({
			webAssemblyFiles: 1,
		});
		await writeFile(path.join(resources, fileName), "unreviewed generated content");
		await expect(verifyPackagedDistribution(options)).rejects.toThrow(
			/Invalid generated Linux resource/,
		);
	});

	it.each([
		["linux", "Package-Type"],
		["linux", "AppArmor-Profile"],
		["darwin", "Package-Type"],
		["darwin", "AppArmor-Profile"],
	])("rejects unreviewed mixed-case %s metadata %s", async (platform, fileName) => {
		const packageDir = await packageFixture();
		await writeFile(path.join(packageDir, "Contents", "Resources", fileName), "unreviewed content");
		await expect(
			verifyPackagedDistribution({ root: REPO_ROOT, packageDir, platform, arch: "x64" }),
		).rejects.toThrow(/Invalid generated Linux resource/);
	});

	it("verifies branded icons in the extracted AppImage layout", async () => {
		const packageDir = await packageFixture();
		await rename(
			path.join(packageDir, "Contents", "Resources"),
			path.join(packageDir, "resources"),
		);
		for (const fileName of [".DirIcon", "klippt.png"]) {
			await copyFile(
				path.join(REPO_ROOT, "icons", "icons", "png", "1024x1024.png"),
				path.join(packageDir, fileName),
			);
		}
		for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
			const target = path.join(
				packageDir,
				"usr",
				"share",
				"icons",
				"hicolor",
				`${size}x${size}`,
				"apps",
				"klippt.png",
			);
			await mkdir(path.dirname(target), { recursive: true });
			await copyFile(path.join(REPO_ROOT, "icons", "icons", "png", `${size}x${size}.png`), target);
		}
		const options = { root: REPO_ROOT, packageDir, platform: "linux", arch: "x64" };
		await expect(verifyPackagedDistribution(options)).resolves.toMatchObject({
			webAssemblyFiles: 1,
		});
		await copyFile(
			path.join(REPO_ROOT, "icons", "icons", "png", "128x128.png"),
			path.join(packageDir, ".DirIcon"),
		);
		await expect(verifyPackagedDistribution(options)).rejects.toThrow(
			"Packaged klippt-brand asset differs from policy: .DirIcon",
		);
	});

	it("accepts reviewed locale JSON assets", async () => {
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

	it("keeps the host lookup path and normalizes Windows ASAR paths for policy", () => {
		expect(normalizeAsarEntryPath("\\dist\\assets\\image.data")).toEqual({
			lookupPath: "dist\\assets\\image.data",
			policyPath: "dist/assets/image.data",
		});
	});

	it("accepts one reviewed standalone WebAssembly file and the exact Electron notice", async () => {
		const packageDir = await packageFixture({}, { realAssets: true });
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

	it("keeps build analysis metadata out of the packaged app", async () => {
		const packageDir = await packageFixture(
			{},
			{
				stagingFiles: { "dist/.vite/manifest.json": "{}" },
				omitAsarFiles: ["dist/.vite/manifest.json"],
			},
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).resolves.toBeDefined();
	});

	it("rejects build analysis metadata if it leaks into the packaged app", async () => {
		const packageDir = await packageFixture({ "dist/.vite/manifest.json": "{}" });
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow();
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

	it("rejects changed bytes in a reviewed Google font", async () => {
		const output = "dist/assets/google-inter-latin-normal-400-a28b7e319024-fixture1.woff2";
		const packageDir = await packageFixture(
			{ [output]: "changed font" },
			{ stagingFiles: { [output]: "changed font" } },
		);
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/Packaged google-font-inter asset differs from policy/);
	});

	it("rejects a missing reviewed Google font", async () => {
		const output = "dist/assets/google-inter-latin-normal-400-a28b7e319024-fixture1.woff2";
		const packageDir = await packageFixture({}, { omitBuildOutputs: [output] });
		await expect(
			verifyPackagedDistribution({
				root: REPO_ROOT,
				packageDir,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(
			/Expected one packaged google-font-inter asset for src\/assets\/fonts\/google\/google-inter-latin-normal-400-a28b7e319024\.woff2/,
		);
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
