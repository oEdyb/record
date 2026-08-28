import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Version } from "@cyclonedx/cyclonedx-library/Spec";
import { JsonStrictValidator } from "@cyclonedx/cyclonedx-library/Validation";
import ts from "typescript";
import { verifyApprovedDependencies } from "./check-approved-dependencies.mjs";
import { loadCargoGraphs } from "./check-cargo-graphs.mjs";
import {
	FFMPEG_ARCHIVES,
	FFMPEG_MAC_SOURCE,
	FFMPEG_RELEASE_TAG,
	FFMPEG_SHARED_ARCHIVES,
} from "./ffmpeg-pins.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const INVENTORY_FILE = "klippt-release-inventory.json";
const SBOM_FILE = "klippt-release-sbom.cdx.json";
const SHA256_RE = /^[0-9a-f]{64}$/i;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
	const hash = createHash("sha256");
	await new Promise((resolve, reject) => {
		const stream = fs.createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return hash.digest("hex");
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function npmNameFromLockPath(lockPath) {
	return lockPath.split("node_modules/").at(-1);
}

function npmPurl(name, version) {
	if (name.startsWith("@")) {
		const [scope, packageName] = name.split("/");
		return `pkg:npm/%40${encodeURIComponent(scope.slice(1))}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
	}
	return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

const PACKAGED_DEVELOPMENT_DEPENDENCIES = new Set(["electron"]);

function integrityHash(integrity) {
	if (typeof integrity !== "string") return undefined;
	const match = integrity.match(/^(sha(?:256|384|512))-([A-Za-z0-9+/=]+)$/i);
	if (!match) return undefined;
	return {
		algorithm: match[1].toUpperCase().replace("SHA", "SHA-"),
		value: Buffer.from(match[2], "base64").toString("hex"),
	};
}

export function readNpmComponents(root) {
	const lock = readJson(path.join(root, "package-lock.json"));
	const components = [];
	for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
		if (!lockPath || !lockPath.includes("node_modules/")) continue;
		const name = entry.name ?? npmNameFromLockPath(lockPath);
		if (!name || !entry.version) continue;
		if (entry.dev === true && !PACKAGED_DEVELOPMENT_DEPENDENCIES.has(name)) continue;
		const hash = integrityHash(entry.integrity);
		components.push({
			id: `npm:${name}@${entry.version}`,
			ecosystem: "npm",
			kind: "library",
			name,
			version: entry.version,
			scope: "required",
			purl: npmPurl(name, entry.version),
			license: typeof entry.license === "string" ? entry.license : undefined,
			source: entry.resolved,
			hash,
			role: name === "electron" ? "packaged-runtime" : undefined,
		});
	}
	return components;
}

const CARGO_STRING_PATTERNS = {
	name: /^\s*name = ("(?:[^"\\]|\\.)*")/m,
	version: /^\s*version = ("(?:[^"\\]|\\.)*")/m,
	source: /^\s*source = ("(?:[^"\\]|\\.)*")/m,
	checksum: /^\s*checksum = ("(?:[^"\\]|\\.)*")/m,
};

function cargoString(block, key) {
	const match = block.match(CARGO_STRING_PATTERNS[key]);
	return match ? JSON.parse(match[1]) : undefined;
}

export function readCargoComponents(root) {
	const components = [];
	for (const graph of loadCargoGraphs(root)) {
		const relativeLock = graph.lockfile;
		const lock = fs.readFileSync(path.join(root, relativeLock), "utf8");
		for (const block of lock.split("[[package]]").slice(1)) {
			const name = cargoString(block, "name");
			const version = cargoString(block, "version");
			if (!name || !version) continue;
			const source = cargoString(block, "source") ?? "workspace";
			const checksum = cargoString(block, "checksum");
			components.push({
				id: `cargo:${relativeLock}:${name}@${version}:${source}`,
				ecosystem: "cargo",
				kind: "library",
				name,
				version,
				scope: graph.scope,
				purl: `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
				source,
				hash:
					checksum && SHA256_RE.test(checksum)
						? { algorithm: "SHA-256", value: checksum }
						: undefined,
				lockfile: relativeLock,
			});
		}
	}
	return components;
}

export function readSwiftComponents(root) {
	const relativeLock = "electron/native/parakeet-stt/Package.resolved";
	const resolved = readJson(path.join(root, relativeLock));
	return (resolved.pins ?? []).map((pin) => ({
		id: `swift:${pin.identity}@${pin.state?.revision ?? pin.state?.version}`,
		ecosystem: "swift",
		kind: "library",
		name: pin.identity,
		version: pin.state?.version ?? pin.state?.revision,
		scope: "required",
		source: pin.location,
		revision: pin.state?.revision,
		lockfile: relativeLock,
	}));
}

async function loadSttModels(root) {
	const sourcePath = path.join(root, "electron/stt/modelManager.ts");
	const source = await readFile(sourcePath, "utf8");
	const javascript = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
		fileName: sourcePath,
	}).outputText;
	const module = await import(
		`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
	);
	if (!module.STT_MODELS || typeof module.STT_MODELS !== "object") {
		throw new Error("electron/stt/modelManager.ts no longer exports STT_MODELS");
	}
	return module.STT_MODELS;
}

function exactConstant(source, pattern, name) {
	const match = source.match(pattern);
	if (!match) throw new Error(`Could not read ${name} from its source`);
	return match[1].toLowerCase();
}

async function readModelComponents(root) {
	const models = await loadSttModels(root);
	const components = [];
	for (const [modelId, model] of Object.entries(models)) {
		for (const file of model.files ?? []) {
			if (!file.expectedSha256 || !SHA256_RE.test(file.expectedSha256)) {
				throw new Error(`${modelId}/${file.name} does not have a pinned SHA-256`);
			}
			const revision = new URL(file.url).pathname.match(/\/resolve\/([^/]+)\//)?.[1];
			if (!revision || !/^[0-9a-f]{40}$/i.test(revision)) {
				throw new Error(`${modelId}/${file.name} is not pinned to an immutable revision`);
			}
			components.push({
				id: `model:${modelId}:${file.name}@${revision}`,
				ecosystem: "model",
				kind: "machine-learning-model",
				name: `${modelId}/${file.name}`,
				version: revision,
				scope: "optional",
				source: file.url,
				hash: { algorithm: "SHA-256", value: file.expectedSha256.toLowerCase() },
				approximateBytes: file.approximateBytes,
			});
		}
	}

	const buildSource = await readFile(
		path.join(root, "scripts/build-clean-voice-helper.mjs"),
		"utf8",
	);
	const rustSource = await readFile(
		path.join(root, "electron/native/clean-voice/src/main.rs"),
		"utf8",
	);
	const buildHash = exactConstant(
		buildSource,
		/const\s+modelSha256(?:\s*:[^=]+)?\s*=\s*"([0-9a-f]{64})"/i,
		"modelSha256",
	);
	const rustHash = exactConstant(
		rustSource,
		/const\s+MODEL_SHA256(?:\s*:[^=]+)?\s*=\s*"([0-9a-f]{64})"/i,
		"MODEL_SHA256",
	);
	if (buildHash !== rustHash)
		throw new Error("Clean Voice model SHA-256 differs between build and worker sources");
	components.push({
		id: `model:deepfilternet3-onnx@${buildHash}`,
		ecosystem: "model",
		kind: "machine-learning-model",
		name: "DeepFilterNet3 ONNX embedded model",
		version: buildHash.slice(0, 12),
		scope: "excluded",
		source:
			"git+https://github.com/oEdyb/DeepFilterNet.git#b0fa238a331fb5cc39c5555d3538008dd88c0aef",
		hash: { algorithm: "SHA-256", value: buildHash },
	});
	return components;
}

function ffmpegComponents() {
	const components = [];
	for (const [target, pin] of Object.entries(FFMPEG_ARCHIVES)) {
		components.push({
			id: `ffmpeg:archive:${target}:${pin.asset}`,
			ecosystem: "ffmpeg",
			kind: "file",
			name: pin.asset,
			version: FFMPEG_RELEASE_TAG,
			scope: "optional",
			source: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE_TAG}/${pin.asset}`,
			hash: { algorithm: "SHA-256", value: pin.sha256 },
			target,
			role: "build-input",
		});
	}
	for (const [target, pin] of Object.entries(FFMPEG_SHARED_ARCHIVES)) {
		components.push({
			id: `ffmpeg:shared-archive:${target}:${pin.asset}`,
			ecosystem: "ffmpeg",
			kind: "file",
			name: pin.asset,
			version: FFMPEG_RELEASE_TAG,
			scope: "optional",
			source: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE_TAG}/${pin.asset}`,
			hash: { algorithm: "SHA-256", value: pin.sha256 },
			target,
			role: "build-input",
		});
	}
	components.push({
		id: `ffmpeg:source:macos@${FFMPEG_MAC_SOURCE.version}`,
		ecosystem: "ffmpeg",
		kind: "file",
		name: `ffmpeg-${FFMPEG_MAC_SOURCE.version}.tar.xz`,
		version: FFMPEG_MAC_SOURCE.version,
		scope: "optional",
		source: FFMPEG_MAC_SOURCE.urls[0],
		mirrors: FFMPEG_MAC_SOURCE.urls.slice(1),
		hash: { algorithm: "SHA-256", value: FFMPEG_MAC_SOURCE.sha256 },
		target: "darwin",
		role: "build-input",
		configureFlags: [...FFMPEG_MAC_SOURCE.configureFlags],
	});
	return components;
}

async function webAssemblyComponent(root, npmComponents) {
	const relativePath = "public/wasm/web-demuxer.wasm";
	const filePath = path.join(root, relativePath);
	const info = await stat(filePath);
	const packageComponent = npmComponents.find((item) => item.name === "web-demuxer");
	if (!packageComponent)
		throw new Error("web-demuxer is missing from the production npm lock graph");
	return {
		id: `wasm:web-demuxer@${packageComponent.version}`,
		ecosystem: "webassembly",
		kind: "file",
		name: "web-demuxer.wasm",
		version: packageComponent.version,
		scope: "required",
		path: relativePath,
		size: info.size,
		hash: { algorithm: "SHA-256", value: await sha256File(filePath) },
		source: packageComponent.source,
	};
}

function platformDirectory(platform, arch) {
	const normalizedArch = arch === "x64" ? "x64" : arch;
	return `${platform}-${normalizedArch}`;
}

function shouldShipNativeFile(platform, name) {
	if (platform === "darwin" && name === "klippt-clean-voice") return false;
	if (platform === "win32" && name.toLowerCase() === "ffmpeg.exe") return false;
	return true;
}

async function walkFiles(root, current = root) {
	const files = [];
	const realRoot = await realpath(root);
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const filePath = path.join(current, entry.name);
		const fileInfo = await lstat(filePath);
		if (fileInfo.isSymbolicLink()) {
			const resolvedTarget = await realpath(filePath);
			if (resolvedTarget !== realRoot && !resolvedTarget.startsWith(`${realRoot}${path.sep}`)) {
				throw new Error(`Packaged symlink escapes its target directory: ${filePath}`);
			}
			const targetInfo = await stat(resolvedTarget);
			// macOS framework bundles use directory aliases such as Versions/Current.
			// The physical target is walked at its real path, so following the alias would
			// duplicate every file and can create a cycle.
			if (targetInfo.isDirectory()) continue;
			if (!targetInfo.isFile()) {
				throw new Error(`Native staging symlink does not resolve to a file: ${filePath}`);
			}
			files.push({ filePath, symlinkTarget: await readlink(filePath), resolvedTarget });
		} else if (fileInfo.isDirectory()) files.push(...(await walkFiles(root, filePath)));
		else if (fileInfo.isFile()) files.push({ filePath, resolvedTarget: filePath });
	}
	return files;
}

async function packagedFileRole(filePath, info) {
	const handle = await open(filePath, "r");
	const prefix = Buffer.alloc(4);
	try {
		await handle.read(prefix, 0, prefix.length, 0);
	} finally {
		await handle.close();
	}
	const magic = prefix.toString("hex");
	const extension = path.extname(filePath).toLowerCase();
	if (magic === "0061736d" || extension === ".wasm") return "packaged-webassembly";
	if (
		magic.startsWith("7f454c46") ||
		magic.startsWith("4d5a") ||
		[
			"feedface",
			"cefaedfe",
			"feedfacf",
			"cffaedfe",
			"cafebabe",
			"bebafeca",
			"cafebabf",
			"bfbafeca",
		].includes(magic) ||
		[".exe", ".dll", ".node", ".dylib", ".so"].includes(extension) ||
		(info.mode & 0o111) !== 0
	) {
		return "packaged-executable";
	}
	const portablePath = filePath.split(path.sep).join("/").toLowerCase();
	if (
		[".onnx", ".ort", ".mlmodel", ".tflite", ".safetensors"].includes(extension) ||
		portablePath.includes(".mlmodelc/") ||
		portablePath.includes("/models/")
	) {
		return "packaged-model";
	}
	return "packaged-file";
}

async function packagedComponents({ packageDir, platform, arch, version }) {
	if (!packageDir) return [];
	if (!platform || !arch) throw new Error("--package-dir requires both --platform and --arch");
	const expected = platformDirectory(platform, arch);
	const files = await walkFiles(packageDir);
	const components = [];
	for (const { filePath, resolvedTarget, symlinkTarget } of files) {
		const relativePath = path.relative(packageDir, filePath).split(path.sep).join("/");
		const info = await stat(resolvedTarget);
		components.push({
			id: `package:${expected}:${relativePath}`,
			ecosystem: "package",
			kind: "file",
			name: relativePath,
			version,
			scope: "required",
			path: `package/${relativePath}`,
			size: info.size,
			hash: { algorithm: "SHA-256", value: await sha256File(resolvedTarget) },
			target: expected,
			role: await packagedFileRole(resolvedTarget, info),
			symlinkTarget,
		});
	}
	return components;
}

async function artifactComponents({ artifacts = [], root, platform, arch, version }) {
	if (!artifacts.length) return [];
	if (!platform || !arch) throw new Error("--artifact requires both --platform and --arch");
	const expected = platformDirectory(platform, arch);
	const components = [];
	for (const artifactPath of artifacts) {
		const info = await stat(artifactPath);
		if (!info.isFile()) throw new Error(`Release artifact is not a file: ${artifactPath}`);
		const relative = path.relative(root, artifactPath);
		const inventoryPath =
			relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
				? relative.split(path.sep).join("/")
				: path.basename(artifactPath);
		components.push({
			id: `artifact:${expected}:${inventoryPath}`,
			ecosystem: "distribution",
			kind: "file",
			name: path.basename(artifactPath),
			version,
			scope: "required",
			path: inventoryPath,
			size: info.size,
			hash: { algorithm: "SHA-256", value: await sha256File(artifactPath) },
			target: expected,
			role: "release-artifact",
		});
	}
	return components;
}

async function nativeComponents({ nativeDir, platform, arch, version }) {
	if (!nativeDir) return [];
	if (!platform || !arch) throw new Error("--native-dir requires both --platform and --arch");
	if (!["darwin", "linux", "win32"].includes(platform))
		throw new Error(`Unsupported platform: ${platform}`);
	if (!["arm64", "x64"].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);
	const expected = platformDirectory(platform, arch);
	const nested = path.join(nativeDir, expected);
	const stageRoot = fs.existsSync(nested) ? nested : nativeDir;
	const files = await walkFiles(stageRoot);
	const components = [];
	for (const { filePath, resolvedTarget, symlinkTarget } of files) {
		if (!shouldShipNativeFile(platform, path.basename(filePath))) continue;
		const relativePath = path.relative(stageRoot, filePath).split(path.sep).join("/");
		const info = await stat(resolvedTarget);
		components.push({
			id: `native:${expected}:${relativePath}`,
			ecosystem: "native",
			kind: "file",
			name: relativePath,
			version,
			scope: "required",
			path: `electron/native/bin/${expected}/${relativePath}`,
			size: info.size,
			hash: { algorithm: "SHA-256", value: await sha256File(resolvedTarget) },
			target: expected,
			role: "packaged-native-file",
			symlinkTarget,
		});
	}
	return components;
}

function uniqueComponents(components) {
	const byId = new Map();
	for (const component of components) {
		const previous = byId.get(component.id);
		if (previous && JSON.stringify(previous) !== JSON.stringify(component)) {
			throw new Error(`Conflicting release inventory component: ${component.id}`);
		}
		byId.set(component.id, component);
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function gitSha(root) {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function bomReference(component) {
	return `urn:klippt:${sha256(component.id)}`;
}

function externalReference(component) {
	if (typeof component.source !== "string") return undefined;
	if (/^https?:\/\//.test(component.source)) return { type: "distribution", url: component.source };
	if (component.source.startsWith("git+https://")) {
		return { type: "vcs", url: component.source.slice(4) };
	}
	return undefined;
}

function toCycloneDxComponent(component) {
	const properties = [
		{ name: "app.klippt:ecosystem", value: component.ecosystem },
		component.lockfile ? { name: "app.klippt:lockfile", value: component.lockfile } : undefined,
		component.path ? { name: "app.klippt:path", value: component.path } : undefined,
		component.revision ? { name: "app.klippt:revision", value: component.revision } : undefined,
		component.role ? { name: "app.klippt:role", value: component.role } : undefined,
		component.symlinkTarget
			? { name: "app.klippt:symlink-target", value: component.symlinkTarget }
			: undefined,
		component.target ? { name: "app.klippt:target", value: component.target } : undefined,
		component.license ? { name: "app.klippt:license-claim", value: component.license } : undefined,
	].filter(Boolean);
	const reference = externalReference(component);
	return {
		type: component.kind,
		"bom-ref": bomReference(component),
		name: component.name,
		version: component.version,
		scope: component.scope,
		...(component.purl ? { purl: component.purl } : {}),
		...(component.hash
			? { hashes: [{ alg: component.hash.algorithm, content: component.hash.value }] }
			: {}),
		...(reference ? { externalReferences: [reference] } : {}),
		...(properties.length ? { properties } : {}),
	};
}

export async function buildReleaseInventory({
	root = DEFAULT_ROOT,
	nativeDir,
	packageDir,
	artifacts = [],
	platform,
	arch,
	sourceSha,
} = {}) {
	verifyApprovedDependencies(root);
	const packageJson = readJson(path.join(root, "package.json"));
	const npm = readNpmComponents(root);
	const components = uniqueComponents([
		...npm,
		...readCargoComponents(root),
		...readSwiftComponents(root),
		...ffmpegComponents(),
		...(await readModelComponents(root)),
		await webAssemblyComponent(root, npm),
		...(await nativeComponents({ nativeDir, platform, arch, version: packageJson.version })),
		...(await packagedComponents({
			packageDir,
			platform,
			arch,
			version: packageJson.version,
		})),
		...(await artifactComponents({
			artifacts,
			root,
			platform,
			arch,
			version: packageJson.version,
		})),
	]);
	return {
		schemaVersion: 1,
		product: { name: packageJson.name, version: packageJson.version },
		source: { commit: sourceSha ?? process.env.KLIPPT_SOURCE_SHA ?? gitSha(root) },
		target: platform && arch ? { platform, arch } : null,
		components,
	};
}

export function buildCycloneDx(inventory) {
	return {
		bomFormat: "CycloneDX",
		specVersion: "1.7",
		version: 1,
		metadata: {
			component: {
				type: "application",
				"bom-ref": `urn:klippt:application:${inventory.product.name}@${inventory.product.version}`,
				name: inventory.product.name,
				version: inventory.product.version,
				properties: [
					{ name: "app.klippt:source-commit", value: inventory.source.commit },
					...(inventory.target
						? [
								{
									name: "app.klippt:target",
									value: `${inventory.target.platform}-${inventory.target.arch}`,
								},
							]
						: []),
				],
			},
		},
		components: inventory.components.map(toCycloneDxComponent),
	};
}

export async function validateCycloneDx(sbom) {
	const result = await new JsonStrictValidator(Version.v1dot7).validate(JSON.stringify(sbom));
	if (result) throw new Error(`CycloneDX 1.7 validation failed: ${result.message ?? result}`);
}

export async function writeReleaseInventory({ outputDir, ...options }) {
	if (!outputDir) throw new Error("An output directory is required");
	const inventory = await buildReleaseInventory(options);
	const sbom = buildCycloneDx(inventory);
	await validateCycloneDx(sbom);
	await mkdir(outputDir, { recursive: true });
	const targetSuffix = inventory.target
		? `-${inventory.target.platform}-${inventory.target.arch}`
		: "";
	const inventoryPath = path.join(
		outputDir,
		INVENTORY_FILE.replace(".json", `${targetSuffix}.json`),
	);
	const sbomPath = path.join(
		outputDir,
		inventory.target ? `klippt-release-sbom${targetSuffix}.cdx.json` : SBOM_FILE,
	);
	await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
	await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
	return { inventoryPath, sbomPath, inventory, sbom };
}

function parseArguments(args) {
	const options = { artifacts: [] };
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		index += 1;
		if (flag === "--output-dir") options.outputDir = path.resolve(value);
		else if (flag === "--native-dir") options.nativeDir = path.resolve(value);
		else if (flag === "--package-dir") options.packageDir = path.resolve(value);
		else if (flag === "--artifact") options.artifacts.push(path.resolve(value));
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
	const options = parseArguments(process.argv.slice(2));
	const outputDir = options.outputDir ?? path.join(DEFAULT_ROOT, "release", "supply-chain");
	const result = await writeReleaseInventory({ ...options, outputDir });
	console.log(`Release inventory: ${result.inventoryPath}`);
	console.log(`CycloneDX 1.7 SBOM: ${result.sbomPath}`);
	console.log(`${result.inventory.components.length} locked or packaged components`);
}
