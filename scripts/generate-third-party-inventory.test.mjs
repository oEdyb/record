import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildReviewedNoticeInventory,
	collectLicenseTexts,
} from "./generate-third-party-inventory.mjs";

const assetPolicy = {
	included: [{ id: "font", paths: ["font.woff2"], license: "OFL-1.1", source: "upstream" }],
	excluded: [{ id: "legacy", paths: ["legacy.png"], license: "LicenseRef-Unconfirmed" }],
};

function releaseInventory(components) {
	return { product: { name: "klippt", version: "1.0.0" }, components };
}

describe("reviewed third-party inventory", () => {
	it("deduplicates shared dependencies and keeps excluded models separate", () => {
		const shared = {
			ecosystem: "cargo",
			name: "shared",
			version: "1.0.0",
			license: "MIT",
			source: "registry+test",
		};
		const inventory = buildReviewedNoticeInventory({
			releaseInventory: releaseInventory([
				{ ...shared, id: "a", scope: "required" },
				{ ...shared, id: "b", scope: "required" },
				{
					id: "model",
					ecosystem: "model",
					name: "evaluation model",
					version: "hash",
					license: "LicenseRef-Distribution-Unconfirmed",
					source: "git+https://example.test/model",
					scope: "excluded",
				},
			]),
			assetPolicy,
		});
		expect(inventory.components).toHaveLength(1);
		expect(inventory.excluded.components).toHaveLength(1);
		expect(inventory.assets[0]).toMatchObject({ id: "font", license: "OFL-1.1" });
	});

	it("rejects any third-party component without a licence claim", () => {
		expect(() =>
			buildReviewedNoticeInventory({
				releaseInventory: releaseInventory([
					{
						id: "missing",
						ecosystem: "npm",
						name: "missing",
						version: "1.0.0",
						scope: "required",
					},
				]),
				assetPolicy,
			}),
		).toThrow(/has no licence/);
	});

	it("does not classify proprietary workspace crates as third-party", () => {
		const inventory = buildReviewedNoticeInventory({
			releaseInventory: releaseInventory([
				{
					id: "workspace",
					ecosystem: "cargo",
					name: "klippt-worker",
					version: "1.0.0",
					source: "workspace",
					license: "LicenseRef-Klippt-Proprietary",
					scope: "required",
				},
			]),
			assetPolicy,
		});
		expect(inventory.components).toEqual([]);
	});

	it("hashes recursive exact licence evidence and the Electron Chromium notice", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "klippt-notices-"));
		mkdirSync(path.join(root, "third-party-licenses", "cargo"), { recursive: true });
		mkdirSync(path.join(root, "node_modules", "electron", "dist"), { recursive: true });
		writeFileSync(path.join(root, "third-party-licenses", "cargo", "MIT.txt"), "MIT");
		writeFileSync(
			path.join(root, "node_modules", "electron", "dist", "LICENSES.chromium.html"),
			"Chromium notices",
		);
		expect(collectLicenseTexts(root)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "LICENSES.chromium.html", size: 16 }),
				expect.objectContaining({ path: "third-party-licenses/cargo/MIT.txt", size: 3 }),
			]),
		);
	});
});
