import { describe, expect, it } from "vitest";
import { RecordRequestTrace } from "./recordRequestTrace";

describe("local Record request trace", () => {
	it("correlates dispatch and receipt without exposing mutable ring entries", () => {
		const trace = new RecordRequestTrace();
		const token = trace.begin({ pillPresent: true });
		trace.add(token, "receipt", { starting: false });
		const entries = trace.read();
		expect(entries.map(({ token: id, stage }) => [id, stage])).toEqual([
			[token, "dispatch"],
			[token, "receipt"],
		]);
		entries[0].flags.pillPresent = false;
		expect(trace.read()[0].flags.pillPresent).toBe(true);
	});
	it("bounds retained entries and rejects invalid request tokens", () => {
		const trace = new RecordRequestTrace();
		for (let i = 0; i < 300; i++) trace.begin({});
		trace.add(NaN, "invalid");
		expect(trace.read()).toHaveLength(256);
		expect(trace.read()[0].token).toBe(45);
	});
});
