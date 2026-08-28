import { describe, expect, it } from "vitest";
import { checkWebsiteAudit } from "./check-website-audit.mjs";

const advisory = {
	source: 42,
	name: "fixture-package",
	severity: "high",
	url: "https://example.test/advisory/42",
};
const policy = {
	schemaVersion: 1,
	exceptions: [
		{
			source: "42",
			package: "fixture-package",
			severity: "high",
			url: advisory.url,
			scope: "website-build-only",
			reviewedOn: "2026-08-28",
			reason: "No patched compatible build-only dependency exists.",
		},
	],
};

function audit(via = [advisory]) {
	return { vulnerabilities: { "fixture-package": { via } } };
}

describe("website npm audit policy", () => {
	it("accepts only the exact reviewed high-severity advisory", () => {
		expect(checkWebsiteAudit(audit(), policy).activeExceptions).toEqual(["42"]);
	});

	it("rejects a new high-severity advisory", () => {
		expect(() =>
			checkWebsiteAudit(
				audit([...audit().vulnerabilities["fixture-package"].via, { ...advisory, source: 99 }]),
				policy,
			),
		).toThrow(/new high advisory 99/);
	});

	it("rejects a stale or broadened exception", () => {
		expect(() => checkWebsiteAudit(audit([]), policy)).toThrow(/no longer active/);
		expect(() =>
			checkWebsiteAudit(audit(), {
				...policy,
				exceptions: [{ ...policy.exceptions[0], package: "another-package" }],
			}),
		).toThrow(/changed package/);
	});
});
