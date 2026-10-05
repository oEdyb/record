import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIGH_SEVERITIES = new Set(["high", "critical"]);

function activeAdvisories(audit) {
	const advisories = new Map();
	for (const [packageName, vulnerability] of Object.entries(audit.vulnerabilities ?? {})) {
		for (const item of vulnerability.via ?? []) {
			if (typeof item === "string" || !HIGH_SEVERITIES.has(item.severity)) continue;
			const source = String(item.source);
			advisories.set(source, {
				source,
				package: item.name ?? packageName,
				severity: item.severity,
				url: item.url,
			});
		}
	}
	return advisories;
}

export const AUDIT_SCOPES = {
	website: { prefix: "website", scope: "website-build-only", label: "Website" },
	desktop: { prefix: ".", scope: "desktop-build-only", label: "Desktop" },
};

export function checkWebsiteAudit(audit, policy, target = AUDIT_SCOPES.website) {
	if (audit.error)
		throw new Error(`npm audit failed: ${audit.error.summary ?? audit.error.message}`);
	if (policy.schemaVersion !== 1 || !Array.isArray(policy.exceptions)) {
		throw new Error("Unsupported npm advisory exception policy");
	}
	const active = activeAdvisories(audit);
	const exceptions = new Map(
		policy.exceptions
			.filter((entry) => entry.scope === target.scope)
			.map((entry) => [String(entry.source), entry]),
	);
	const problems = [];
	for (const [source, advisory] of active) {
		const exception = exceptions.get(source);
		if (!exception) {
			problems.push(
				`new ${advisory.severity} advisory ${source} in ${advisory.package}: ${advisory.url}`,
			);
			continue;
		}
		for (const field of ["package", "severity", "url"]) {
			if (exception[field] !== advisory[field]) {
				problems.push(
					`advisory ${source} changed ${field}: expected ${exception[field]}, got ${advisory[field]}`,
				);
			}
		}
		if (!exception.reason || !exception.reviewedOn) {
			problems.push(`advisory ${source} does not have a complete reviewed exception`);
		}
	}
	for (const source of exceptions.keys()) {
		if (!active.has(source))
			problems.push(`advisory exception ${source} is no longer active; remove it`);
	}
	if (problems.length > 0)
		throw new Error(`${target.label} dependency audit failed:\n- ${problems.join("\n- ")}`);
	return { activeExceptions: [...active.keys()].sort(), metadata: audit.metadata?.vulnerabilities };
}

export function runWebsiteAudit(root = ROOT, target = AUDIT_SCOPES.website) {
	const result = spawnSync("npm", ["audit", "--json", "--prefix", target.prefix], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	let audit;
	try {
		audit = JSON.parse(result.stdout);
	} catch {
		throw new Error(`npm audit did not return JSON:\n${result.stderr || result.stdout}`);
	}
	const policy = JSON.parse(
		fs.readFileSync(path.join(root, "supply-chain/npm-advisory-exceptions.json"), "utf8"),
	);
	return checkWebsiteAudit(audit, policy, target);
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const target = process.argv.includes("--desktop") ? AUDIT_SCOPES.desktop : AUDIT_SCOPES.website;
	const result = runWebsiteAudit(ROOT, target);
	console.log(
		`${target.label} audit: ${result.activeExceptions.length} reviewed high-severity build-only advisories; no unreviewed high or critical advisory`,
	);
}
