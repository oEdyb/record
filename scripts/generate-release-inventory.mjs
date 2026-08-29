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
import {
	cargoLicenseRecordFor,
	readCargoLicenseInventory,
} from "./generate-cargo-license-inventory.mjs";
import { HELPER_MANIFEST_NAME, verifyHelperManifest } from "./helper-provenance.mjs";
import { verifyPackagedDistribution } from "./verify-packaged-distribution.mjs";
import { loadWebDemuxerPolicy } from "./web-demuxer-source.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const INVENTORY_FILE = "klippt-release-inventory.json";
const SBOM_FILE = "klippt-release-sbom.cdx.json";
const SHA256_RE = /^[0-9a-f]{64}$/i;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/i;

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
	const webDemuxerPolicyPath = path.join(root, "supply-chain", "web-demuxer.json");
	const webDemuxerPolicy = fs.existsSync(webDemuxerPolicyPath)
		? loadWebDemuxerPolicy(webDemuxerPolicyPath)
		: null;
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
			license:
				typeof entry.license === "string"
					? entry.license
					: name === webDemuxerPolicy?.package.name &&
							entry.version === webDemuxerPolicy.package.version
						? webDemuxerPolicy.package.license
						: undefined,
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
	const licenses = readCargoLicenseInventory(root);
	for (const graph of loadCargoGraphs(root)) {
		const relativeLock = graph.lockfile;
		const lock = fs.readFileSync(path.join(root, relativeLock), "utf8");
		for (const block of lock.split("[[package]]").slice(1)) {
			const name = cargoString(block, "name");
			const version = cargoString(block, "version");
			if (!name || !version) continue;
			const source = cargoString(block, "source") ?? "workspace";
			const checksum = cargoString(block, "checksum");
			const licenseRecord =
				source === "workspace"
					? undefined
					: cargoLicenseRecordFor(licenses, { name, version, source });
			const license =
				source === "workspace" ? "LicenseRef-Klippt-Proprietary" : licenseRecord?.license;
			if (!license) {
				throw new Error(`Cargo licence inventory does not cover ${name}@${version} from ${source}`);
			}
			components.push({
				id: `cargo:${relativeLock}:${name}@${version}:${source}`,
				ecosystem: "cargo",
				kind: "library",
				name,
				version,
				scope: graph.scope,
				purl: `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
				source,
				license,
				licenseEvidence: licenseRecord?.licenseEvidence,
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
		license: pin.identity === "fluidaudio" ? "Apache-2.0" : undefined,
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
	const modelRights = readJson(path.join(root, "supply-chain", "model-rights.json"));
	if (modelRights.schemaVersion !== 1) throw new Error("Unsupported model-rights schema");
	const components = [];
	for (const [modelId, model] of Object.entries(models)) {
		const rights = modelRights.models?.[modelId];
		if (!rights) throw new Error(`Model rights policy does not cover ${modelId}`);
		for (const file of model.files ?? []) {
			if (!file.expectedSha256 || !SHA256_RE.test(file.expectedSha256)) {
				throw new Error(`${modelId}/${file.name} does not have a pinned SHA-256`);
			}
			const revision = new URL(file.url).pathname.match(/\/resolve\/([^/]+)\//)?.[1];
			if (!revision || !/^[0-9a-f]{40}$/i.test(revision)) {
				throw new Error(`${modelId}/${file.name} is not pinned to an immutable revision`);
			}
			const repository = new URL(file.url).pathname.split("/").slice(1, 3).join("/");
			if (repository !== rights.repository || revision !== rights.revision) {
				throw new Error(`${modelId}/${file.name} differs from its reviewed rights policy`);
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
				license: rights.license,
				distributionStatus: rights.distributionStatus,
				licenseEvidence: rights.evidence,
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
	const deepFilterRights = modelRights.models?.["deepfilternet3-onnx"];
	if (
		!deepFilterRights ||
		deepFilterRights.revision !== "b0fa238a331fb5cc39c5555d3538008dd88c0aef" ||
		deepFilterRights.distributionStatus !== "excluded-from-release"
	) {
		throw new Error("DeepFilterNet model rights must remain explicitly excluded");
	}
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
		license: deepFilterRights.license,
		distributionStatus: deepFilterRights.distributionStatus,
		licenseEvidence: deepFilterRights.evidence,
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
			license: "LGPL-2.1-or-later",
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
			license: "LGPL-2.1-or-later",
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
		license: "LGPL-2.1-or-later",
	});
	return components;
}

async function webAssemblyComponent(root, npmComponents) {
	const policy = loadWebDemuxerPolicy(path.join(root, "supply-chain", "web-demuxer.json"));
	const relativePath = "public/wasm/web-demuxer.wasm";
	const filePath = path.join(root, relativePath);
	const info = await stat(filePath);
	const packageComponent = npmComponents.find((item) => item.name === "web-demuxer");
	if (!packageComponent)
		throw new Error("web-demuxer is missing from the production npm lock graph");
	if (packageComponent.version !== policy.package.version) {
		throw new Error("web-demuxer policy does not match the production npm version");
	}
	const hash = await sha256File(filePath);
	if (info.size !== policy.binary.size || hash !== policy.binary.sha256) {
		throw new Error("web-demuxer.wasm does not match its reviewed source policy");
	}
	return {
		id: `wasm:web-demuxer@${packageComponent.version}`,
		ecosystem: "webassembly",
		kind: "file",
		name: "web-demuxer.wasm",
		version: packageComponent.version,
		scope: "required",
		path: relativePath,
		size: info.size,
		hash: { algorithm: "SHA-256", value: hash },
		source: `${policy.package.repository}/commit/${policy.package.commit}`,
		license: `${policy.package.license} AND ${policy.ffmpeg.license}`,
		configureFlags: [...policy.build.configureFlags],
		correspondingSource: policy.sourceArchives.map((archive) => ({
			fileName: archive.fileName,
			url: archive.url,
			hash: { algorithm: "SHA-256", value: archive.sha256 },
		})),
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

async function helperManifestComponents({ packageDir, platform, arch, sourceSha }) {
	if (!packageDir) return [];
	const expectedTarget = platformDirectory(platform, arch);
	const packagedFiles = await walkFiles(packageDir);
	const helperBinaries = packagedFiles.filter(({ filePath }) =>
		/^whisper-stt-server(?:-cuda)?(?:\.exe)?$/.test(path.basename(filePath)),
	);
	const manifestPaths = packagedFiles
		.map(({ filePath }) => filePath)
		.filter((filePath) => path.basename(filePath) === HELPER_MANIFEST_NAME);
	for (const { filePath } of helperBinaries) {
		if (!manifestPaths.includes(path.join(path.dirname(filePath), HELPER_MANIFEST_NAME))) {
			throw new Error(`Packaged Whisper helper has no provenance manifest: ${filePath}`);
		}
	}
	const components = [];
	for (const manifestPath of manifestPaths) {
		const directory = path.dirname(manifestPath);
		const manifest = await verifyHelperManifest({
			directory,
			expectedSourceSha: sourceSha,
			expectedTarget,
			allowAdditionalFiles: true,
		});
		const info = await stat(manifestPath);
		components.push({
			id: `helper-manifest:${expectedTarget}:${manifest.helper}`,
			ecosystem: "native-helper",
			kind: "file",
			name: `${manifest.helper} provenance manifest`,
			version: manifest.source.commit.slice(0, 12),
			scope: "required",
			path: `package/${path.relative(packageDir, manifestPath).split(path.sep).join("/")}`,
			size: info.size,
			hash: { algorithm: "SHA-256", value: await sha256File(manifestPath) },
			target: expectedTarget,
			role: "native-helper-manifest",
			sourceCommit: manifest.source.commit,
			workflowRunId: manifest.source.workflowRunId,
			upstream: manifest.upstream,
			toolchains: manifest.toolchains,
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
		component.sourceCommit
			? { name: "app.klippt:source-commit", value: component.sourceCommit }
			: undefined,
		component.workflowRunId
			? { name: "app.klippt:workflow-run-id", value: component.workflowRunId }
			: undefined,
		component.upstream
			? { name: "app.klippt:upstream", value: JSON.stringify(component.upstream) }
			: undefined,
		component.toolchains
			? { name: "app.klippt:toolchains", value: JSON.stringify(component.toolchains) }
			: undefined,
		component.distributionStatus
			? { name: "app.klippt:distribution-status", value: component.distributionStatus }
			: undefined,
		component.licenseEvidence
			? {
					name: "app.klippt:license-evidence",
					value:
						typeof component.licenseEvidence === "string"
							? component.licenseEvidence
							: JSON.stringify(component.licenseEvidence),
				}
			: undefined,
		component.configureFlags
			? { name: "app.klippt:configure-flags", value: JSON.stringify(component.configureFlags) }
			: undefined,
		component.correspondingSource
			? {
					name: "app.klippt:corresponding-source",
					value: JSON.stringify(component.correspondingSource),
				}
			: undefined,
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
	buildOutputRoots,
} = {}) {
	verifyApprovedDependencies(root);
	const packageJson = readJson(path.join(root, "package.json"));
	const npm = readNpmComponents(root);
	const resolvedSourceSha = sourceSha ?? process.env.KLIPPT_SOURCE_SHA ?? gitSha(root);
	if (!SOURCE_SHA_RE.test(resolvedSourceSha)) {
		throw new Error("Release inventory source commit must be 40 hex digits");
	}
	if (packageDir) {
		await verifyPackagedDistribution({
			root,
			packageDir,
			platform,
			arch,
			sourceSha: resolvedSourceSha,
			buildOutputRoots,
		});
	}
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
		...(await helperManifestComponents({
			packageDir,
			platform,
			arch,
			sourceSha: resolvedSourceSha,
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
		source: { commit: resolvedSourceSha },
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
