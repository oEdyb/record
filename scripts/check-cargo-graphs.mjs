import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKIPPED_DIRECTORIES = new Set([".claude", ".git", "node_modules", "release", "target"]);
const RUSTSEC_ID = /^RUSTSEC-\d{4}-\d{4}$/;

function portable(relativePath) {
	return relativePath.split(path.sep).join("/");
}

export function discoverCargoLockfiles(root) {
	const discovered = [];
	const pending = [root];
	while (pending.length) {
		const directory = pending.pop();
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path.join(directory, entry.name));
				continue;
			}
			if (entry.isFile() && entry.name === "Cargo.lock") {
				discovered.push(portable(path.relative(root, path.join(directory, entry.name))));
			}
		}
	}
	return discovered.sort();
}

export function loadCargoGraphs(root = DEFAULT_ROOT) {
	const policyPath = path.join(root, "supply-chain", "cargo-graphs.json");
	const graphs = JSON.parse(fs.readFileSync(policyPath, "utf8"));
	if (!Array.isArray(graphs) || graphs.length === 0) {
		throw new Error("supply-chain/cargo-graphs.json must contain at least one graph");
	}
	const configured = [];
	for (const graph of graphs) {
		if (!graph || typeof graph !== "object") throw new Error("Invalid Cargo graph entry");
		if (!["required", "excluded"].includes(graph.scope)) {
			throw new Error(`Invalid Cargo graph scope for ${graph.lockfile}`);
		}
		if (path.basename(graph.lockfile ?? "") !== "Cargo.lock") {
			throw new Error(`Invalid Cargo lockfile path: ${graph.lockfile}`);
		}
		if (path.dirname(graph.lockfile) !== path.dirname(graph.manifest ?? "")) {
			throw new Error(`${graph.lockfile} must use the Cargo.toml in the same graph root`);
		}
		for (const relativePath of [graph.lockfile, graph.manifest]) {
			if (!fs.statSync(path.join(root, relativePath)).isFile()) {
				throw new Error(`Configured Cargo graph file is missing: ${relativePath}`);
			}
		}
		if (!Array.isArray(graph.advisoryIgnores)) {
			throw new Error(`Invalid advisory ignore list for ${graph.lockfile}`);
		}
		for (const advisory of graph.advisoryIgnores) {
			if (!RUSTSEC_ID.test(advisory.id ?? "") || !advisory.reason?.trim()) {
				throw new Error(`Invalid advisory exception for ${graph.lockfile}`);
			}
		}
		configured.push(graph.lockfile);
	}
	if (new Set(configured).size !== configured.length)
		throw new Error("Duplicate Cargo graph policy");
	const discovered = discoverCargoLockfiles(root);
	const expected = [...configured].sort();
	if (JSON.stringify(discovered) !== JSON.stringify(expected)) {
		throw new Error(
			`Cargo graph policy is stale. Discovered ${JSON.stringify(discovered)}; configured ${JSON.stringify(expected)}`,
		);
	}
	return graphs;
}

export async function renderCargoDenyConfig({ root = DEFAULT_ROOT, lockfile, output }) {
	const graph = loadCargoGraphs(root).find((candidate) => candidate.lockfile === lockfile);
	if (!graph) throw new Error(`Unknown Cargo graph: ${lockfile}`);
	const source = fs.readFileSync(path.join(root, "supply-chain", "deny.toml"), "utf8");
	const marker = "ignore = []";
	if (!source.includes(marker)) throw new Error("deny.toml must contain one empty advisory list");
	const renderedIgnores = graph.advisoryIgnores.length
		? `ignore = [\n${graph.advisoryIgnores
				.map(
					(advisory) =>
						`    { id = ${JSON.stringify(advisory.id)}, reason = ${JSON.stringify(advisory.reason)} },`,
				)
				.join("\n")}\n]`
		: marker;
	await mkdir(path.dirname(output), { recursive: true });
	await writeFile(output, source.replace(marker, renderedIgnores), "utf8");
}

function argument(args, name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const args = process.argv.slice(2);
	const lockfile = argument(args, "--render-deny-config");
	if (lockfile) {
		const output = argument(args, "--output");
		if (!output) throw new Error("--render-deny-config requires --output");
		await renderCargoDenyConfig({ lockfile, output: path.resolve(output) });
	} else {
		for (const graph of loadCargoGraphs()) {
			console.log(
				[
					graph.lockfile,
					graph.manifest,
					graph.advisoryIgnores.map((item) => item.id).join(","),
				].join("\t"),
			);
		}
	}
}
