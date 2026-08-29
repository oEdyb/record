#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadWebDemuxerPolicy } from "./web-demuxer-source.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const TARGETS = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
]);
const FFMPEG_FILE =
	/^(?:ffmpeg(?:-shared)?(?:\.exe)?|(?:lib)?(?:avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale)(?:[-.].*)?)$/i;
const CONFIGURATION_MARKER = Buffer.from("--prefix=");
const MAX_CONFIGURATION_BYTES = 64 * 1024;

function requireValue(condition, message) {
	if (!condition) throw new Error(message);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function toPosix(value) {
	return value.split(path.sep).join("/");
}

function isWithin(parent, child) {
	const relative = path.relative(parent, child);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function listFiles(root) {
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
		else if (entry.isFile() || entry.isSymbolicLink()) files.push(absolute);
	}
	return files;
}

function configurationsIn(bytes) {
	const configurations = [];
	let offset = 0;
	while (offset < bytes.length) {
		const start = bytes.indexOf(CONFIGURATION_MARKER, offset);
		if (start === -1) break;
		const nul = bytes.indexOf(0, start);
		const end = nul === -1 ? Math.min(bytes.length, start + MAX_CONFIGURATION_BYTES) : nul;
		if (end - start <= MAX_CONFIGURATION_BYTES) {
			const value = bytes.subarray(start, end).toString("utf8").trimEnd();
			if (/^--prefix=\S+/.test(value) && value.includes("--enable-shared")) {
				configurations.push(value);
			}
		}
		offset = start + CONFIGURATION_MARKER.length;
	}
	return configurations;
}

export function nativeFfmpegEvidenceFileNames(target) {
	requireValue(TARGETS.has(target), `Unsupported native FFmpeg target: ${target}`);
	return [
		`native-ffmpeg-${target}-source-manifest.json`,
		`native-ffmpeg-${target}-configuration.txt`,
		`native-ffmpeg-${target}-relinking.txt`,
	];
}

export function isNativeFfmpegEvidenceFileName(fileName) {
	return /^(?:native-ffmpeg)-(?:darwin|linux|win32)-(?:arm64|x64)-(?:source-manifest\.json|configuration\.txt|relinking\.txt)$/.test(
		fileName,
	);
}

async function packagedFfmpegFiles(packageDir, target) {
	const targetFragment = `/resources/electron/native/bin/${target}/`;
	const files = (await listFiles(packageDir)).filter((file) => {
		const relative = `/${toPosix(path.relative(packageDir, file))}`.toLowerCase();
		return relative.includes(targetFragment) && FFMPEG_FILE.test(path.basename(file));
	});
	requireValue(files.length > 0, `No packaged native FFmpeg files found for ${target}`);
	return files.sort();
}

async function describeFile(packageDir, file) {
	const fileStat = await lstat(file);
	let linkTarget;
	if (fileStat.isSymbolicLink()) {
		linkTarget = await readlink(file);
		const resolved = path.resolve(path.dirname(file), linkTarget);
		requireValue(
			isWithin(packageDir, resolved),
			`Packaged FFmpeg symlink escapes the package: ${file}`,
		);
		requireValue((await stat(resolved)).isFile(), `Packaged FFmpeg symlink is not a file: ${file}`);
	}
	const bytes = await readFile(file);
	return {
		absolute: file,
		bytes,
		record: {
			path: toPosix(path.relative(packageDir, file)),
			size: bytes.length,
			sha256: sha256(bytes),
			...(linkTarget ? { linkTarget: toPosix(linkTarget) } : {}),
		},
	};
}

function sourceArchivesForTarget(policy, target) {
	return policy.nativeFfmpeg.sourceArchives.filter((archive) => archive.targets.includes(target));
}

function buildCommand(policy, target, configuration) {
	if (target.startsWith("darwin-")) {
		return policy.nativeFfmpeg.macos.buildCommand.replace(
			"./configure <the exact target configuration in the target manifest>",
			`./configure ${configuration}`,
		);
	}
	return policy.nativeFfmpeg.btbn.buildCommands[target];
}

function configurationText({ target, configuration, command }) {
	return `Klippt native FFmpeg build evidence\n\nTarget: ${target}\nLicense: LGPL-2.1-or-later\n\nExact build command\n${command}\n\nConfiguration reported by the packaged libavutil build\n${configuration}\n`;
}

function relinkingText({ target, files, archives }) {
	return `Klippt native FFmpeg ${target} relinking instructions\n\nThe FFmpeg libraries in this package use dynamic linking and remain replaceable.\nThe exact corresponding-source archives are published beside this file:\n${archives.map((archive) => `- ${archive.fileName}`).join("\n")}\n\nReplace and relink\n1. Rebuild FFmpeg with the command and configuration in native-ffmpeg-${target}-configuration.txt.\n2. Replace the matching files under resources/electron/native/bin/${target}/:\n${files.map((file) => `   - ${path.basename(file.path)}`).join("\n")}\n3. Rebuild or re-sign the outer application package after the replacement.\n\nKlippt support does not cover modified builds. Your LGPL rights to study, rebuild, replace, and debug these libraries remain unchanged.\n`;
}

async function publishFiles(outputDir, files) {
	await mkdir(outputDir, { recursive: true });
	for (const [fileName, contents] of Object.entries(files)) {
		const temporary = path.join(outputDir, `.${fileName}.${randomUUID()}.tmp`);
		await writeFile(temporary, contents, { flag: "wx" });
		try {
			await rename(temporary, path.join(outputDir, fileName));
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}
}

export async function buildNativeFfmpegSourceEvidence({
	root = DEFAULT_ROOT,
	packageDir,
	target,
	outputDir,
	policyPath = path.join(root, "supply-chain", "web-demuxer.json"),
} = {}) {
	requireValue(packageDir, "A packaged application directory is required");
	requireValue(outputDir, "An output directory is required");
	requireValue(TARGETS.has(target), `Unsupported native FFmpeg target: ${target}`);
	const policy = loadWebDemuxerPolicy(policyPath);
	const described = await Promise.all(
		(await packagedFfmpegFiles(path.resolve(packageDir), target)).map((file) =>
			describeFile(path.resolve(packageDir), file),
		),
	);
	const configurations = new Set(described.flatMap(({ bytes }) => configurationsIn(bytes)));
	requireValue(
		configurations.size === 1,
		`Expected one packaged FFmpeg configuration, got ${configurations.size}`,
	);
	const [configuration] = configurations;
	requireValue(!configuration.includes("--enable-gpl"), "Packaged FFmpeg enables GPL code");
	requireValue(!configuration.includes("--enable-nonfree"), "Packaged FFmpeg enables nonfree code");
	requireValue(
		configuration.includes("--disable-static"),
		"Packaged FFmpeg is not a shared-only build",
	);
	const archives = sourceArchivesForTarget(policy, target);
	requireValue(archives.length > 0, `No corresponding source is mapped to ${target}`);
	const command = buildCommand(policy, target, configuration);
	requireValue(command, `No exact build command is mapped to ${target}`);
	const fileRecords = described.map(({ record }) => record);
	const [manifestName, configurationName, relinkingName] = nativeFfmpegEvidenceFileNames(target);
	const manifest = {
		schemaVersion: 1,
		component: "FFmpeg",
		license: policy.nativeFfmpeg.license,
		target,
		configurationSha256: sha256(configuration),
		buildCommand: command,
		packagedFiles: fileRecords,
		sourceArchives: archives.map(({ fileName, size, sha256: hash }) => ({
			fileName,
			size,
			sha256: hash,
		})),
	};
	await publishFiles(outputDir, {
		[manifestName]: `${JSON.stringify(manifest, null, 2)}\n`,
		[configurationName]: configurationText({ target, configuration, command }),
		[relinkingName]: relinkingText({ target, files: fileRecords, archives }),
	});
	return { manifest, files: nativeFfmpegEvidenceFileNames(target) };
}

function option(args, name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const args = process.argv.slice(2);
	const packageDir = option(args, "--package-dir");
	const target = option(args, "--target");
	const outputDir = option(args, "--output-dir");
	await buildNativeFfmpegSourceEvidence({
		packageDir: packageDir && path.resolve(packageDir),
		target,
		outputDir: outputDir && path.resolve(outputDir),
	});
	console.log(`Native FFmpeg source evidence: ${target}`);
}
