#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const FULL_COMMIT = /^[^\s/@]+\/[^\s@]+@[0-9a-f]{40}$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

function workflowFiles(directory) {
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			return SKIPPED_DIRECTORIES.has(entry.name) ? [] : workflowFiles(absolute);
		}
		return entry.isFile() && /\.(?:ya?ml)$/.test(entry.name) ? [absolute] : [];
	});
}

export function verifyWorkflowActionPins(root = DEFAULT_ROOT) {
	const files = workflowFiles(path.join(root, ".github"));
	const violations = [];
	for (const file of files) {
		const relativePath = path.relative(root, file).split(path.sep).join("/");
		for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
			const match = /\buses:\s*([^\s#]+)/.exec(line);
			if (!match) continue;
			const reference = match[1];
			if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
			if (!FULL_COMMIT.test(reference)) {
				violations.push(`${relativePath}:${index + 1}: ${reference}`);
			}
		}
	}
	if (violations.length > 0) {
		throw new Error(`GitHub Actions must use full reviewed commit SHAs:\n${violations.join("\n")}`);
	}
	return files.length;
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	if (process.argv.length !== 2) throw new Error("This checker does not accept arguments");
	console.log(`${verifyWorkflowActionPins()} GitHub workflow files use immutable action pins`);
}
