#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCargoGraphs } from "./check-cargo-graphs.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const OUTPUT_PATH = "supply-chain/cargo-license-inventory.json";
const EVIDENCE_PATH = "third-party-licenses/Cargo-Evidence.json";
const SUPPLEMENTS_PATH = "supply-chain/cargo-license-supplements.json";
const LEGACY_EVIDENCE_DIRECTORY = "third-party-licenses/cargo";
const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_FILE =
	/^(?:authors|copying|copyright|licen[cs]e|notice|patents|unlicense)(?:[._-].*)?$/i;
const LICENCE_TEXT_FILE = /^(?:copying|licen[cs]e|unlicense)(?:[._-].*)?$/i;
const LICENCE_TEXT_MARKERS = [
	/\bcopyright\b/i,
	/\blicen[cs]e\b/i,
	/\bpermission\b/i,
	/\bredistribution\b/i,
	/\bterms and conditions\b/i,
	/\bwarranty\b/i,
];

const CARGO_STRING_PATTERNS = {
	checksum: /^\s*checksum = ("(?:[^"\\]|\\.)*")/m,
	name: /^\s*name = ("(?:[^"\\]|\\.)*")/m,
	version: /^\s*version = ("(?:[^"\\]|\\.)*")/m,
	source: /^\s*source = ("(?:[^"\\]|\\.)*")/m,
};

function cargoString(block, key) {
	const match = block.match(CARGO_STRING_PATTERNS[key]);
	return match ? JSON.parse(match[1]) : undefined;
}

function packageKey({ name, version, source }) {
	return `${name}\0${version}\0${source}`;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function isFullLicenceText(file) {
	if (!LICENCE_TEXT_FILE.test(path.basename(file))) return false;
	const text = fs.readFileSync(file, "utf8").trim();
	if (/^\.\.?[/\\][^\r\n]+$/.test(text) || Buffer.byteLength(text, "utf8") < 256) {
		return false;
	}
	return LICENCE_TEXT_MARKERS.filter((pattern) => pattern.test(text)).length >= 2;
}

function loadLicenseSupplements(root) {
	const absolute = path.join(root, SUPPLEMENTS_PATH);
	if (!fs.existsSync(absolute)) {
		return { entries: new Map(), licenseTexts: {}, registryChecksums: {}, used: new Set() };
	}
	const policy = JSON.parse(fs.readFileSync(absolute, "utf8"));
	if (
		policy.schemaVersion !== 1 ||
		!policy.licenseTexts ||
		typeof policy.licenseTexts !== "object" ||
		!policy.registryChecksums ||
		typeof policy.registryChecksums !== "object" ||
		!Array.isArray(policy.packages)
	) {
		throw new Error(`Invalid Cargo licence supplement policy: ${SUPPLEMENTS_PATH}`);
	}
	const entries = new Map();
	for (const entry of policy.packages) {
		const key = packageKey(entry);
		if (entries.has(key)) {
			throw new Error(`Duplicate Cargo licence supplement: ${entry.name}@${entry.version}`);
		}
		entries.set(key, entry);
	}
	return {
		entries,
		licenseTexts: policy.licenseTexts,
		registryChecksums: policy.registryChecksums,
		used: new Set(),
	};
}

function expressionIdentifiers(expression) {
	const identifiers = expression.match(/[A-Za-z0-9.-]+/g) ?? [];
	const operators = new Set(["AND", "OR", "WITH"]);
	return [...new Set(identifiers.filter((value) => !operators.has(value)))].sort();
}

function supplementEvidence(root, item, supplements) {
	const key = packageKey(item);
	const entry = supplements.entries.get(key);
	if (!entry) {
		throw new Error(
			`Cargo package has no full licence text or reviewed supplement: ${item.name}@${item.version}`,
		);
	}
	for (const field of ["name", "version", "source", "license", "repository"]) {
		if ((entry[field] ?? undefined) !== (item[field] ?? undefined)) {
			throw new Error(`Cargo licence supplement ${field} mismatch: ${item.name}@${item.version}`);
		}
	}
	if (!/^[0-9a-f]{40}$/.test(entry.upstreamRevision ?? "")) {
		throw new Error(
			`Cargo licence supplement has no exact upstream revision: ${item.name}@${item.version}`,
		);
	}
	const checksumKey = `${item.name}@${item.version}`;
	const approvedChecksum = supplements.registryChecksums[checksumKey];
	if (!SHA256.test(approvedChecksum ?? "") || approvedChecksum !== item.registryChecksum) {
		throw new Error(`Cargo licence supplement registry checksum mismatch: ${checksumKey}`);
	}
	const vcsPath = path.join(path.dirname(item.manifest_path), ".cargo_vcs_info.json");
	if (fs.existsSync(vcsPath)) {
		const packagedRevision = JSON.parse(fs.readFileSync(vcsPath, "utf8")).git?.sha1;
		if (packagedRevision?.toLowerCase() !== entry.upstreamRevision) {
			throw new Error(`Cargo licence supplement upstream revision mismatch: ${checksumKey}`);
		}
	}
	const identifiers = expressionIdentifiers(item.license);
	if (identifiers.includes("MIT") && !(entry.copyright ?? "").trim()) {
		throw new Error(`Cargo MIT supplement has no copyright notice: ${item.name}@${item.version}`);
	}
	const sections = [
		"Reviewed Cargo licence supplement",
		`Package: ${item.name}@${item.version}`,
		`Source: ${item.source}`,
		`Repository: ${item.repository}`,
		`Upstream revision: ${entry.upstreamRevision}`,
		`Registry checksum: ${item.registryChecksum}`,
		`Declared SPDX licence: ${item.license}`,
	];
	for (const identifier of identifiers) {
		const definition = supplements.licenseTexts[identifier];
		if (
			!definition ||
			typeof definition.path !== "string" ||
			!/^[0-9a-f]{64}$/.test(definition.sha256 ?? "")
		) {
			throw new Error(
				`Cargo supplement has no reviewed ${identifier} text: ${item.name}@${item.version}`,
			);
		}
		const absolute = path.join(root, definition.path);
		const bytes = fs.readFileSync(absolute);
		if (sha256(bytes) !== definition.sha256) {
			throw new Error(`Cargo standard licence text hash mismatch: ${definition.path}`);
		}
		let text = bytes.toString("utf8").trimEnd();
		if (identifier === "MIT") {
			if (!text.includes("[copyright holders]")) {
				throw new Error(`Cargo MIT template has no copyright placeholder: ${definition.path}`);
			}
			text = text.replace("[copyright holders]", entry.copyright);
		}
		sections.push(`SPDX licence text: ${identifier}\n\n${text}`);
	}
	const bytes = Buffer.from(`${sections.join("\n\n---\n\n")}\n`, "utf8");
	supplements.used.add(key);
	return {
		path: EVIDENCE_PATH,
		sourceFile: `${item.name}-${item.version}-reviewed-supplement.txt`,
		size: bytes.length,
		sha256: sha256(bytes),
		bytes,
	};
}

function packageEvidence(root, item, supplements) {
	if (!item.manifest_path) {
		throw new Error(`Cargo metadata has no manifest path: ${item.name}@${item.version}`);
	}
	const packageRoot = path.dirname(item.manifest_path);
	const candidates = [];
	if (item.license_file) {
		candidates.push(
			path.isAbsolute(item.license_file)
				? item.license_file
				: path.resolve(packageRoot, item.license_file),
		);
	}
	for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
		if (entry.isFile() && EVIDENCE_FILE.test(entry.name)) {
			candidates.push(path.join(packageRoot, entry.name));
		}
	}
	const formalEvidence = [...new Set(candidates.map((file) => path.resolve(file)))];
	const hasFullLicenceText = formalEvidence.some(isFullLicenceText);
	const evidenceFiles = hasFullLicenceText
		? formalEvidence
		: [
				...formalEvidence,
				item.manifest_path,
				...fs
					.readdirSync(packageRoot, { withFileTypes: true })
					.filter((entry) => entry.isFile() && /^readme(?:[._-].*)?$/i.test(entry.name))
					.map((entry) => path.join(packageRoot, entry.name)),
			];
	const evidence = [...new Set(evidenceFiles.map((file) => path.resolve(file)))]
		.sort()
		.map((file) => {
			const bytes = fs.readFileSync(file);
			const hash = sha256(bytes);
			return {
				path: EVIDENCE_PATH,
				sourceFile: path.basename(file),
				size: bytes.length,
				sha256: hash,
				bytes,
			};
		});
	if (!hasFullLicenceText) evidence.push(supplementEvidence(root, item, supplements));
	return evidence;
}

function serializableEvidence(evidence) {
	return evidence.map(({ bytes: _bytes, ...item }) => item);
}

function lockPackages(lockText) {
	return lockText
		.split("[[package]]")
		.slice(1)
		.map((block) => ({
			checksum: cargoString(block, "checksum"),
			name: cargoString(block, "name"),
			version: cargoString(block, "version"),
			source: cargoString(block, "source"),
		}))
		.filter((item) => item.name && item.version && item.source);
}

function runCargoMetadata(root, graph) {
	return JSON.parse(
		execFileSync(
			"cargo",
			["metadata", "--format-version", "1", "--locked", "--manifest-path", graph.manifest],
			{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		),
	);
}

export function buildCargoLicenseInventory({
	root = DEFAULT_ROOT,
	metadataProvider = runCargoMetadata,
} = {}) {
	const graphs = loadCargoGraphs(root);
	const supplements = loadLicenseSupplements(root);
	const packages = new Map();
	const evidenceContents = new Map();
	for (const graph of graphs) {
		const metadata = metadataProvider(root, graph);
		const metadataPackages = new Map(
			(metadata.packages ?? [])
				.filter((item) => item.source)
				.map((item) => [packageKey(item), item]),
		);
		for (const locked of lockPackages(fs.readFileSync(path.join(root, graph.lockfile), "utf8"))) {
			const item = metadataPackages.get(packageKey(locked));
			if (!item) {
				throw new Error(
					`Cargo metadata does not cover locked package ${locked.name}@${locked.version} in ${graph.lockfile}`,
				);
			}
			if (typeof item.license !== "string" || !item.license.trim()) {
				throw new Error(
					`Cargo package has no SPDX licence expression: ${locked.name}@${locked.version}`,
				);
			}
			const licenseEvidence = packageEvidence(
				root,
				{ ...item, registryChecksum: locked.checksum },
				supplements,
			);
			for (const evidence of licenseEvidence) {
				const previous = evidenceContents.get(evidence.sha256);
				if (previous && !previous.equals(evidence.bytes)) {
					throw new Error(`Cargo licence evidence hash collision: ${evidence.sha256}`);
				}
				evidenceContents.set(evidence.sha256, evidence.bytes);
			}
			const key = packageKey(locked);
			const previous = packages.get(key);
			if (
				previous &&
				(previous.license !== item.license ||
					JSON.stringify(previous.licenseEvidence) !==
						JSON.stringify(serializableEvidence(licenseEvidence)))
			) {
				throw new Error(
					`Cargo package licence evidence changed across graphs: ${locked.name}@${locked.version}`,
				);
			}
			const entry = previous ?? {
				name: locked.name,
				version: locked.version,
				source: locked.source,
				license: item.license,
				licenseEvidence: serializableEvidence(licenseEvidence),
				repository: item.repository ?? undefined,
				graphs: [],
				scopes: [],
			};
			if (!entry.graphs.includes(graph.lockfile)) entry.graphs.push(graph.lockfile);
			if (!entry.scopes.includes(graph.scope)) entry.scopes.push(graph.scope);
			packages.set(key, entry);
		}
	}
	for (const [key, entry] of supplements.entries) {
		if (!supplements.used.has(key)) {
			throw new Error(`Unused Cargo licence supplement: ${entry.name}@${entry.version}`);
		}
	}
	const inventory = {
		schemaVersion: 1,
		graphs: graphs.map(({ lockfile, manifest, scope }) => ({ lockfile, manifest, scope })),
		packages: [...packages.values()]
			.map((item) => ({
				...item,
				graphs: item.graphs.sort(),
				scopes: item.scopes.sort(),
			}))
			.sort((a, b) => packageKey(a).localeCompare(packageKey(b))),
	};
	Object.defineProperty(inventory, "evidenceContents", { value: evidenceContents });
	return inventory;
}

export function readCargoLicenseInventory(root = DEFAULT_ROOT) {
	return JSON.parse(fs.readFileSync(path.join(root, OUTPUT_PATH), "utf8"));
}

export function cargoLicenseFor(inventory, component) {
	return inventory.packages.find(
		(item) =>
			item.name === component.name &&
			item.version === component.version &&
			item.source === component.source,
	)?.license;
}

export function cargoLicenseRecordFor(inventory, component) {
	return inventory.packages.find(
		(item) =>
			item.name === component.name &&
			item.version === component.version &&
			item.source === component.source,
	);
}

function evidenceCatalog(inventory) {
	return {
		schemaVersion: 1,
		encoding: "base64",
		evidence: Object.fromEntries(
			[...inventory.evidenceContents.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([hash, bytes]) => [
					hash,
					{ size: bytes.length, contentBase64: bytes.toString("base64") },
				]),
		),
	};
}

function verifyEvidenceFiles(root, inventory) {
	const expected = `${JSON.stringify(evidenceCatalog(inventory), null, "\t")}\n`;
	const absolute = path.join(root, EVIDENCE_PATH);
	if (!fs.existsSync(absolute) || fs.readFileSync(absolute, "utf8") !== expected) {
		throw new Error(`Cargo licence evidence is missing or stale: ${EVIDENCE_PATH}`);
	}
	if (fs.existsSync(path.join(root, LEGACY_EVIDENCE_DIRECTORY))) {
		throw new Error("Legacy per-file Cargo licence evidence must not remain");
	}
}

export async function verifyCargoLicenseInventory({ root = DEFAULT_ROOT } = {}) {
	const inventory = buildCargoLicenseInventory({ root });
	const expected = `${JSON.stringify(inventory, null, "\t")}\n`;
	const actual = fs.readFileSync(path.join(root, OUTPUT_PATH), "utf8");
	if (actual !== expected) {
		throw new Error(
			`Cargo licence inventory is stale. Run: node scripts/generate-cargo-license-inventory.mjs --write`,
		);
	}
	verifyEvidenceFiles(root, inventory);
}

export async function writeCargoLicenseInventory({ root = DEFAULT_ROOT } = {}) {
	const inventory = buildCargoLicenseInventory({ root });
	const evidenceOutput = path.join(root, EVIDENCE_PATH);
	await mkdir(path.dirname(evidenceOutput), { recursive: true });
	const evidenceTemporary = `${evidenceOutput}.${randomUUID()}.tmp`;
	await writeFile(
		evidenceTemporary,
		`${JSON.stringify(evidenceCatalog(inventory), null, "\t")}\n`,
		"utf8",
	);
	await rename(evidenceTemporary, evidenceOutput);
	await rm(path.join(root, LEGACY_EVIDENCE_DIRECTORY), { recursive: true, force: true });
	const output = path.join(root, OUTPUT_PATH);
	await mkdir(path.dirname(output), { recursive: true });
	const temporary = `${output}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(inventory, null, "\t")}\n`, "utf8");
	await rename(temporary, output);
	return inventory;
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const write = process.argv.includes("--write");
	if (write) {
		const inventory = await writeCargoLicenseInventory();
		console.log(
			`Cargo licence inventory: ${path.join(DEFAULT_ROOT, OUTPUT_PATH)} (${inventory.packages.length} packages, ${inventory.evidenceContents.size} evidence entries)`,
		);
	} else {
		await verifyCargoLicenseInventory();
		console.log("Cargo licence inventory is complete and current");
	}
}
