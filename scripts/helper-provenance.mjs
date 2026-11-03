#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HELPER_MANIFEST_NAME = "klippt-helper-manifest.json";
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TARGET = /^(darwin-(?:arm64|x64)|linux-(?:arm64|x64)|win32-x64)$/;
const CMAKE_HELPER_NAMES = new Map([
	["whisper", "whisper.cpp"],
	["httplib", "cpp-httplib"],
	["json", "nlohmann-json"],
]);
const CMAKE_DIRECTORY_NAMES = new Map(
	[...CMAKE_HELPER_NAMES].map(([cmakeName, helperName]) => [helperName, cmakeName]),
);

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

const MACH_O_MAGICS = new Set([
	0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

async function isMachO(filePath) {
	const handle = await open(filePath, "r");
	try {
		const magic = Buffer.alloc(4);
		const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
		return bytesRead === 4 && MACH_O_MAGICS.has(magic.readUInt32BE(0));
	} finally {
		await handle.close();
	}
}

function diagnose(filePath) {
	const sh = (label, cmd) => {
		let out = "";
		try {
			out = execFileSync("/bin/bash", ["-c", `${cmd} 2>&1`], { encoding: "utf8" });
		} catch (e) {
			out = `EXIT ${e.status}: ${e.stdout ?? ""}`;
		}
		console.log(`DIAG[${label}] ${cmd}\n${out}`);
	};
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
	const f = path.join(d, path.basename(filePath));
	fs.copyFileSync(filePath, f);
	sh("orig-ls", `ls -l '${f}'; file '${f}'; codesign -dv '${f}'`);
	sh("orig-otool", `otool -l '${f}' | grep -E -A6 'LC_SEGMENT_64|LC_CODE_SIGNATURE|LC_SYMTAB|LC_DYLD|LC_DYSYMTAB|LC_FUNCTION|LC_DATA_IN|LC_BUILD|LC_DYLD_CHAINED' | grep -E 'cmd |__LINKEDIT|segname|vmsize|fileoff|filesize|dataoff|datasize|symoff|stroff|strsize|nsyms|rebase_off|bind_off|export_off|size|minos|sdk'`);
	for (const [label, steps] of [
		["B-strip-signed", `strip -S '${f}'`],
		["C-remove-only", `codesign --remove-signature '${f}'`],
		["D-remove-then-strip-x", `codesign --remove-signature '${f}' && strip -S -x '${f}'`],
		["E-remove-then-strip-u", `codesign --remove-signature '${f}' && strip -u -r '${f}'`],
		["F-remove-then-strip-noargs", `codesign --remove-signature '${f}' && strip '${f}'`],
	]) {
		const g = path.join(d, label);
		fs.copyFileSync(filePath, g);
		sh(label, steps.split(f).join(g));
		sh(`${label}-otool`, `ls -l '${g}'; otool -l '${g}' | grep -E -A5 '__LINKEDIT|LC_CODE_SIGNATURE' | grep -E 'cmd |vmsize|filesize|fileoff|dataoff|datasize'`);
	}
}

async function fileIdentity(filePath, target) {
	if (!target.startsWith("darwin-") || !(await isMachO(filePath))) {
		const info = await stat(filePath);
		return {
			contentIdentity: "exact-bytes",
			contentSize: info.size,
			contentSha256: await sha256File(filePath),
		};
	}
	if (process.platform !== "darwin") {
		throw new Error(`Darwin helper provenance needs macOS codesign: ${filePath}`);
	}
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "klippt-helper-identity-"));
	const temporaryFile = path.join(temporaryDirectory, path.basename(filePath));
	try {
		await copyFile(filePath, temporaryFile);
		execFileSync("/usr/bin/codesign", ["--remove-signature", temporaryFile], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		// A hardened-runtime signature can enlarge __LINKEDIT. `codesign
		// --remove-signature` removes the signature bytes but leaves that segment's
		// virtual size behind, so the same executable hashes differently before and
		// after distribution signing. Apple's strip tool rewrites the temporary
		// link-edit metadata deterministically. `-S` also removes debug symbols,
		// which do not affect executable behavior and are not shipped as provenance.
		execFileSync("/usr/bin/strip", ["-S", temporaryFile], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		const info = await stat(temporaryFile);
		return {
			contentIdentity: "mach-o-without-code-signature",
			contentSize: info.size,
			contentSha256: await sha256File(temporaryFile),
		};
	} catch (error) {
		diagnose(filePath);
		const detail = String(error.stderr ?? error.message).trim();
		throw new Error(`Could not normalize signed Mach-O helper ${filePath}: ${detail}`);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function inside(root, candidate) {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function listHelperFiles(root, target, current = root) {
	const realRoot = await realpath(root);
	const files = [];
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const filePath = path.join(current, entry.name);
		const relativePath = path.relative(root, filePath).split(path.sep).join("/");
		if (relativePath === HELPER_MANIFEST_NAME) continue;
		const info = await lstat(filePath);
		if (info.isDirectory()) {
			files.push(...(await listHelperFiles(root, target, filePath)));
			continue;
		}
		let contentPath = filePath;
		let symlinkTarget;
		if (info.isSymbolicLink()) {
			contentPath = await realpath(filePath);
			if (!inside(realRoot, contentPath)) {
				throw new Error(`Helper symlink escapes its artifact: ${relativePath}`);
			}
			symlinkTarget = await fs.promises.readlink(filePath);
		}
		const contentInfo = await stat(contentPath);
		if (!contentInfo.isFile()) throw new Error(`Helper entry is not a file: ${relativePath}`);
		files.push({
			path: relativePath,
			...(await fileIdentity(contentPath, target)),
			...(symlinkTarget ? { symlinkTarget } : {}),
		});
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

function validateMetadata({ helper, sourceSha, workflowRunId, target, upstream, toolchains }) {
	if (typeof helper !== "string" || !/^[a-z0-9-]+$/.test(helper)) {
		throw new Error("Helper name must use lowercase letters, numbers, and hyphens");
	}
	if (!SOURCE_SHA.test(sourceSha ?? "")) throw new Error("Helper source SHA must be 40 hex digits");
	if (!/^\d+$/.test(String(workflowRunId ?? ""))) {
		throw new Error("Helper workflow run ID must be numeric");
	}
	if (!TARGET.test(target ?? "")) throw new Error(`Unsupported helper target: ${target}`);
	if (!Array.isArray(upstream) || upstream.length === 0) {
		throw new Error("Helper manifest needs at least one upstream revision");
	}
	for (const item of upstream) {
		if (
			typeof item?.name !== "string" ||
			typeof item?.repository !== "string" ||
			!SOURCE_SHA.test(item?.revision ?? "")
		) {
			throw new Error("Every helper upstream must have a name, repository, and immutable revision");
		}
	}
	if (!toolchains || typeof toolchains !== "object" || Array.isArray(toolchains)) {
		throw new Error("Helper toolchains must be an object");
	}
	for (const [name, value] of Object.entries(toolchains)) {
		if (!name || typeof value !== "string" || !value.trim()) {
			throw new Error("Every helper toolchain must have a nonempty name and value");
		}
	}
}

function cmakeValue(value, variables) {
	const unquoted = value.replace(/^"|"$/g, "");
	const variable = /^\$\{([A-Za-z0-9_]+)\}$/.exec(unquoted)?.[1];
	return variable ? variables.get(variable) : unquoted;
}

export function readCmakeUpstreams(filePath) {
	const source = fs.readFileSync(filePath, "utf8");
	const variables = new Map();
	for (const match of source.matchAll(/set\(\s*([A-Za-z0-9_]+)\s+("[^"\n]+"|[^\s)]+)/g)) {
		variables.set(match[1], match[2].replace(/^"|"$/g, ""));
	}
	const upstream = [];
	for (const match of source.matchAll(
		/FetchContent_Declare\(\s*([A-Za-z0-9_.-]+)([\s\S]*?)\n\s*\)/g,
	)) {
		const [, cmakeName, body] = match;
		const repositoryValue = /\bGIT_REPOSITORY\s+("[^"\n]+"|[^\s)]+)/.exec(body)?.[1];
		const revisionValue = /\bGIT_TAG\s+("[^"\n]+"|[^\s)]+)/.exec(body)?.[1];
		if (!repositoryValue || !revisionValue) continue;
		const repository = cmakeValue(repositoryValue, variables);
		const revision = cmakeValue(revisionValue, variables);
		if (!repository || !SOURCE_SHA.test(revision ?? "")) {
			throw new Error(`CMake dependency ${cmakeName} is not pinned to an immutable commit`);
		}
		upstream.push({
			name: CMAKE_HELPER_NAMES.get(cmakeName) ?? cmakeName,
			repository,
			revision,
		});
	}
	if (upstream.length === 0) throw new Error("CMake dependency source has no Git dependencies");
	return upstream.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeRepository(repository) {
	return repository
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}

async function findDirectoriesNamed(root, name) {
	const matches = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === ".git") continue;
			const candidate = path.join(current, entry.name);
			if (entry.name === name && path.basename(path.dirname(candidate)) === "_deps") {
				matches.push(candidate);
				continue;
			}
			pending.push(candidate);
		}
	}
	return matches.sort();
}

function gitOutput(directory, args) {
	try {
		return execFileSync("git", ["-C", directory, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		diagnose(filePath);
		const detail = String(error.stderr ?? error.message).trim();
		throw new Error(`Could not inspect built dependency ${directory}: ${detail}`);
	}
}

export async function verifyBuiltUpstreams(buildRoot, upstream) {
	if (!buildRoot) throw new Error("Built dependency verification needs a build root");
	validateMetadata({
		helper: "build-upstream-check",
		sourceSha: "0".repeat(40),
		workflowRunId: "0",
		target: "darwin-arm64",
		upstream,
		toolchains: {},
	});
	for (const item of upstream) {
		const cmakeName = CMAKE_DIRECTORY_NAMES.get(item.name) ?? item.name;
		const checkouts = await findDirectoriesNamed(path.resolve(buildRoot), `${cmakeName}-src`);
		if (checkouts.length === 0) {
			throw new Error(`Built dependency checkout is missing: ${item.name}`);
		}
		for (const checkout of checkouts) {
			const actualRevision = gitOutput(checkout, ["rev-parse", "--verify", "HEAD"]);
			if (actualRevision.toLowerCase() !== item.revision.toLowerCase()) {
				throw new Error(
					`Built dependency revision mismatch for ${item.name}: ${actualRevision} != ${item.revision}`,
				);
			}
			const actualRepository = gitOutput(checkout, ["remote", "get-url", "origin"]);
			if (normalizeRepository(actualRepository) !== normalizeRepository(item.repository)) {
				throw new Error(
					`Built dependency repository mismatch for ${item.name}: ${actualRepository} != ${item.repository}`,
				);
			}
		}
	}
}

export async function createHelperManifest({
	directory,
	helper,
	sourceSha,
	workflowRunId,
	target,
	upstream,
	toolchains,
}) {
	validateMetadata({ helper, sourceSha, workflowRunId, target, upstream, toolchains });
	const files = await listHelperFiles(directory, target);
	if (files.length === 0) throw new Error("Helper artifact has no files");
	const manifest = {
		schemaVersion: 2,
		kind: "klippt-native-helper",
		helper,
		source: { commit: sourceSha.toLowerCase(), workflowRunId: String(workflowRunId) },
		target,
		upstream: upstream
			.map((item) => ({ ...item, revision: item.revision.toLowerCase() }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		toolchains: Object.fromEntries(
			Object.entries(toolchains).sort(([a], [b]) => a.localeCompare(b)),
		),
		files,
	};
	await mkdir(directory, { recursive: true });
	const manifestPath = path.join(directory, HELPER_MANIFEST_NAME);
	const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
	await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	await rename(temporaryPath, manifestPath);
	return manifest;
}

function safeManifestPath(relativePath) {
	if (
		typeof relativePath !== "string" ||
		!relativePath ||
		path.posix.isAbsolute(relativePath) ||
		relativePath.split("/").includes("..") ||
		relativePath.includes("\\")
	) {
		throw new Error(`Unsafe helper manifest path: ${relativePath}`);
	}
	return relativePath;
}

export async function verifyHelperManifest({
	directory,
	expectedSourceSha,
	expectedWorkflowRunId,
	expectedTarget,
	allowAdditionalFiles = false,
}) {
	const manifestPath = path.join(directory, HELPER_MANIFEST_NAME);
	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read helper manifest: ${error.message}`);
	}
	if (manifest.schemaVersion !== 2 || manifest.kind !== "klippt-native-helper") {
		throw new Error("Unsupported helper manifest schema");
	}
	validateMetadata({
		helper: manifest.helper,
		sourceSha: manifest.source?.commit,
		workflowRunId: manifest.source?.workflowRunId,
		target: manifest.target,
		upstream: manifest.upstream,
		toolchains: manifest.toolchains,
	});
	if (expectedSourceSha && manifest.source.commit !== expectedSourceSha.toLowerCase()) {
		throw new Error(
			`Helper source mismatch: ${manifest.source.commit} != ${expectedSourceSha.toLowerCase()}`,
		);
	}
	if (expectedWorkflowRunId && manifest.source.workflowRunId !== String(expectedWorkflowRunId)) {
		throw new Error(
			`Helper workflow mismatch: ${manifest.source.workflowRunId} != ${expectedWorkflowRunId}`,
		);
	}
	if (expectedTarget && manifest.target !== expectedTarget) {
		throw new Error(`Helper target mismatch: ${manifest.target} != ${expectedTarget}`);
	}
	if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
		throw new Error("Helper manifest has no files");
	}
	const expectedPaths = new Set();
	for (const file of manifest.files) {
		const relativePath = safeManifestPath(file?.path);
		if (expectedPaths.has(relativePath)) throw new Error(`Duplicate helper file: ${relativePath}`);
		expectedPaths.add(relativePath);
		if (
			!Number.isSafeInteger(file.contentSize) ||
			file.contentSize < 0 ||
			!SHA256.test(file.contentSha256 ?? "") ||
			!["exact-bytes", "mach-o-without-code-signature"].includes(file.contentIdentity)
		) {
			throw new Error(`Invalid helper file metadata: ${relativePath}`);
		}
		const filePath = path.join(directory, ...relativePath.split("/"));
		const linkInfo = await lstat(filePath).catch(() => null);
		if (!linkInfo) throw new Error(`Missing helper file: ${relativePath}`);
		const expectedSymlink = Object.hasOwn(file, "symlinkTarget");
		if (expectedSymlink) {
			if (typeof file.symlinkTarget !== "string" || !file.symlinkTarget) {
				throw new Error(`Invalid helper symlink metadata: ${relativePath}`);
			}
			if (!linkInfo.isSymbolicLink()) {
				throw new Error(`Helper file type mismatch; expected symlink: ${relativePath}`);
			}
			const actualTarget = await readlink(filePath);
			if (actualTarget !== file.symlinkTarget) {
				throw new Error(`Helper symlink target mismatch: ${relativePath}`);
			}
		} else if (linkInfo.isSymbolicLink()) {
			throw new Error(`Helper file type mismatch; unexpected symlink: ${relativePath}`);
		}
		const resolved = await realpath(filePath).catch(() => null);
		const realRoot = await realpath(directory);
		if (!resolved || !inside(realRoot, resolved)) {
			throw new Error(`Missing or escaping helper file: ${relativePath}`);
		}
		const info = await stat(resolved);
		if (!info.isFile()) throw new Error(`Helper entry is not a file: ${relativePath}`);
		const identity = await fileIdentity(resolved, manifest.target);
		if (identity.contentIdentity !== file.contentIdentity) {
			throw new Error(`Helper file identity mismatch: ${relativePath}`);
		}
		if (identity.contentSize !== file.contentSize) {
			throw new Error(`Helper file size mismatch: ${relativePath}`);
		}
		if (identity.contentSha256 !== file.contentSha256) {
			throw new Error(`Helper file hash mismatch: ${relativePath}`);
		}
	}
	if (!allowAdditionalFiles) {
		const actualPaths = new Set(
			(await listHelperFiles(directory, manifest.target)).map((file) => file.path),
		);
		if (
			actualPaths.size !== expectedPaths.size ||
			[...actualPaths].some((relativePath) => !expectedPaths.has(relativePath))
		) {
			throw new Error("Helper artifact contains files that are absent from its manifest");
		}
	}
	return manifest;
}

export async function refreshHelperManifest(directory) {
	const manifestPath = path.join(directory, HELPER_MANIFEST_NAME);
	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read helper manifest for refresh: ${error.message}`);
	}
	validateMetadata({
		helper: manifest.helper,
		sourceSha: manifest.source?.commit,
		workflowRunId: manifest.source?.workflowRunId,
		target: manifest.target,
		upstream: manifest.upstream,
		toolchains: manifest.toolchains,
	});
	return createHelperManifest({
		directory,
		helper: manifest.helper,
		sourceSha: manifest.source.commit,
		workflowRunId: manifest.source.workflowRunId,
		target: manifest.target,
		upstream: manifest.upstream,
		toolchains: manifest.toolchains,
	});
}

function parseAssignments(values, label) {
	const output = {};
	for (const value of values) {
		const separator = value.indexOf("=");
		if (separator <= 0 || separator === value.length - 1) {
			throw new Error(`${label} must use name=value`);
		}
		output[value.slice(0, separator)] = value.slice(separator + 1);
	}
	return output;
}

function parseArguments(args) {
	const options = { toolchain: [], upstream: [] };
	const command = args.shift();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag?.startsWith("--") || value === undefined)
			throw new Error(`Invalid argument: ${flag}`);
		const name = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (name === "toolchain" || name === "upstream") options[name].push(value);
		else options[name] = value;
	}
	return { command, options };
}

async function main() {
	const { command, options } = parseArguments(process.argv.slice(2));
	if (command === "create") {
		if (options.dependencySource && options.upstream.length > 0) {
			throw new Error("Use either --dependency-source or --upstream, not both");
		}
		const upstream = options.dependencySource
			? readCmakeUpstreams(path.resolve(options.dependencySource))
			: Object.entries(parseAssignments(options.upstream, "--upstream")).map(([name, value]) => {
					const separator = value.lastIndexOf("@");
					if (separator <= 0) throw new Error("--upstream must use name=repository@revision");
					return {
						name,
						repository: value.slice(0, separator),
						revision: value.slice(separator + 1),
					};
				});
		if (options.dependencySource) {
			if (!options.buildRoot) {
				throw new Error("--dependency-source requires --build-root to verify the built checkout");
			}
			await verifyBuiltUpstreams(path.resolve(options.buildRoot), upstream);
		}
		await createHelperManifest({
			directory: path.resolve(options.directory),
			helper: options.helper,
			sourceSha: options.sourceSha,
			workflowRunId: options.workflowRunId,
			target: options.target,
			upstream,
			toolchains: parseAssignments(options.toolchain, "--toolchain"),
		});
		return;
	}
	if (command === "refresh") {
		await refreshHelperManifest(path.resolve(options.directory));
		return;
	}
	if (command === "verify") {
		await verifyHelperManifest({
			directory: path.resolve(options.directory),
			expectedSourceSha: options.sourceSha,
			expectedWorkflowRunId: options.workflowRunId,
			expectedTarget: options.target,
		});
		return;
	}
	throw new Error("usage: helper-provenance.mjs <create|refresh|verify> [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
