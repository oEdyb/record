import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshApprovalBaseline, requireSigningKey } from "./approve-dependencies.mjs";

const roots = [];

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "klippt-approve-"));
	roots.push(root);
	await mkdir(path.join(root, "supply-chain"));
	await mkdir(path.join(root, "electron", "stt"), { recursive: true });
	await mkdir(path.join(root, "scripts"));
	await writeFile(path.join(root, "electron/stt/modelManager.ts"), "models");
	await writeFile(path.join(root, "scripts/ffmpeg-pins.mjs"), "pins");
	await writeFile(path.join(root, "package-lock.json"), "lock");
	await writeFile(
		path.join(root, "supply-chain/approved-dependency-inputs.json"),
		JSON.stringify({
			schemaVersion: 1,
			reviewedAt: "2026-01-01",
			inputs: { "package-lock.json": "stale", "removed/Cargo.lock": "gone" },
		}),
	);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dependency approval preparation", () => {
	it("records current hashes and reports every changed, added and removed input", async () => {
		const root = await fixture();
		const changed = refreshApprovalBaseline(root, "2026-11-03");
		expect(changed).toEqual([
			"electron/stt/modelManager.ts",
			"package-lock.json",
			"removed/Cargo.lock",
			"scripts/ffmpeg-pins.mjs",
		]);
		const policy = JSON.parse(
			await readFile(path.join(root, "supply-chain/approved-dependency-inputs.json"), "utf8"),
		);
		expect(policy.reviewedAt).toBe("2026-11-03");
		expect(Object.keys(policy.inputs)).not.toContain("removed/Cargo.lock");
		expect(policy.inputs["package-lock.json"]).toMatch(/^[0-9a-f]{64}$/);
	});

	it("stops with a pointer to the docs when the approval key is absent", () => {
		expect(() => requireSigningKey("/nonexistent/klippt_dependency_approval")).toThrow(
			/dependency-approval-signing\.md/,
		);
	});
});
