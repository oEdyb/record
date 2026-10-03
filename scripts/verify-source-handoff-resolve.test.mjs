import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("enforces owned Resolve project creation and rejects failed or unlinked imports", () => {
	const file = fileURLToPath(new URL("./verify-source-handoff-resolve.test.py", import.meta.url));
	expect(() => execFileSync("python3", ["-B", file], { stdio: "pipe" })).not.toThrow();
});
