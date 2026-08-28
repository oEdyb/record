import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverCargoLockfiles,
	loadCargoGraphs,
	renderCargoDenyConfig,
} from "./check-cargo-graphs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Cargo graph policy", () => {
	it("covers every independent Cargo lockfile in the repository", () => {
		const graphs = loadCargoGraphs(REPO_ROOT);
		expect(graphs.map((graph) => graph.lockfile).sort()).toEqual(discoverCargoLockfiles(REPO_ROOT));
	});

	it("fails closed when a new Cargo graph has no policy", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "klippt-cargo-graphs-"));
		temporaryDirectories.push(root);
		await mkdir(path.join(root, "supply-chain"), { recursive: true });
		await mkdir(path.join(root, "native"), { recursive: true });
		await writeFile(
			path.join(root, "supply-chain", "cargo-graphs.json"),
			JSON.stringify([
				{
					lockfile: "Cargo.lock",
					manifest: "Cargo.toml",
					scope: "required",
					advisoryIgnores: [],
				},
			]),
		);
		await writeFile(path.join(root, "Cargo.lock"), "");
		await writeFile(path.join(root, "Cargo.toml"), "[package]\nname='fixture'\nversion='1.0.0'\n");
		await writeFile(path.join(root, "native", "Cargo.lock"), "");
		await writeFile(
			path.join(root, "native", "Cargo.toml"),
			"[package]\nname='new'\nversion='1.0.0'\n",
		);
		expect(() => loadCargoGraphs(root)).toThrow(/Cargo graph policy is stale/);
	});

	it("renders advisory exceptions only for their owning graph", async () => {
		const output = path.join(await mkdtemp(path.join(os.tmpdir(), "klippt-deny-")), "deny.toml");
		temporaryDirectories.push(path.dirname(output));
		await renderCargoDenyConfig({
			root: REPO_ROOT,
			lockfile: "crates/Cargo.lock",
			output,
		});
		const compositorPolicy = await readFile(output, "utf8");
		expect(compositorPolicy).toContain("RUSTSEC-2026-0192");
		expect(compositorPolicy).not.toContain("RUSTSEC-2026-0217");

		await renderCargoDenyConfig({
			root: REPO_ROOT,
			lockfile: "electron/native/clean-voice/Cargo.lock",
			output,
		});
		const cleanVoicePolicy = await readFile(output, "utf8");
		expect(cleanVoicePolicy).toContain("RUSTSEC-2026-0217");
		expect(cleanVoicePolicy).not.toContain("RUSTSEC-2026-0192");
	});
});
