import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function acquireRecordingTestLock() {
	if (process.platform !== "linux" || process.env.KLIPPT_HEAVY_LOCK_HELD === "1") return;
	const temporary = path.join(os.homedir(), ".cache/klippt-work/tmp");
	mkdirSync(temporary, { recursive: true });
	const child = spawnSync(
		"flock",
		[
			path.join(os.homedir(), ".cache/klippt-heavy.lock"),
			"systemd-run",
			"--user",
			"--scope",
			"-p",
			"MemoryMax=12G",
			"nice",
			"-n",
			"19",
			"ionice",
			"-c3",
			process.execPath,
			...process.argv.slice(1),
		],
		{
			stdio: "inherit",
			env: {
				...process.env,
				KLIPPT_HEAVY_LOCK_HELD: "1",
				TMPDIR: temporary,
				GOMAXPROCS: "4",
				CARGO_BUILD_JOBS: "4",
				UV_THREADPOOL_SIZE: "4",
			},
		},
	);
	if (child.error) console.error(child.error.message);
	process.exit(child.status ?? 1);
}
