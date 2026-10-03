// @vitest-environment node
import { describe, expect, it } from "vitest";
import { edgesCommandInput } from "./agentEdges";

describe("agent edges phase-4 input", () => {
	it("defaults to staging: no accept reason, remove off", () => {
		const parsed = edgesCommandInput.parse({ project_id: "p" });
		expect(parsed.accept).toBeUndefined();
		expect(parsed.remove).toBe("false");
	});
	it("takes --accept as a reason string, trimmed", () => {
		expect(
			edgesCommandInput.parse({ project_id: "p", accept: " reviewed in staged ", request_id: "r" }),
		).toMatchObject({ accept: "reviewed in staged", request_id: "r" });
	});
	it("rejects a blank --accept reason", () => {
		expect(() => edgesCommandInput.parse({ project_id: "p", accept: "" })).toThrow();
		expect(() => edgesCommandInput.parse({ project_id: "p", accept: "   " })).toThrow();
	});
});
