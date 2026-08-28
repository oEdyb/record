import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWorkflowActionPins } from "./check-workflow-action-pins.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow action pins", () => {
	it("accepts every current workflow and local action", () => {
		expect(verifyWorkflowActionPins(REPO_ROOT)).toBeGreaterThan(10);
	});

	it("rejects a mutable action tag", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "klippt-action-pins-"));
		roots.push(root);
		mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(
			path.join(root, ".github", "workflows", "release.yml"),
			"steps:\n  - uses: actions/checkout@v7\n",
		);
		expect(() => verifyWorkflowActionPins(root)).toThrow(/actions\/checkout@v7/);
	});

	it("allows local actions and exact external commits", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "klippt-action-pins-"));
		roots.push(root);
		mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(
			path.join(root, ".github", "workflows", "release.yml"),
			"steps:\n  - uses: ./.github/actions/setup\n  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n",
		);
		expect(verifyWorkflowActionPins(root)).toBe(1);
	});
});
