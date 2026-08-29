import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkReleaseWorkflowContract } from "./check-release-workflow-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function copyWorkflows() {
	const root = await mkdtemp(path.join(os.tmpdir(), "klippt-release-workflow-"));
	temporaryDirectories.push(root);
	await cp(path.join(REPO_ROOT, ".github"), path.join(root, ".github"), { recursive: true });
	await cp(path.join(REPO_ROOT, "package.json"), path.join(root, "package.json"));
	return root;
}

describe("release workflow contract", () => {
	it("binds every package, helper, and feed to one verified source", () => {
		expect(checkReleaseWorkflowContract(REPO_ROOT)).toEqual({ packageJobs: 4, helperJobs: 1 });
	});

	it("rejects a package job that checks out a mutable ref", async () => {
		const root = await copyWorkflows();
		const file = path.join(root, ".github", "workflows", "build.yml");
		const source = await readFile(file, "utf8");
		await writeFile(
			file,
			source.replace(
				"ref: ${{ needs.resolve-source.outputs.source_sha }}",
				"ref: ${{ github.ref_name }}",
			),
		);
		expect(() => checkReleaseWorkflowContract(root)).toThrow(
			/must check out the resolved source SHA/,
		);
	});

	it("rejects a production build that can retain stale compiled chunks", async () => {
		const root = await copyWorkflows();
		const file = path.join(root, "package.json");
		const manifest = JSON.parse(await readFile(file, "utf8"));
		manifest.scripts["build-vite"] = "tsc && vite build";
		await writeFile(file, `${JSON.stringify(manifest, null, "\t")}\n`);
		expect(() => checkReleaseWorkflowContract(root)).toThrow(/clean compiled output/);
	});

	it("rejects a feed that publishes manifests before immutable verification", async () => {
		const root = await copyWorkflows();
		const file = path.join(root, ".github", "workflows", "build.yml");
		const source = await readFile(file, "utf8");
		await writeFile(file, source.replace("--immutable-only", "--all-files"));
		expect(() => checkReleaseWorkflowContract(root)).toThrow(/Immutable public files/);
	});

	it("rejects macOS FFmpeg evidence generated before final app-signature verification", async () => {
		const root = await copyWorkflows();
		const file = path.join(root, ".github", "workflows", "build.yml");
		const source = await readFile(file, "utf8");
		const verifyName = "- name: Verify .app code signature";
		const evidenceName = "- name: Generate native FFmpeg source evidence";
		const verifyIndex = source.indexOf(verifyName);
		const evidenceIndex = source.indexOf(evidenceName, verifyIndex);
		expect(verifyIndex).toBeGreaterThan(0);
		expect(evidenceIndex).toBeGreaterThan(verifyIndex);
		const verifyBlockStart = source.lastIndexOf("      - name:", verifyIndex);
		const evidenceBlockStart = source.lastIndexOf("      - name:", evidenceIndex);
		const evidenceBlockEnd = source.indexOf("\n      - name:", evidenceIndex + evidenceName.length);
		const evidenceBlock = source.slice(evidenceBlockStart, evidenceBlockEnd);
		const changed = `${source.slice(0, verifyBlockStart)}${evidenceBlock}\n${source.slice(
			verifyBlockStart,
			evidenceBlockStart,
		)}${source.slice(evidenceBlockEnd + 1)}`;
		await writeFile(file, changed);
		expect(() => checkReleaseWorkflowContract(root)).toThrow(/final signed app/);
	});

	it("rejects release preparation that creates an unsigned automated tag", async () => {
		const root = await copyWorkflows();
		const file = path.join(root, ".github", "workflows", "prerelease.yml");
		const source = await readFile(file, "utf8");
		await writeFile(
			file,
			source.replace(
				'echo "source_sha=${SOURCE_SHA}" >> "$GITHUB_OUTPUT"',
				'git tag "$RC_TAG"\n          echo "source_sha=${SOURCE_SHA}" >> "$GITHUB_OUTPUT"',
			),
		);
		expect(() => checkReleaseWorkflowContract(root)).toThrow(
			/must prepare a source but never create a tag/,
		);
	});
});
