#!/usr/bin/env node

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectories = ["dist", "dist-electron"];

for (const relativePath of outputDirectories) {
	const target = path.resolve(root, relativePath);
	if (path.dirname(target) !== root || path.basename(target) !== relativePath) {
		throw new Error(`Refusing to remove unexpected build path: ${target}`);
	}
	await rm(target, { recursive: true, force: true });
}

console.log("Removed stale renderer and Electron build output");
