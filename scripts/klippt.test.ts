import { spawnSync } from "node:child_process";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
	const dir = await realpath(await mkdtemp(path.join(tmpdir(), "klippt-launcher-")));
	dirs.push(dir);
	const root = path.join(dir, "checkout with spaces");
	const cwd = path.join(dir, "caller with spaces");
	const bin = path.join(dir, "bin");
	await Promise.all(
		["scripts", "node_modules/.bin", "dist-electron"].map((name) =>
			mkdir(path.join(root, name), { recursive: true }),
		),
	);
	await mkdir(cwd);
	await mkdir(bin);
	const launcher = path.join(root, "scripts/klippt");
	const electron = path.join(root, "node_modules/.bin/electron");
	const built = path.join(root, "dist-electron/bootstrap.js");
	await copyFile(new URL("./klippt", import.meta.url), launcher);
	await chmod(launcher, 0o755);
	await writeFile(built, "fixture");
	await writeFile(
		electron,
		`#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.KLIPPT_FIXTURE_REPORT, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, tty: process.stdout.isTTY === true
}));
process.stdout.write(process.env.KLIPPT_FIXTURE_STDOUT ?? "{\\"status\\":\\"completed\\"}\\n");
process.stderr.write(process.env.KLIPPT_FIXTURE_STDERR ?? "");
process.exit(Number(process.env.KLIPPT_FIXTURE_EXIT ?? 0));
`,
	);
	await chmod(electron, 0o755);
	const report = path.join(dir, "invocation.json");
	const env = {
		...process.env,
		ELECTRON_RUN_AS_NODE: "1",
		KLIPPT_FIXTURE_REPORT: report,
		PATH: `${bin}${path.delimiter}${process.env.PATH}`,
	};
	return { root, cwd, bin, launcher, electron, built, report, env };
}

describe.skipIf(process.platform === "win32")("klippt development launcher", () => {
	it("preserves non-repo cwd, argument boundaries and the canonical agent prefix", async () => {
		const f = await fixture();
		const args = [
			"agent",
			"plan",
			"--project_id",
			"fixture",
			"--input",
			"cuts with $literal and 'quotes'.json",
		];
		const result = spawnSync(f.launcher, args, { cwd: f.cwd, env: f.env, encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(JSON.parse(await readFile(f.report, "utf8"))).toEqual({
			args: [f.root, ...args, "--json"],
			cwd: f.cwd,
			runAsNode: null,
			tty: false,
		});
	});
	it("follows relative and absolute symlinks when invoked through PATH", async () => {
		const f = await fixture();
		await symlink(f.launcher, path.join(f.bin, "klippt-target"));
		await symlink("klippt-target", path.join(f.bin, "klippt"));
		const result = spawnSync("klippt", ["agent", "skill", "--json"], {
			cwd: f.cwd,
			env: f.env,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(JSON.parse(await readFile(f.report, "utf8")).args).toEqual([
			f.root,
			"agent",
			"skill",
			"--json",
		]);
	});
	it("preserves every stdout line, stderr and a failing exit status", async () => {
		const f = await fixture();
		const stdout = '{"status":"planned"}\n{"status":"failed"}\n';
		const stderr = "fixture diagnostic\n";
		const result = spawnSync(
			f.launcher,
			[
				"agent",
				"apply",
				"--project_id",
				"fixture",
				"--plan_id",
				"plan_fixture",
				"--request_id",
				"request_fixture",
			],
			{
				cwd: f.cwd,
				encoding: "utf8",
				env: {
					...f.env,
					KLIPPT_FIXTURE_STDOUT: stdout,
					KLIPPT_FIXTURE_STDERR: stderr,
					KLIPPT_FIXTURE_EXIT: "7",
				},
			},
		);
		expect(result.status).toBe(7);
		expect(result.stdout).toBe(stdout);
		expect(result.stderr).toBe(stderr);
	});
	it("does not invent a result when the runtime fails without stdout", async () => {
		const f = await fixture();
		const result = spawnSync(f.launcher, ["agent", "skill"], {
			cwd: f.cwd,
			encoding: "utf8",
			env: {
				...f.env,
				KLIPPT_FIXTURE_STDOUT: "",
				KLIPPT_FIXTURE_STDERR: "runtime failed\n",
				KLIPPT_FIXTURE_EXIT: "17",
			},
		});
		expect(result.status).toBe(17);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("runtime failed\n");
	});
	it.each([
		"electron",
		"built",
	] as const)("refuses a missing %s without starting any app", async (missing) => {
		const f = await fixture();
		await rm(f[missing]);
		const result = spawnSync(f.launcher, ["agent", "skill"], {
			cwd: f.cwd,
			env: f.env,
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("npx vite build");
		expect(result.stderr).toContain(f.root);
		await expect(readFile(f.report)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each(
		[[], ["skill"], ["record"]].map((args) => ({ args })),
	)("requires the agent entry instead of opening the GUI: $args", async ({ args }) => {
		const f = await fixture();
		const result = spawnSync(f.launcher, args, { cwd: f.cwd, env: f.env, encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("klippt agent");
		await expect(readFile(f.report)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("makes a bare agent invocation discovery, never a GUI launch", async () => {
		const f = await fixture();
		const result = spawnSync(f.launcher, ["agent"], { cwd: f.cwd, env: f.env, encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(JSON.parse(await readFile(f.report, "utf8")).args).toEqual([
			f.root,
			"agent",
			"guide",
			"--json",
		]);
	});
	it.each([
		false,
		true,
	])("retains terminal output preference (explicit JSON: %s)", async (explicit) => {
		const f = await fixture();
		const args = ["agent", "guide", ...(explicit ? ["--json"] : [])];
		const result = spawnSync(
			"python3",
			[
				"-c",
				"import os,pty,subprocess,sys; master,slave=pty.openpty(); result=subprocess.run(sys.argv[1:],stdout=slave); os.close(slave); os.close(master); sys.exit(result.returncode)",
				f.launcher,
				...args,
			],
			{ cwd: f.cwd, env: f.env, encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(await readFile(f.report, "utf8"))).toMatchObject({
			args: [f.root, ...args],
			tty: true,
		});
	});
});
