import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCargoLockfiles } from "./check-cargo-graphs.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SHA256 = /^[0-9a-f]{64}$/;
const DEPENDENCY_APPROVAL_IDENTITY = "olle@klippt.app";
const DEPENDENCY_APPROVAL_NAMESPACE = "klippt-dependency-approval";
const SKIPPED_DIRECTORIES = new Set([
	".build",
	".cache",
	".git",
	"build",
	"dist",
	"dist-electron",
	"node_modules",
	"release",
	"target",
]);

function portable(relativePath) {
	return relativePath.split(path.sep).join("/");
}

function discoverNamedFiles(root, names) {
	const discovered = [];
	const pending = [root];
	while (pending.length) {
		const directory = pending.pop();
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path.join(directory, entry.name));
				continue;
			}
			if (entry.isFile() && names.has(entry.name)) {
				discovered.push(portable(path.relative(root, path.join(directory, entry.name))));
			}
		}
	}
	return discovered.sort();
}

export function discoverDependencyInputs(root) {
	const npmShrinkwraps = discoverNamedFiles(root, new Set(["npm-shrinkwrap.json"]));
	if (npmShrinkwraps.length > 0) {
		throw new Error(
			`npm-shrinkwrap.json is not allowed because npm gives it precedence over the approved package-lock.json: ${npmShrinkwraps.join(", ")}`,
		);
	}
	return [
		"electron/stt/modelManager.ts",
		"scripts/ffmpeg-pins.mjs",
		...discoverCargoLockfiles(root),
		...discoverNamedFiles(
			root,
			new Set(["Cargo.toml", "package-lock.json", "Package.resolved", "Package.swift"]),
		),
	].sort();
}

function sha256File(filePath) {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function verifyDependencyApprovalSignature(root = DEFAULT_ROOT) {
	const supplyChainDirectory = path.join(root, "supply-chain");
	const policyPath = path.join(supplyChainDirectory, "approved-dependency-inputs.json");
	const signaturePath = `${policyPath}.sig`;
	const publicKeyPath = path.join(supplyChainDirectory, "dependency-approval-key.pub");
	if (!fs.existsSync(signaturePath) || !fs.existsSync(publicKeyPath)) {
		throw new Error("Dependency approval signature or public key is missing");
	}
	const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
	if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
		throw new Error("Dependency approval public key must contain one exact Ed25519 key");
	}
	const signature = fs.readFileSync(signaturePath, "utf8");
	if (
		!signature.startsWith("-----BEGIN SSH SIGNATURE-----\n") ||
		!signature.endsWith("-----END SSH SIGNATURE-----\n") ||
		(signature.match(/-----BEGIN SSH SIGNATURE-----/g) ?? []).length !== 1
	) {
		throw new Error("Dependency approval signature must contain one SSH signature");
	}

	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "klippt-approval-"));
	try {
		const allowedSignersPath = path.join(temporaryDirectory, "allowed_signers");
		fs.writeFileSync(
			allowedSignersPath,
			`${DEPENDENCY_APPROVAL_IDENTITY} namespaces="${DEPENDENCY_APPROVAL_NAMESPACE}" ${publicKey}\n`,
			{ mode: 0o600 },
		);
		execFileSync(
			"ssh-keygen",
			[
				"-Y",
				"verify",
				"-f",
				allowedSignersPath,
				"-I",
				DEPENDENCY_APPROVAL_IDENTITY,
				"-n",
				DEPENDENCY_APPROVAL_NAMESPACE,
				"-s",
				signaturePath,
			],
			{ input: fs.readFileSync(policyPath), stdio: ["pipe", "ignore", "pipe"] },
		);
	} catch {
		throw new Error("Dependency approval signature is invalid");
	} finally {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

export function verifyApprovedDependencies(root = DEFAULT_ROOT) {
	const discovered = discoverDependencyInputs(root);
	verifyDependencyApprovalSignature(root);
	const policy = JSON.parse(
		fs.readFileSync(path.join(root, "supply-chain", "approved-dependency-inputs.json"), "utf8"),
	);
	if (policy.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(policy.reviewedAt ?? "")) {
		throw new Error("Invalid approved dependency policy metadata");
	}
	if (!policy.inputs || typeof policy.inputs !== "object" || Array.isArray(policy.inputs)) {
		throw new Error("Approved dependency inputs must be an object");
	}
	const approved = Object.keys(policy.inputs).sort();
	if (JSON.stringify(discovered) !== JSON.stringify(approved)) {
		throw new Error(
			`Dependency approval policy is stale. Discovered ${JSON.stringify(discovered)}; approved ${JSON.stringify(approved)}`,
		);
	}
	for (const relativePath of discovered) {
		const expected = policy.inputs[relativePath];
		if (!SHA256.test(expected ?? "")) {
			throw new Error(`Invalid approved SHA-256 for ${relativePath}`);
		}
		const actual = sha256File(path.join(root, relativePath));
		if (actual !== expected) {
			throw new Error(
				`${relativePath} changed without dependency approval. Expected ${expected}; found ${actual}`,
			);
		}
	}
	return { count: discovered.length, reviewedAt: policy.reviewedAt };
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	if (process.argv.length !== 2) throw new Error("This checker does not accept arguments");
	const result = verifyApprovedDependencies();
	console.log(`${result.count} dependency inputs match the ${result.reviewedAt} approval baseline`);
}
