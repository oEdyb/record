import { describe, expect, it } from "vitest";
import { buildResolvedEdit } from "./context";
import { editFixture } from "./fixtures";
import { runChecks } from "./index";
import { CHECK_REPLY_MAX_BYTES, pageChecks } from "./page";
import type { Finding } from "./types";

function fixture(count: number, message = "Removed region") {
	const result = runChecks(buildResolvedEdit(editFixture()), { rule: "region.off-cut" });
	result.findings = Array.from(
		{ length: count },
		(_, at): Finding => ({
			rule: "region.off-cut",
			severity: "info",
			at,
			span: { startSec: at, endSec: at },
			clip: "clip",
			message: `${message} ${at}`,
			fix: null,
		}),
	);
	result.total = count;
	result.counts = { error: 0, warning: 0, info: count, byRule: { "region.off-cut": count } };
	return result;
}
describe("check reply pages", () => {
	it("pages 2000 findings without losing counts or exceeding 48 KiB envelopes", () => {
		const result = fixture(2000);
		const seen: number[] = [];
		for (let page = 1; page <= 40; page++) {
			const reply = {
				api_version: "1.0",
				request_id: "r".repeat(256),
				status: "completed",
				data: {
					status: "ready",
					revision: "r".repeat(256),
					documentHash: "a".repeat(64),
					audio: { ready: 39, pending: 0 },
					result: pageChecks(result, { page }),
				},
			};
			const body = JSON.stringify(reply);
			expect(Buffer.byteLength(body)).toBeLessThan(CHECK_REPLY_MAX_BYTES);
			expect(reply.data.result).toMatchObject({
				total: 2000,
				page,
				pages: 40,
				counts: { info: 2000, byRule: { "region.off-cut": 2000 } },
			});
			expect(Object.keys(reply.data.result).slice(0, 4)).toEqual([
				"counts",
				"total",
				"page",
				"pages",
			]);
			seen.push(...reply.data.result.findings.map((item) => item.at));
		}
		expect(seen).toEqual(result.findings.map((item) => item.at));
	});
	it("bounds UTF-8 details, fixes and notes without cutting JSON or dropping findings", () => {
		const result = fixture(2000, '🔥"'.repeat(100));
		result.findings[0].message = '🔥"'.repeat(10000);
		result.findings[0].fix = [{ type: "removeModifier", args: { id: "x".repeat(50000) } }];
		result.notes = Array.from({ length: 2000 }, () => '🔥"'.repeat(500));
		const first = pageChecks(result);
		let seen = 0;
		for (let page = 1; page <= first.pages; page++) {
			const reply = pageChecks(result, { page });
			expect(Buffer.byteLength(JSON.stringify({ api_version: "1.0", data: reply }))).toBeLessThan(
				CHECK_REPLY_MAX_BYTES,
			);
			seen += reply.findings.length;
		}
		expect(seen).toBe(2000);
		expect(first.findings[0].fix).toBeNull();
		expect(first.findings[0].message).toContain("Oversized detail omitted");
		expect(first.notesOmitted).toBeGreaterThan(0);
	});
	it("honors smaller pages and gives an empty page beyond the end", () => {
		expect(pageChecks(fixture(25), { page: 2, page_size: 10 })).toMatchObject({
			page: 2,
			pages: 3,
			page_size: 10,
		});
		expect(pageChecks(fixture(25), { page: 4, page_size: 10 }).findings).toEqual([]);
	});
});
