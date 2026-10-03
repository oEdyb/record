import { describe, expect, it, vi } from "vitest";
import { buildResolvedEdit } from "../checks/context";
import { editFixture } from "../checks/fixtures";
import { runChecks } from "../checks/index";
import { createCheckAnalysisCache } from "./agentCheckAnalysis";

describe("cached check runs", () => {
	it("polls one analysis and invalidates unsaved document changes", async () => {
		const request = createCheckAnalysisCache();
		const document = editFixture();
		const analyze = vi.fn(async () =>
			runChecks(buildResolvedEdit(document), { rule: "camera.nested" }),
		);
		const run = request(document, "revision", {}, {}, analyze);
		expect(run.status).toBe("analyzing");
		expect(request(document, "revision", {}, {}, analyze)).toBe(run);
		await vi.waitFor(() => expect(run.status).toBe("ready"));
		expect(analyze).toHaveBeenCalledTimes(1);
		document.project.title = "Unsaved change";
		expect(request(document, "revision", {}, {}, analyze)).not.toBe(run);
	});
	it("retains a failed run for polling", async () => {
		const request = createCheckAnalysisCache();
		const document = editFixture();
		const analyze = vi.fn(async () => {
			throw new Error("bad peaks");
		});
		const run = request(document, "revision", {}, {}, analyze);
		await vi.waitFor(() => expect(run.status).toBe("error"));
		expect(run.error).toBe("bad peaks");
		expect(request(document, "revision", {}, {}, analyze)).toBe(run);
	});
});

it("reuses a run across pages and exposes partial findings synchronously", async () => {
	const request = createCheckAnalysisCache();
	const document = editFixture();
	const result = runChecks(buildResolvedEdit(document), { rule: "camera.nested" });
	let finish = () => undefined;
	const analyze = vi.fn((progress) => {
		progress({
			result,
			audio: { ready: 0, pending: 2 },
			timings: { elapsedMs: 2, peaksMs: 0, speechMs: 0 },
		});
		return new Promise<typeof result>((resolve) => {
			finish = () => {
				resolve(result);
				return undefined;
			};
		});
	});
	const run = request(document, "revision", { page: 1 }, { a: true, b: false }, analyze);
	expect(run).toMatchObject({ status: "analyzing", result, audio: { ready: 0, pending: 2 } });
	expect(
		request(document, "revision", { page: 2, page_size: 10 }, { b: false, a: true }, analyze),
	).toBe(run);
	expect(analyze).toHaveBeenCalledTimes(1);
	finish();
	await vi.waitFor(() => expect(run.status).toBe("ready"));
});
