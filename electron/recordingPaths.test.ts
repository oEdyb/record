import path from "node:path";
import { expect, it } from "vitest";
import { recordingsDirectory } from "./recordingPaths";

it("derives recordings from the selected legacy or isolated userData root", () => {
	for (const userData of [
		"/Users/test/Library/Application Support/openscreen",
		"/tmp/isolated run",
	]) {
		expect(recordingsDirectory(userData)).toBe(path.join(userData, "recordings"));
	}
});
