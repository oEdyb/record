import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSemgrepCppRules, verifySemgrepCppCoverage } from "./prepare-semgrep-cpp-rules.mjs";

const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Semgrep C++ coverage", () => {
	it("converts pinned C language declarations to the C++ parser", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "klippt-semgrep-cpp-"));
		temporaryDirectories.push(root);
		const source = path.join(root, "c");
		const output = path.join(root, "cpp");
		await mkdir(source);
		await writeFile(
			path.join(source, "inline.yaml"),
			"rules:\n  - id: inline\n    languages: [c]\n    pattern: gets(...)\n",
		);
		await writeFile(
			path.join(source, "list.yml"),
			"rules:\n  - id: list\n    languages:\n      - c\n    pattern: strcpy(...)\n",
		);

		await expect(prepareSemgrepCppRules(source, output)).resolves.toBe(2);
		expect(await readFile(path.join(output, "inline.yaml"), "utf8")).toContain("languages: [cpp]");
		expect(await readFile(path.join(output, "list.yml"), "utf8")).toContain("- cpp");
	});

	it("fails when a tracked C++ source is absent from the Semgrep report", () => {
		const report = { paths: { scanned: ["native/first.cpp"] } };
		expect(() =>
			verifySemgrepCppCoverage(report, ["native/first.cpp", "native/second.cpp"]),
		).toThrow(/native\/second\.cpp/);
		verifySemgrepCppCoverage(report, ["native/first.cpp"]);
	});
});
