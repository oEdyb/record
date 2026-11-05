import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const directories = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
it.skipIf(process.platform !== "linux").each([true, false])(
	"stages OpenMP repeatedly through a symlinked build output (already staged: %s)",
	async (alreadyStaged) => {
		const root = await mkdtemp(path.join(os.tmpdir(), "whisper-repeat-"));
		directories.push(root);
		const real = path.join(root, "real"),
			alias = path.join(root, "alias");
		await mkdir(real);
		await symlink(real, alias);
		const compiler = path.join(root, "compiler");
		await mkdir(compiler);
		const runtime = path.join(alreadyStaged ? real : compiler, "libgomp.so.1");
		await writeFile(runtime, "original runtime");
		const script = await readFile(new URL("./build-whisper-stt.sh", import.meta.url), "utf8");
		const stanza = script.match(
			/ {2}if \[\[ "\$\{OS_ARCH\}" == linux-\* \]\]; then\n[\s\S]*?\n {2}fi/,
		);
		expect(stanza).not.toBeNull();
		const run = () =>
			execFileSync(
				"bash",
				[
					"-c",
					`set -euo pipefail
ldd() { printf 'libgomp.so.1 => %s (0x0)\\n' "$RUNTIME"; }
stage() { ${stanza[0]}\n}
stage`,
				],
				{
					env: {
						...process.env,
						OS_ARCH: "linux-x64",
						OUT_DIR: alias,
						RUNTIME: runtime,
						out_bin_name: "whisper-stt-server",
					},
					encoding: "utf8",
				},
			);
		expect(run).not.toThrow();
		expect(run).not.toThrow();
		expect(await readFile(runtime, "utf8")).toBe("original runtime");
		expect(await readFile(path.join(alias, "libgomp.so.1"), "utf8")).toBe("original runtime");
	},
);
