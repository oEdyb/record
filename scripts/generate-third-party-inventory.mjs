#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs, { globSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReleaseInventory } from "./generate-release-inventory.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const OUTPUT_FILE = "THIRD-PARTY-INVENTORY.json";
const FIXED_SOURCE_SHA = "0".repeat(40);
const THIRD_PARTY_ECOSYSTEMS = new Set(["npm", "cargo", "swift", "ffmpeg", "model", "webassembly"]);

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireValue(condition, message) {
	if (!condition) throw new Error(message);
}

function portable(value) {
	return value.split(path.sep).join("/");
}

export function collectLicenseTexts(root) {
	const files = globSync("third-party-licenses/**", { cwd: root })
		.filter((relativePath) => fs.statSync(path.join(root, relativePath)).isFile())
		.map((relativePath) => ({ sourcePath: relativePath, path: relativePath }));
	files.push({
		sourcePath: "node_modules/electron/dist/LICENSES.chromium.html",
		path: "LICENSES.chromium.html",
	});
	return files
		.sort((a, b) => a.path.localeCompare(b.path))
		.map(({ sourcePath, path: shippedPath }) => {
			const bytes = fs.readFileSync(path.join(root, sourcePath));
			return {
				path: portable(shippedPath),
				sourcePath: portable(sourcePath),
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
		});
}

function verifyBundledAssetPolicy(root, policy) {
	requireValue(policy?.schemaVersion === 1, "Unsupported bundled-asset policy schema");
	for (const group of [...(policy.included ?? []), ...(policy.excluded ?? [])]) {
		requireValue(group.id && group.license && group.paths?.length, "Invalid bundled-asset group");
		for (const pattern of group.paths) {
			const matches = globSync(pattern, { cwd: root, exclude: ["node_modules/**", "release/**"] });
			requireValue(matches.length > 0, `Bundled-asset policy path has no files: ${pattern}`);
		}
	}
	for (const group of policy.included ?? []) {
		requireValue(
			Array.isArray(group.packagedOutputPatterns) && group.packagedOutputPatterns.length > 0,
			`Included asset group has no packaged output policy: ${group.id}`,
		);
		for (const outputPattern of group.packagedOutputPatterns) {
			requireValue(
				typeof outputPattern === "string" &&
					outputPattern.startsWith("^") &&
					outputPattern.endsWith("$"),
				`Packaged asset output must be an anchored pattern: ${group.id}`,
			);
			new RegExp(outputPattern);
		}
	}
	const applicationBuild = policy.applicationBuild;
	requireValue(
		Array.isArray(applicationBuild?.requiredEntrypoints) &&
			Array.isArray(applicationBuild?.compiledOutputPatterns) &&
			Array.isArray(applicationBuild?.excludedOutputs),
		"Bundled-asset policy has no application-build contract",
	);
	const builder = fs.readFileSync(path.join(root, "electron-builder.json5"), "utf8");
	for (const exclusion of applicationBuild.excludedOutputs) {
		requireValue(
			typeof exclusion.pattern === "string" &&
				exclusion.pattern.startsWith("^") &&
				exclusion.pattern.endsWith("$") &&
				typeof exclusion.builderPattern === "string" &&
				builder.includes(JSON.stringify(exclusion.builderPattern)),
			`Electron Builder does not enforce reviewed output exclusion: ${exclusion.pattern}`,
		);
		new RegExp(exclusion.pattern);
	}
	requireValue(
		builder.includes('"from": "public/cursors/default"') &&
			!builder.includes('"from": "public/cursors",'),
		"Release packages must copy only the reviewed default cursor sprites",
	);
	requireValue(
		builder.includes('"!dist/cursors{,/**/*}"'),
		"Release packages must exclude public cursor packs copied by Vite",
	);
	for (const fileName of ["demo.gif", "openscreen.png", "preview*.png", "vite.svg"]) {
		requireValue(
			builder.includes(`"!dist/${fileName}"`),
			`Release packages must exclude legacy asset ${fileName}`,
		);
	}
	requireValue(
		builder.includes('"!dist/wasm/web-demuxer.wasm"') &&
			builder.includes('"from": "public/wasm/web-demuxer.wasm"') &&
			builder.includes('"to": "web-demuxer.wasm"'),
		"The LGPL WebAssembly file must ship as a standalone replaceable resource",
	);
	requireValue(
		builder.includes('"from": "node_modules/electron/dist/LICENSES.chromium.html"') &&
			builder.includes('"to": "LICENSES.chromium.html"'),
		"The exact Electron Chromium licence inventory must ship as a standalone resource",
	);
	const cursorSource = fs.readFileSync(path.join(root, "src/lib/cursor/cursorThemes.ts"), "utf8");
	requireValue(
		/export const CURSOR_THEMES:\s*readonly CursorTheme\[\]\s*=\s*\[\s*\]/.test(cursorSource),
		"Unreviewed cursor themes must not be selectable",
	);
}

function componentKey(component) {
	return [component.ecosystem, component.name, component.version, component.source ?? ""].join(
		"\0",
	);
}

export function buildReviewedNoticeInventory({ releaseInventory, assetPolicy, texts = [] }) {
	const reviewed = new Map();
	for (const component of releaseInventory.components) {
		if (!THIRD_PARTY_ECOSYSTEMS.has(component.ecosystem)) continue;
		if (component.ecosystem === "cargo" && component.source === "workspace") continue;
		requireValue(component.license, `Third-party component has no licence: ${component.id}`);
		const ships =
			component.scope !== "excluded" && component.distributionStatus !== "excluded-from-release";
		const key = componentKey(component);
		const previous = reviewed.get(key);
		const entry = previous ?? {
			ecosystem: component.ecosystem,
			name: component.name,
			version: component.version,
			license: component.license,
			source: component.source,
			licenseEvidence: component.licenseEvidence,
			scopes: [],
			ships: false,
		};
		if (entry.license !== component.license) {
			throw new Error(`Conflicting licence claims for ${component.name}@${component.version}`);
		}
		if (!entry.scopes.includes(component.scope)) entry.scopes.push(component.scope);
		entry.ships ||= ships;
		reviewed.set(key, entry);
	}
	const normalize = (entries) =>
		entries
			.map(({ ships: _ships, ...entry }) => ({ ...entry, scopes: entry.scopes.sort() }))
			.sort((a, b) => componentKey(a).localeCompare(componentKey(b)));
	const entries = [...reviewed.values()];
	return {
		schemaVersion: 1,
		product: releaseInventory.product,
		generatedFrom: [
			"package-lock.json",
			"supply-chain/cargo-license-inventory.json",
			"supply-chain/cargo-license-supplements.json",
			"electron/native/parakeet-stt/Package.resolved",
			"electron/stt/modelManager.ts",
			"supply-chain/model-rights.json",
			"scripts/ffmpeg-pins.mjs",
			"supply-chain/web-demuxer.json",
			"supply-chain/bundled-assets.json",
		],
		components: normalize(entries.filter((entry) => entry.ships)),
		assets: assetPolicy.included.map((group) => ({
			id: group.id,
			paths: group.paths,
			license: group.license,
			source: group.source,
		})),
		licenseTexts: texts,
		excluded: {
			components: normalize(entries.filter((entry) => !entry.ships)),
			assets: assetPolicy.excluded,
		},
	};
}

export async function generateThirdPartyInventory({ root = DEFAULT_ROOT } = {}) {
	const assetPolicy = readJson(path.join(root, "supply-chain", "bundled-assets.json"));
	verifyBundledAssetPolicy(root, assetPolicy);
	const releaseInventory = await buildReleaseInventory({ root, sourceSha: FIXED_SOURCE_SHA });
	return buildReviewedNoticeInventory({
		releaseInventory,
		assetPolicy,
		texts: collectLicenseTexts(root),
	});
}

export async function verifyThirdPartyInventory({ root = DEFAULT_ROOT } = {}) {
	const expected = `${JSON.stringify(await generateThirdPartyInventory({ root }), null, "\t")}\n`;
	const actual = fs.readFileSync(path.join(root, OUTPUT_FILE), "utf8");
	if (actual !== expected) {
		throw new Error(
			"Third-party inventory is stale. Run: node scripts/generate-third-party-inventory.mjs --write",
		);
	}
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	if (process.argv.includes("--write")) {
		const inventory = await generateThirdPartyInventory();
		await writeFile(
			path.join(DEFAULT_ROOT, OUTPUT_FILE),
			`${JSON.stringify(inventory, null, "\t")}\n`,
			"utf8",
		);
		console.log(
			`Third-party inventory: ${portable(path.join(DEFAULT_ROOT, OUTPUT_FILE))} (${inventory.components.length} components)`,
		);
	} else {
		await verifyThirdPartyInventory();
		console.log("Third-party inventory is complete and current");
	}
}
