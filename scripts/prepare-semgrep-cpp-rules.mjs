import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");

async function yamlFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await yamlFiles(entryPath)));
		else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(entryPath);
	}
	return files;
}

export async function prepareSemgrepCppRules(sourceDirectory, outputDirectory) {
	if (fs.existsSync(outputDirectory)) {
		throw new Error(`C++ rule output already exists: ${outputDirectory}`);
	}
	await cp(sourceDirectory, outputDirectory, { recursive: true, errorOnExist: true, force: false });
	let convertedFiles = 0;
	for (const filePath of await yamlFiles(outputDirectory)) {
		const source = await readFile(filePath, "utf8");
		const converted = source
			.replace(/languages:\s*\[\s*c\s*\]/g, "languages: [cpp]")
			.replace(/^(\s*-\s*)c(\s*(?:#.*)?)$/gm, "$1cpp$2");
		if (converted === source) continue;
		if (/languages:\s*\[\s*c\s*\]/.test(converted) || /^\s*-\s*c\s*$/m.test(converted)) {
			throw new Error(`C language declaration remains in ${filePath}`);
		}
		await writeFile(filePath, converted, "utf8");
		convertedFiles += 1;
	}
	if (convertedFiles === 0) throw new Error("No pinned C rules were converted to C++");
	return convertedFiles;
}

export function verifySemgrepCppCoverage(report, expectedPaths) {
	const scanned = new Set((report.paths?.scanned ?? []).map((item) => item.replace(/^\.\//, "")));
	const missing = expectedPaths.filter((item) => !scanned.has(item.replace(/^\.\//, "")));
	if (missing.length) {
		throw new Error(`Semgrep did not scan tracked C++ source: ${missing.join(", ")}`);
	}
}

function trackedCppPaths(root) {
	return execFileSync("git", ["ls-files", "--", "*.cpp", "*.cc", "*.cxx"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean)
		.sort();
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const [mode, first, second] = process.argv.slice(2);
	if (mode === "--verify-report") {
		if (!first || second) throw new Error("Usage: --verify-report <semgrep-report.json>");
		const report = JSON.parse(await readFile(path.resolve(first), "utf8"));
		const expected = trackedCppPaths(DEFAULT_ROOT);
		if (expected.length === 0) throw new Error("No tracked C++ sources were found");
		verifySemgrepCppCoverage(report, expected);
		console.log(`Semgrep covered all ${expected.length} tracked C++ source files`);
	} else {
		if (!mode || !first || second) {
			throw new Error("Usage: <pinned-c-rules-directory> <output-directory>");
		}
		const count = await prepareSemgrepCppRules(path.resolve(mode), path.resolve(first));
		console.log(`Prepared ${count} pinned C rule files for the C++ parser`);
	}
}
