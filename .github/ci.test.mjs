import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const readYaml = (file) => parse(readFileSync(path.join(import.meta.dirname, file), "utf8"));
const ci = readYaml("workflows/ci.yml");
const setup = readYaml("actions/setup/action.yml");

describe("CI resource use", () => {
	it("cancels only superseded PR checks and gives each push a unique group", () => {
		expect(ci.concurrency).toEqual({
			group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
			"cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
		});
	});

	it("skips Electron only for checks that do not read or launch its runtime", () => {
		expect(setup.inputs.electron.default).toBe("true");
		expect(setup.runs.steps.find((step) => step.run === "npx install-electron --no").if).toBe(
			"inputs.electron == 'true'",
		);
		for (const job of ["lint", "typecheck", "typecheck-tests"]) {
			expect(
				ci.jobs[job].steps.find((step) => step.uses === "./.github/actions/setup").with.electron,
			).toBe("false");
		}
		for (const job of ["test", "build"]) {
			expect(
				ci.jobs[job].steps.find((step) => step.uses === "./.github/actions/setup").with?.electron,
			).not.toBe("false");
		}
	});

	it("keeps native gates and isolates cached targets by platform, compiler, lock and SDK", () => {
		for (const platform of ["macos", "windows", "linux"]) {
			const job = ci.jobs[`rust-${platform}-compositor-check`];
			const cache = job.steps.find((step) => step.uses?.startsWith("actions/cache@"));
			expect(cache.uses).toMatch(/^actions\/cache@[a-f0-9]{40}$/);
			for (const input of [
				"runner.os",
				"runner.arch",
				"outputs.toolchain",
				"outputs.sdk",
				"crates/Cargo.lock",
				"scripts/ffmpeg-pins.mjs",
			]) {
				expect(cache.with.key).toContain(input);
				expect(cache.with["restore-keys"]).toContain(input);
			}
			expect(cache.with.path).toContain("crates/target");
			expect(job.steps.some((step) => /cargo (test|check)/.test(step.run ?? ""))).toBe(true);
		}
	});
});
