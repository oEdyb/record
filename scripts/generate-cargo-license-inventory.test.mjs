import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCargoLicenseInventory } from "./generate-cargo-license-inventory.mjs";

const REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const FULL_MIT = `MIT License

Copyright (c) Dependency authors

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files, to deal in the software without restriction.
The software is provided without warranty of any kind, express or implied.
`;
const FULL_APACHE = `Apache License
Version 2.0, January 2004

Terms and conditions for use, reproduction, and distribution apply. Licensed under the
Apache License, Version 2.0. Unless required by applicable law, software distributed under
the License is distributed on an AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
`;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function writeSupplement(root, { extraPackages = [], license = "MIT OR Apache-2.0" } = {}) {
	const mit = "MIT License\n\nCopyright (c) [copyright holders]\n\nPermission granted.\n";
	const apache = "Apache License\nVersion 2.0\n\nLicensed under the Apache License.\n";
	mkdirSync(path.join(root, "third-party-licenses"), { recursive: true });
	writeFileSync(path.join(root, "third-party-licenses", "Standard-MIT.txt"), mit);
	writeFileSync(path.join(root, "third-party-licenses", "Standard-Apache-2.0.txt"), apache);
	writeFileSync(
		path.join(root, "registry", "dependency-2.0.0", ".cargo_vcs_info.json"),
		JSON.stringify({ git: { sha1: "b".repeat(40) } }),
	);
	writeFileSync(
		path.join(root, "supply-chain", "cargo-license-supplements.json"),
		JSON.stringify({
			schemaVersion: 1,
			registryChecksums: { "dependency@2.0.0": "a".repeat(64) },
			licenseTexts: {
				MIT: {
					path: "third-party-licenses/Standard-MIT.txt",
					sha256: sha256(mit),
				},
				"Apache-2.0": {
					path: "third-party-licenses/Standard-Apache-2.0.txt",
					sha256: sha256(apache),
				},
			},
			packages: [
				{
					name: "dependency",
					version: "2.0.0",
					source: REGISTRY_SOURCE,
					license,
					upstreamRevision: "b".repeat(40),
					copyright: "Dependency authors",
				},
				...extraPackages,
			],
		}),
	);
}

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "klippt-cargo-licenses-"));
	mkdirSync(path.join(root, "crate"), { recursive: true });
	writeFileSync(path.join(root, "crate", "Cargo.toml"), '[package]\nname="app"\nversion="1.0.0"\n');
	writeFileSync(
		path.join(root, "crate", "Cargo.lock"),
		`version = 4

[[package]]
name = "app"
version = "1.0.0"

[[package]]
name = "dependency"
version = "2.0.0"
source = "${REGISTRY_SOURCE}"
checksum = "${"a".repeat(64)}"
`,
	);
	const dependencyRoot = path.join(root, "registry", "dependency-2.0.0");
	mkdirSync(dependencyRoot, { recursive: true });
	writeFileSync(
		path.join(dependencyRoot, "Cargo.toml"),
		'[package]\nname="dependency"\nversion="2.0.0"\nlicense="MIT OR Apache-2.0"\n',
	);
	writeFileSync(path.join(dependencyRoot, "LICENSE-MIT"), FULL_MIT);
	writeFileSync(path.join(dependencyRoot, "LICENSE-APACHE"), FULL_APACHE);
	mkdirSync(path.join(root, "supply-chain"));
	writeFileSync(
		path.join(root, "supply-chain", "cargo-graphs.json"),
		JSON.stringify([
			{
				lockfile: "crate/Cargo.lock",
				manifest: "crate/Cargo.toml",
				scope: "required",
				advisoryIgnores: [],
			},
		]),
	);
	return { root, dependencyRoot };
}

describe("Cargo licence inventory", () => {
	it("records every external locked package and ignores proprietary workspace crates", () => {
		const { root, dependencyRoot } = fixture();
		const inventory = buildCargoLicenseInventory({
			root,
			metadataProvider: () => ({
				packages: [
					{ name: "app", version: "1.0.0", source: null, license: null },
					{
						name: "dependency",
						version: "2.0.0",
						source: "registry+https://github.com/rust-lang/crates.io-index",
						license: "MIT OR Apache-2.0",
						repository: "https://example.test/dependency",
						manifest_path: path.join(dependencyRoot, "Cargo.toml"),
					},
				],
			}),
		});
		expect(inventory.packages).toEqual([
			expect.objectContaining({
				name: "dependency",
				license: "MIT OR Apache-2.0",
				licenseEvidence: [
					expect.objectContaining({
						sourceFile: "LICENSE-APACHE",
						size: Buffer.byteLength(FULL_APACHE),
					}),
					expect.objectContaining({
						sourceFile: "LICENSE-MIT",
						size: Buffer.byteLength(FULL_MIT),
					}),
				],
				scopes: ["required"],
			}),
		]);
	});

	it("fails when a locked third-party crate has no licence expression", () => {
		const { root } = fixture();
		expect(() =>
			buildCargoLicenseInventory({
				root,
				metadataProvider: () => ({
					packages: [
						{
							name: "dependency",
							version: "2.0.0",
							source: "registry+https://github.com/rust-lang/crates.io-index",
							license: null,
						},
					],
				}),
			}),
		).toThrow(/no SPDX licence expression/);
	});

	it("fails when metadata does not cover the exact locked graph", () => {
		const { root } = fixture();
		expect(() =>
			buildCargoLicenseInventory({ root, metadataProvider: () => ({ packages: [] }) }),
		).toThrow(/does not cover locked package/);
	});

	it("fails closed when an old crate omitted licence files and has no reviewed supplement", () => {
		const { root, dependencyRoot } = fixture();
		writeFileSync(path.join(dependencyRoot, "README.md"), "Declared MIT project");
		for (const name of ["LICENSE-MIT", "LICENSE-APACHE"]) {
			rmSync(path.join(dependencyRoot, name));
		}
		expect(() =>
			buildCargoLicenseInventory({
				root,
				metadataProvider: () => ({
					packages: [
						{
							name: "dependency",
							version: "2.0.0",
							source: REGISTRY_SOURCE,
							license: "MIT OR Apache-2.0",
							manifest_path: path.join(dependencyRoot, "Cargo.toml"),
						},
					],
				}),
			}),
		).toThrow(/no full licence text or reviewed supplement/);
	});

	it("does not treat relative-path licence stubs as full licence text", () => {
		const { root, dependencyRoot } = fixture();
		writeFileSync(path.join(dependencyRoot, "LICENSE-MIT"), "../LICENSE-MIT\n");
		writeFileSync(path.join(dependencyRoot, "LICENSE-APACHE"), "../LICENSE-APACHE\n");
		expect(() =>
			buildCargoLicenseInventory({
				root,
				metadataProvider: () => ({
					packages: [
						{
							name: "dependency",
							version: "2.0.0",
							source: REGISTRY_SOURCE,
							license: "MIT OR Apache-2.0",
							manifest_path: path.join(dependencyRoot, "Cargo.toml"),
						},
					],
				}),
			}),
		).toThrow(/no full licence text or reviewed supplement/);
	});

	it("adds complete reviewed licence text when crate metadata is the only declaration", () => {
		const { root, dependencyRoot } = fixture();
		writeFileSync(path.join(dependencyRoot, "README.md"), "Declared MIT or Apache project");
		for (const name of ["LICENSE-MIT", "LICENSE-APACHE"]) {
			rmSync(path.join(dependencyRoot, name));
		}
		writeSupplement(root);
		const inventory = buildCargoLicenseInventory({
			root,
			metadataProvider: () => ({
				packages: [
					{
						name: "dependency",
						version: "2.0.0",
						source: REGISTRY_SOURCE,
						license: "MIT OR Apache-2.0",
						manifest_path: path.join(dependencyRoot, "Cargo.toml"),
					},
				],
			}),
		});
		expect(inventory.packages[0].licenseEvidence.map((item) => item.sourceFile)).toEqual([
			"Cargo.toml",
			"README.md",
			"dependency-2.0.0-reviewed-supplement.txt",
		]);
		const supplement = inventory.evidenceContents.get(
			inventory.packages[0].licenseEvidence.at(-1).sha256,
		);
		expect(supplement.toString("utf8")).toContain("Copyright (c) Dependency authors");
		expect(supplement.toString("utf8")).toContain("SPDX licence text: Apache-2.0");
	});

	it("rejects stale or unused supplement entries", () => {
		const { root, dependencyRoot } = fixture();
		for (const name of ["LICENSE-MIT", "LICENSE-APACHE"]) {
			rmSync(path.join(dependencyRoot, name));
		}
		writeSupplement(root, {
			extraPackages: [
				{
					name: "unused",
					version: "1.0.0",
					source: REGISTRY_SOURCE,
					license: "MIT",
					upstreamRevision: "c".repeat(40),
					copyright: "Unused authors",
				},
			],
		});
		expect(() =>
			buildCargoLicenseInventory({
				root,
				metadataProvider: () => ({
					packages: [
						{
							name: "dependency",
							version: "2.0.0",
							source: REGISTRY_SOURCE,
							license: "MIT OR Apache-2.0",
							manifest_path: path.join(dependencyRoot, "Cargo.toml"),
						},
					],
				}),
			}),
		).toThrow(/Unused Cargo licence supplement/);
	});
});
