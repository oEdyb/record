import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractFile, getRawHeader, listPackage, statFile } from "@electron/asar";
import postcss from "postcss";
import ts from "typescript";
import { HELPER_MANIFEST_NAME, verifyHelperManifest } from "./helper-provenance.mjs";
import { loadWebDemuxerPolicy } from "./web-demuxer-source.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const MODEL_EXTENSIONS = new Set([
	".ckpt",
	".gguf",
	".mlmodel",
	".mlpackage",
	".onnx",
	".ort",
	".pt",
	".pth",
	".safetensors",
	".tflite",
]);
const LEGACY_ASSET = /^(?:demo\.gif|openscreen\.png|preview\d*\.png|vite\.svg)$/i;
const ASSET_EXTENSIONS = new Set([
	".gif",
	".icns",
	".ico",
	".jpeg",
	".jpg",
	".otf",
	".png",
	".svg",
	".tif",
	".tiff",
	".ttf",
	".webp",
	".woff",
	".woff2",
]);
const REVIEWED_ASAR_SCRIPTS = new Map([
	[
		"node_modules/@anthropic-ai/sdk/bin/cli",
		{ size: 1221, sha256: "622a4596e0f48c53dcc84ce83e6cb5b2be384ab847a778ee5ece70d5a95ad19c" },
	],
	[
		"node_modules/js-yaml/bin/js-yaml.js",
		{ size: 2658, sha256: "b3e6a451bd8bc5cba3a12851396d15fc109faf0a5a018d96b5535fe1fcfedb54" },
	],
	[
		"node_modules/loose-envify/cli.js",
		{ size: 356, sha256: "6c656109d637b5b3488d6c7ec911fb773b6f97e3ad44355aa0e143f56a596e89" },
	],
	[
		"node_modules/mustache/bin/mustache",
		{ size: 3468, sha256: "0c3c1272b26a5769d3c812a278eb56e03b58ef39c7ef4d559073ac9b6d188ed4" },
	],
	[
		"node_modules/semver/bin/semver.js",
		{ size: 4748, sha256: "82c28f9bc9e598d255edd507d1e9b157f37b8dac0f2da25a813b5e7121600be8" },
	],
]);
const DARWIN_FFMPEG = [
	"ffmpeg",
	"libavcodec.62.dylib",
	"libavdevice.62.dylib",
	"libavfilter.11.dylib",
	"libavformat.62.dylib",
	"libavutil.60.dylib",
	"libswresample.6.dylib",
	"libswscale.9.dylib",
];
const WINDOWS_FFMPEG = [
	"ffmpeg-shared.exe",
	"avcodec-62.dll",
	"avdevice-62.dll",
	"avfilter-11.dll",
	"avformat-62.dll",
	"avutil-60.dll",
	"swresample-6.dll",
	"swscale-9.dll",
];
const LINUX_FFMPEG_LIBRARIES = [
	"libavcodec.so.62",
	"libavformat.so.62",
	"libavutil.so.60",
	"libswresample.so.6",
	"libswscale.so.9",
];
const TARGET_NATIVE_COMPONENTS = {
	"darwin-arm64": {
		"compositor_view.node": "metal-compositor",
		"klippt-parakeet-stt": "parakeet-stt",
		"klippt-cursor-helper": "macos-cursor",
		"klippt-screencapturekit-helper": "screencapturekit",
		...Object.fromEntries(DARWIN_FFMPEG.map((file) => [file, "ffmpeg"])),
	},
	"darwin-x64": {
		"compositor_view.node": "metal-compositor",
		"klippt-cursor-helper": "macos-cursor",
		"klippt-screencapturekit-helper": "screencapturekit",
		...Object.fromEntries(DARWIN_FFMPEG.map((file) => [file, "ffmpeg"])),
	},
	"linux-arm64": {
		"compositor_view.node": "vulkan-compositor",
		ffmpeg: "ffmpeg",
		"openscreen-pipewire-helper": "pipewire-capture",
		...Object.fromEntries(LINUX_FFMPEG_LIBRARIES.map((file) => [file, "ffmpeg"])),
		...Object.fromEntries(
			LINUX_FFMPEG_LIBRARIES.map((file) => [`helper-ffmpeg/${file}`, "ffmpeg"]),
		),
	},
	"linux-x64": {
		"compositor_view.node": "vulkan-compositor",
		ffmpeg: "ffmpeg",
		"openscreen-pipewire-helper": "pipewire-capture",
		...Object.fromEntries(LINUX_FFMPEG_LIBRARIES.map((file) => [file, "ffmpeg"])),
		...Object.fromEntries(
			LINUX_FFMPEG_LIBRARIES.map((file) => [`helper-ffmpeg/${file}`, "ffmpeg"]),
		),
	},
	"win32-arm64": {
		"compositor_view.node": "d3d11-compositor",
		"cursor-sampler.exe": "windows-cursor",
		"vcomp140.dll": "msvc-openmp-runtime",
		"wgc-capture.exe": "windows-capture",
		...Object.fromEntries(WINDOWS_FFMPEG.map((file) => [file, "ffmpeg"])),
	},
	"win32-x64": {
		"compositor_view.node": "d3d11-compositor",
		"cursor-sampler.exe": "windows-cursor",
		"vcomp140.dll": "msvc-openmp-runtime",
		"wgc-capture.exe": "windows-capture",
		...Object.fromEntries(WINDOWS_FFMPEG.map((file) => [file, "ffmpeg"])),
	},
};

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function portable(relativePath) {
	return relativePath.replaceAll("\\", "/");
}

export function normalizeAsarEntryPath(entry) {
	const lookupPath = entry.replace(/^[/\\]+/, "");
	return { lookupPath, policyPath: portable(lookupPath) };
}

function isModelPath(relativePath) {
	const normalized = relativePath.toLowerCase();
	const extension = path.extname(normalized);
	return (
		MODEL_EXTENSIONS.has(extension) ||
		normalized.includes(".mlmodelc/") ||
		/(^|\/)models?\/.+\.bin$/.test(normalized) ||
		/(^|\/)(ggml|model|encoder|decoder)[^/]*\.bin$/.test(normalized)
	);
}

function isCleanVoicePath(relativePath) {
	return /(^|\/)(klippt-clean-voice|deepfilternet|deep-filter)/i.test(relativePath);
}

function isExcludedAssetPath(relativePath) {
	const normalized = relativePath.toLowerCase();
	const basename = path.basename(normalized);
	if (LEGACY_ASSET.test(basename)) return true;
	return normalized.includes("/cursors/") && !normalized.includes("/resources/cursors/default/");
}

function nativePath(relativePath) {
	const match = portable(relativePath).match(
		/(?:^|\/)resources\/electron\/native\/bin\/([^/]+)\/(.+)$/i,
	);
	return match ? { target: match[1], relativePath: match[2] } : undefined;
}

function isAssetPath(relativePath) {
	return ASSET_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function hasBytes(value, expected, offset = 0) {
	return value?.subarray(offset, offset + expected.length).equals(expected) ?? false;
}

function isAssetHeader(value) {
	if (!value?.length) return false;
	return (
		hasBytes(value, Buffer.from("89504e470d0a1a0a", "hex")) ||
		hasBytes(value, Buffer.from("ffd8ff", "hex")) ||
		hasBytes(value, Buffer.from("GIF87a")) ||
		hasBytes(value, Buffer.from("GIF89a")) ||
		hasBytes(value, Buffer.from("BM")) ||
		hasBytes(value, Buffer.from("49492a00", "hex")) ||
		hasBytes(value, Buffer.from("4d4d002a", "hex")) ||
		(hasBytes(value, Buffer.from("RIFF")) && hasBytes(value, Buffer.from("WEBP"), 8)) ||
		hasBytes(value, Buffer.from("icns")) ||
		hasBytes(value, Buffer.from("00000100", "hex")) ||
		hasBytes(value, Buffer.from("wOFF")) ||
		hasBytes(value, Buffer.from("wOF2")) ||
		hasBytes(value, Buffer.from("OTTO")) ||
		hasBytes(value, Buffer.from("00010000", "hex")) ||
		/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(value.toString("utf8"))
	);
}

function isOsExecutableHeader(value) {
	if (!value?.length) return false;
	return (
		hasBytes(value, Buffer.from("7f454c46", "hex")) ||
		hasBytes(value, Buffer.from("feedface", "hex")) ||
		hasBytes(value, Buffer.from("cefaedfe", "hex")) ||
		hasBytes(value, Buffer.from("feedfacf", "hex")) ||
		hasBytes(value, Buffer.from("cffaedfe", "hex")) ||
		hasBytes(value, Buffer.from("cafebabe", "hex")) ||
		hasBytes(value, Buffer.from("bebafeca", "hex")) ||
		hasBytes(value, Buffer.from("cafebabf", "hex")) ||
		hasBytes(value, Buffer.from("bfbafeca", "hex")) ||
		hasBytes(value, Buffer.from("MZ")) ||
		hasBytes(value, Buffer.from("#!"))
	);
}

function isBinaryDataHeader(value) {
	return value?.includes(0) ?? false;
}

function isScriptHeader(value) {
	return hasBytes(value, Buffer.from("#!"));
}

function isWebAssemblyHeader(value) {
	return hasBytes(value, Buffer.from("0061736d", "hex"));
}

async function fileHeader(filePath, maximumBytes = 512) {
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(maximumBytes);
		const { bytesRead } = await handle.read(buffer, 0, maximumBytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function physicalFiles(root, current = root) {
	const files = [];
	const realRoot = await realpath(root);
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const filePath = path.join(current, entry.name);
		const fileInfo = await lstat(filePath);
		if (fileInfo.isSymbolicLink()) {
			const resolved = await realpath(filePath);
			if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
				throw new Error(
					`Packaged symlink escapes its package: ${portable(path.relative(root, filePath))}`,
				);
			}
			const resolvedInfo = await stat(resolved);
			if (resolvedInfo.isFile()) files.push({ filePath, resolved });
			continue;
		}
		if (fileInfo.isDirectory()) files.push(...(await physicalFiles(root, filePath)));
		else if (fileInfo.isFile()) files.push({ filePath, resolved: filePath });
	}
	return files;
}

async function verifyRequiredResources({ root, physical, violations }) {
	const required = ["LICENSE", "THIRD-PARTY-INVENTORY.json", "THIRD-PARTY-NOTICES.md"];
	const licenseRoot = path.join(root, "third-party-licenses");
	for (const { filePath } of await physicalFiles(licenseRoot)) {
		required.push(portable(path.relative(root, filePath)));
	}
	for (const relativePath of required) {
		const suffix = `/resources/${relativePath}`.toLowerCase();
		const matches = physical.filter((entry) => `/${entry.path}`.toLowerCase().endsWith(suffix));
		if (matches.length !== 1) {
			violations.push(`Expected one packaged ${relativePath}, found ${matches.length}`);
			continue;
		}
		const [expected, actual] = await Promise.all([
			readFile(path.join(root, relativePath)),
			readFile(matches[0].resolved),
		]);
		if (expected.length !== actual.length || sha256(expected) !== sha256(actual)) {
			violations.push(`Packaged notice differs from its reviewed source: ${relativePath}`);
		}
	}
}

async function readAsarEntries(asarPath, packageRelativePath) {
	const entries = [];
	const { headerSize } = getRawHeader(asarPath);
	const archive = await open(asarPath, "r");
	try {
		for (const entry of listPackage(asarPath, { isPack: false })) {
			const { lookupPath, policyPath: archivePath } = normalizeAsarEntryPath(entry);
			if (!archivePath) continue;
			const metadata = statFile(asarPath, lookupPath);
			if ("files" in metadata) continue;
			if (!("size" in metadata)) {
				throw new Error(`Unsupported ASAR entry type: ${archivePath}`);
			}
			const maximumBytes = Math.min(512, metadata.size);
			let header = Buffer.alloc(0);
			if (maximumBytes > 0 && metadata.unpacked) {
				const unpackedRoot = path.resolve(`${asarPath}.unpacked`);
				const unpackedPath = path.resolve(unpackedRoot, ...archivePath.split("/"));
				if (!unpackedPath.startsWith(`${unpackedRoot}${path.sep}`)) {
					throw new Error(`ASAR unpacked path escapes its package: ${archivePath}`);
				}
				header = await fileHeader(unpackedPath, maximumBytes);
			} else if (maximumBytes > 0) {
				const entryOffset = Number(metadata.offset);
				const position = 8 + headerSize + entryOffset;
				if (
					!Number.isSafeInteger(entryOffset) ||
					entryOffset < 0 ||
					!Number.isSafeInteger(position)
				) {
					throw new Error(`ASAR entry has an unsafe offset: ${archivePath}`);
				}
				const buffer = Buffer.alloc(maximumBytes);
				const { bytesRead } = await archive.read(buffer, 0, maximumBytes, position);
				if (bytesRead !== maximumBytes) {
					throw new Error(`Could not read the complete ASAR header for ${archivePath}`);
				}
				header = buffer;
			}
			const displayPath = `${packageRelativePath}!/${archivePath}`;
			const risky =
				archivePath.startsWith("dist/") ||
				archivePath.startsWith("dist-electron/") ||
				path.extname(archivePath).toLowerCase() === ".wasm" ||
				isModelPath(archivePath) ||
				isCleanVoicePath(archivePath) ||
				isAssetPath(archivePath) ||
				isScriptHeader(header);
			entries.push({
				archivePath,
				path: displayPath,
				contents: risky ? extractFile(asarPath, lookupPath) : null,
				header,
			});
		}
	} finally {
		await archive.close();
	}
	return entries;
}

function entryPolicyPath(entry) {
	return entry.archivePath ?? entry.path;
}

function resourceKey(entry) {
	if (entry.archivePath !== undefined) return `asar:${entry.archivePath}`;
	const normalized = `/${portable(entry.path)}`;
	const marker = "/resources/";
	const index = normalized.toLowerCase().lastIndexOf(marker);
	return index === -1 ? undefined : `physical:${normalized.slice(index + marker.length)}`;
}

async function exactAssetPolicy(root) {
	const exact = new Map();
	const add = async (key, sourcePath, component) => {
		const bytes = await readFile(path.join(root, sourcePath));
		exact.set(key, { component, size: bytes.length, sha256: sha256(bytes) });
	};
	await add("physical:icon.icns", "icons/icons/mac/icon.icns", "klippt-brand");
	await add("physical:icon.ico", "icons/icons/win/icon.ico", "klippt-brand");
	for (const fileName of [
		"klippt-tray.png",
		"klippt-trayTemplate.png",
		"klippt-trayTemplate@2x.png",
		"rec-button.png",
	]) {
		await add(`asar:dist/${fileName}`, `public/${fileName}`, "reviewed-ui-asset");
	}
	for (const directory of ["cursors/default", "wallpapers"]) {
		for (const { filePath } of await physicalFiles(path.join(root, "public", directory))) {
			const relative = portable(path.relative(path.join(root, "public"), filePath));
			await add(`physical:${relative}`, `public/${relative}`, "reviewed-ui-asset");
			if (directory === "wallpapers") {
				await add(`asar:dist/${relative}`, `public/${relative}`, "reviewed-ui-asset");
			}
		}
	}
	return exact;
}

function resourceRelativePath(displayPath) {
	const normalized = portable(displayPath);
	for (const prefix of ["Contents/Resources/", "resources/"]) {
		if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
			return normalized.slice(prefix.length);
		}
	}
	return undefined;
}

async function reviewedPhysicalResourcePaths(root, exactAssets) {
	const paths = new Set(
		[
			"LICENSE",
			"LICENSES.chromium.html",
			"THIRD-PARTY-INVENTORY.json",
			"THIRD-PARTY-NOTICES.md",
			"app-update.yml",
			"app.asar",
			"web-demuxer.wasm",
		].map((value) => value.toLowerCase()),
	);
	for (const key of exactAssets.keys()) {
		if (key.startsWith("physical:")) paths.add(key.slice("physical:".length).toLowerCase());
	}
	for (const { filePath } of await physicalFiles(path.join(root, "third-party-licenses"))) {
		paths.add(
			`third-party-licenses/${portable(path.relative(path.join(root, "third-party-licenses"), filePath))}`.toLowerCase(),
		);
	}
	return paths;
}

async function verifyPhysicalResourceBoundary({ root, exactAssets, physical, violations }) {
	const reviewed = await reviewedPhysicalResourcePaths(root, exactAssets);
	for (const entry of physical) {
		const relativePath = resourceRelativePath(entry.path);
		if (!relativePath || nativePath(entry.path)) continue;
		if (!reviewed.has(relativePath.toLowerCase())) {
			violations.push(`Unmapped packaged resource: ${entry.path}`);
		}
		if (isOsExecutableHeader(entry.header)) {
			violations.push(`Unmapped packaged executable: ${entry.path}`);
		}
	}
}

function verifyArchivedExecutables({ entries, violations }) {
	for (const entry of entries.filter((item) => isOsExecutableHeader(item.header))) {
		const policy = REVIEWED_ASAR_SCRIPTS.get(entry.archivePath);
		if (!isScriptHeader(entry.header) || !policy) {
			violations.push(`Unmapped packaged executable: ${entry.path}`);
			continue;
		}
		if (
			!entry.contents ||
			entry.contents.length !== policy.size ||
			sha256(entry.contents) !== policy.sha256
		) {
			violations.push(`Packaged executable script differs from policy: ${entry.path}`);
		}
	}
}

async function buildOutputPolicy(root, buildOutputRoots) {
	const assetPolicy = JSON.parse(
		await readFile(path.join(root, "supply-chain", "bundled-assets.json"), "utf8"),
	);
	const buildRules = assetPolicy.applicationBuild;
	if (
		assetPolicy.schemaVersion !== 1 ||
		!Array.isArray(buildRules?.requiredEntrypoints) ||
		!Array.isArray(buildRules?.compiledOutputPatterns) ||
		!Array.isArray(buildRules?.excludedOutputs)
	) {
		throw new Error("Bundled-asset policy has no valid application-build contract");
	}
	const compilePatterns = (values, label) =>
		values.map((value) => {
			if (typeof value !== "string" || !value.startsWith("^") || !value.endsWith("$")) {
				throw new Error(`${label} patterns must be anchored regular expressions`);
			}
			return new RegExp(value);
		});
	const compiledOutputs = compilePatterns(buildRules.compiledOutputPatterns, "Compiled output");
	const reviewedAssets = compilePatterns(
		(assetPolicy.included ?? []).flatMap((group) => group.packagedOutputPatterns ?? []),
		"Reviewed asset output",
	);
	const excludedOutputs = buildRules.excludedOutputs.map((rule) => ({
		...rule,
		matcher: compilePatterns([rule.pattern], "Excluded output")[0],
	}));
	const builderConfig = await readFile(path.join(root, "electron-builder.json5"), "utf8");
	for (const rule of excludedOutputs) {
		if (
			typeof rule.builderPattern !== "string" ||
			!builderConfig.includes(JSON.stringify(rule.builderPattern))
		) {
			throw new Error(`Electron Builder does not enforce output exclusion: ${rule.pattern}`);
		}
	}
	const roots =
		buildOutputRoots ??
		new Map([
			["dist", path.join(root, "dist")],
			["dist-electron", path.join(root, "dist-electron")],
		]);
	const policy = new Map();
	for (const [namespace, directory] of roots) {
		for (const { filePath, resolved } of await physicalFiles(directory)) {
			const relativePath = portable(path.relative(directory, filePath));
			const outputPath = `${namespace}/${relativePath}`;
			if (excludedOutputs.some((rule) => rule.matcher.test(outputPath))) continue;
			const isCompiled = compiledOutputs.some((pattern) => pattern.test(outputPath));
			const isReviewedAsset = reviewedAssets.some((pattern) => pattern.test(outputPath));
			if (!isCompiled && !isReviewedAsset) {
				throw new Error(`Unapproved application build output: ${outputPath}`);
			}
			const contents = await readFile(resolved);
			if (isCompiled && /\.(?:js|mjs)$/.test(outputPath)) {
				const source = ts.createSourceFile(
					outputPath,
					contents.toString("utf8"),
					ts.ScriptTarget.Latest,
					false,
					ts.ScriptKind.JS,
				);
				if (source.parseDiagnostics.length) {
					throw new Error(`Compiled JavaScript is not syntactically valid: ${outputPath}`);
				}
			}
			if (isCompiled && outputPath.endsWith(".css")) {
				try {
					postcss.parse(contents.toString("utf8"), { from: outputPath });
				} catch {
					throw new Error(`Compiled CSS is not syntactically valid: ${outputPath}`);
				}
			}
			policy.set(outputPath, {
				size: contents.length,
				sha256: sha256(contents),
			});
		}
	}
	for (const entrypoint of buildRules.requiredEntrypoints) {
		if (!policy.has(entrypoint)) {
			throw new Error(`Required application build output is missing: ${entrypoint}`);
		}
	}
	return policy;
}

function verifyAsarBuildOutputs({ entries, policy, violations }) {
	const found = new Set();
	for (const entry of entries) {
		const { archivePath } = entry;
		if (!archivePath.startsWith("dist/") && !archivePath.startsWith("dist-electron/")) continue;
		const expected = policy.get(archivePath);
		if (!expected) {
			violations.push(`Unmapped packaged application resource: ${entry.path}`);
			continue;
		}
		found.add(archivePath);
		if (
			!entry.contents ||
			entry.contents.length !== expected.size ||
			sha256(entry.contents) !== expected.sha256
		) {
			violations.push(`Packaged application output differs from its build: ${entry.path}`);
		}
	}
	for (const archivePath of policy.keys()) {
		if (!found.has(archivePath)) {
			violations.push(`Built application output is missing from ASAR: ${archivePath}`);
		}
	}
}

async function verifyReviewedAssets({ root, exact, entries, violations }) {
	const fontPolicies = [
		{
			pattern: /^asar:dist\/assets\/Geist-Variable-[^/]+\.woff2$/,
			source: "src/assets/fonts/Geist-Variable.woff2",
			component: "geist-fonts",
			count: 0,
		},
		{
			pattern: /^asar:dist\/assets\/GeistMono-Variable-[^/]+\.woff2$/,
			source: "src/assets/fonts/GeistMono-Variable.woff2",
			component: "geist-fonts",
			count: 0,
		},
	];
	for (const policy of fontPolicies) {
		const bytes = await readFile(path.join(root, policy.source));
		policy.size = bytes.length;
		policy.sha256 = sha256(bytes);
	}
	for (const entry of entries.filter(
		(item) =>
			isAssetPath(entryPolicyPath(item)) ||
			isAssetHeader(item.header ?? item.contents) ||
			(item.archivePath !== undefined && isBinaryDataHeader(item.header)),
	)) {
		const key = resourceKey(entry);
		let policy = key && exact.get(key);
		if (!policy && key) {
			const fontPolicy = fontPolicies.find((candidate) => candidate.pattern.test(key));
			if (fontPolicy) {
				fontPolicy.count += 1;
				policy = fontPolicy;
			}
		}
		if (!policy) {
			const category =
				entry.archivePath !== undefined &&
				isBinaryDataHeader(entry.header) &&
				!isAssetPath(entryPolicyPath(entry)) &&
				!isAssetHeader(entry.header)
					? "binary resource"
					: "visual or font asset";
			violations.push(`Unmapped packaged ${category}: ${entry.path}`);
			continue;
		}
		const contents = entry.contents ?? (await readFile(entry.resolved));
		if (contents.length !== policy.size || sha256(contents) !== policy.sha256) {
			violations.push(`Packaged ${policy.component} asset differs from policy: ${entry.path}`);
		}
	}
	for (const policy of fontPolicies) {
		if (policy.count !== 1) {
			violations.push(`Expected one packaged ${policy.component} asset for ${policy.source}`);
		}
	}
}

async function verifyNativeResources({ physical, target, sourceSha, violations }) {
	const targetPolicy = TARGET_NATIVE_COMPONENTS[target];
	if (!targetPolicy) {
		violations.push(`No native component policy exists for ${target}`);
		return;
	}
	const nativeEntries = physical
		.map((entry) => ({ entry, native: nativePath(entry.path) }))
		.filter(({ native }) => native);
	const expectedEntries = nativeEntries.filter(({ native }) => native.target === target);
	const unexpectedTargets = nativeEntries.filter(({ native }) => native.target !== target);
	for (const { entry, native } of unexpectedTargets) {
		violations.push(
			`Packaged native file targets ${native.target}, expected ${target}: ${entry.path}`,
		);
	}

	const manifestEntry = expectedEntries.find(
		({ native }) => native.relativePath === HELPER_MANIFEST_NAME,
	);
	const helperPaths = new Set();
	if (manifestEntry) {
		helperPaths.add(HELPER_MANIFEST_NAME);
		try {
			const manifest = await verifyHelperManifest({
				directory: path.dirname(manifestEntry.entry.resolved),
				expectedSourceSha: sourceSha,
				expectedTarget: target,
				allowAdditionalFiles: true,
			});
			for (const file of manifest.files) helperPaths.add(file.path);
		} catch (error) {
			violations.push(`Invalid packaged helper provenance: ${error.message}`);
		}
	}
	const hasWhisper = expectedEntries.some(({ native }) =>
		/^whisper-stt-server(?:-cuda)?(?:\.exe)?$/.test(path.basename(native.relativePath)),
	);
	if (hasWhisper && !manifestEntry) {
		violations.push("Packaged Whisper helper has no provenance manifest");
	}
	for (const { entry, native } of expectedEntries) {
		const component = targetPolicy[native.relativePath];
		if (!component && !helperPaths.has(native.relativePath)) {
			violations.push(`Unmapped packaged native file: ${entry.path}`);
		}
	}
}

export async function verifyPackagedDistribution({
	root = DEFAULT_ROOT,
	packageDir,
	platform,
	arch,
	sourceSha,
	buildOutputRoots,
} = {}) {
	if (!packageDir) throw new Error("A packaged application directory is required");
	if (!platform || !arch)
		throw new Error("Package verification requires platform and architecture");
	const policy = loadWebDemuxerPolicy(path.join(root, "supply-chain", "web-demuxer.json"));
	const files = await physicalFiles(packageDir);
	const physical = await Promise.all(
		files.map(async ({ filePath, resolved }) => ({
			path: portable(path.relative(packageDir, filePath)),
			resolved,
			contents: null,
			header: await fileHeader(resolved),
		})),
	);
	const archivedEntries = [];
	for (const file of physical.filter((entry) => path.basename(entry.path) === "app.asar")) {
		archivedEntries.push(...(await readAsarEntries(file.resolved, file.path)));
	}
	const entries = [...physical, ...archivedEntries];
	const violations = [];
	const exactAssets = await exactAssetPolicy(root);
	const builtOutputs = await buildOutputPolicy(root, buildOutputRoots);

	for (const entry of entries) {
		if (isCleanVoicePath(entryPolicyPath(entry))) {
			violations.push(`Clean Voice is excluded from paid packages: ${entry.path}`);
		}
	}

	const modelFiles = entries.filter((entry) => isModelPath(entryPolicyPath(entry)));
	for (const entry of modelFiles) {
		violations.push(`Unapproved packaged model: ${entry.path}`);
	}

	for (const entry of entries.filter((item) => isExcludedAssetPath(entryPolicyPath(item)))) {
		violations.push(`Excluded or unreviewed packaged asset: ${entry.path}`);
	}

	const expectedTarget = `${platform}-${arch}`;
	await verifyNativeResources({
		physical,
		target: expectedTarget,
		sourceSha,
		violations,
	});
	await verifyPhysicalResourceBoundary({ root, exactAssets, physical, violations });
	verifyArchivedExecutables({ entries: archivedEntries, violations });
	verifyAsarBuildOutputs({ entries: archivedEntries, policy: builtOutputs, violations });
	await verifyReviewedAssets({ root, exact: exactAssets, entries, violations });

	const webAssembly = entries.filter(
		(entry) =>
			path.extname(entryPolicyPath(entry)).toLowerCase() === ".wasm" ||
			isWebAssemblyHeader(entry.header),
	);
	const approvedWebAssembly = webAssembly.filter(
		(entry) =>
			entry.archivePath === undefined &&
			entry.path.toLowerCase().endsWith("/resources/web-demuxer.wasm"),
	);
	for (const entry of webAssembly.filter((item) => !approvedWebAssembly.includes(item))) {
		violations.push(`Unapproved packaged WebAssembly: ${entry.path}`);
	}
	if (approvedWebAssembly.length !== 1) {
		violations.push(
			`Expected one standalone approved web-demuxer.wasm, found ${approvedWebAssembly.length}`,
		);
	} else {
		const contents = await readFile(approvedWebAssembly[0].resolved);
		if (contents.length !== policy.binary.size || sha256(contents) !== policy.binary.sha256) {
			violations.push("Approved packaged web-demuxer.wasm does not match its source policy");
		}
	}

	const chromiumNotices = physical.filter((entry) =>
		entry.path.toLowerCase().endsWith("/resources/licenses.chromium.html"),
	);
	const expectedChromiumNotice = await readFile(
		path.join(root, "node_modules", "electron", "dist", "LICENSES.chromium.html"),
	);
	if (chromiumNotices.length !== 1) {
		violations.push(`Expected one Electron Chromium notice, found ${chromiumNotices.length}`);
	} else {
		const actual = await readFile(chromiumNotices[0].resolved);
		if (
			actual.length !== expectedChromiumNotice.length ||
			sha256(actual) !== sha256(expectedChromiumNotice)
		) {
			violations.push("Electron Chromium notice does not match the packaged Electron runtime");
		}
	}

	await verifyRequiredResources({ root, physical, violations });

	if (violations.length) throw new Error(violations.join("\n"));
	return {
		target: `${platform}-${arch}`,
		webAssemblyFiles: webAssembly.length,
		modelFiles: modelFiles.length,
	};
}

function parseArguments(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		index += 1;
		if (flag === "--package-dir") options.packageDir = path.resolve(value);
		else if (flag === "--platform") options.platform = value;
		else if (flag === "--arch") options.arch = value;
		else if (flag === "--source-sha") options.sourceSha = value;
		else throw new Error(`Unknown option: ${flag}`);
	}
	return options;
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const result = await verifyPackagedDistribution(parseArguments(process.argv.slice(2)));
	console.log(
		`Packaged distribution approved for ${result.target}: ${result.webAssemblyFiles} WebAssembly, ${result.modelFiles} models`,
	);
}
