#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	discoverDependencyInputs,
	verifyApprovedDependencies,
} from "./check-approved-dependencies.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = path.join("supply-chain", "approved-dependency-inputs.json");
const NAMESPACE = "klippt-dependency-approval";

export function refreshApprovalBaseline(root, reviewedAt) {
	const policyPath = path.join(root, POLICY);
	const previous = JSON.parse(fs.readFileSync(policyPath, "utf8")).inputs;
	const inputs = Object.fromEntries(
		discoverDependencyInputs(root).map((relativePath) => [
			relativePath,
			createHash("sha256")
				.update(fs.readFileSync(path.join(root, relativePath)))
				.digest("hex"),
		]),
	);
	const changed = Object.keys({ ...previous, ...inputs })
		.filter((relativePath) => previous[relativePath] !== inputs[relativePath])
		.sort();
	fs.writeFileSync(
		policyPath,
		`${JSON.stringify({ schemaVersion: 1, reviewedAt, inputs }, null, "\t")}\n`,
	);
	return changed;
}

export function requireSigningKey(keyPath) {
	if (!fs.existsSync(keyPath)) {
		throw new Error(
			`No approval key at ${keyPath}. See docs/dependency-approval-signing.md for what to do.`,
		);
	}
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const keyPath = path.join(os.homedir(), ".ssh", "klippt_dependency_approval");
	requireSigningKey(keyPath);
	const changed = refreshApprovalBaseline(DEFAULT_ROOT, new Date().toISOString().slice(0, 10));
	console.log(`Inputs you are approving (${changed.length}):`);
	for (const relativePath of changed) console.log(`  ${relativePath}`);
	const policyPath = path.join(DEFAULT_ROOT, POLICY);
	fs.rmSync(`${policyPath}.sig`, { force: true });
	execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", NAMESPACE, policyPath], {
		stdio: "inherit",
	});
	const result = verifyApprovedDependencies(DEFAULT_ROOT);
	console.log(`Signature verified for ${result.count} inputs.`);
	execFileSync(process.execPath, ["scripts/generate-third-party-inventory.mjs", "--write"], {
		cwd: DEFAULT_ROOT,
		stdio: "inherit",
	});
}
